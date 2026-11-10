/**
 * 零依赖图片解析（PNG / JPEG / WEBP / GIF）。
 *
 * 职责有两层，别混：
 *   1. `sniffMime` —— 只看 magic bytes 判断"这是什么格式"，用于 415 判定；
 *   2. `readImageInfo` —— 真正**解析结构**并拿到宽高，用于 422 判定。
 *
 * 为什么第 2 层必须做结构校验（而不是读到偏移就返回）：
 * 以前 `pngSize()` 只 `readUInt32BE(16/20)`，任何"PNG 魔数 + 随机字节"都能
 * 通过 —— 实测 208 字节垃圾图返回 width=291307238 / height=1938908154，
 * 被当合法图片入库并永久对外提供。那种"能识别但结构坏"的文件必须被拒。
 *
 * 校验原则（不引入图像库，只保证「不是垃圾」这一档）：
 *   · PNG：必须找到完整的 IHDR 块（长度=13、类型=IHDR），且宽高非 0、有上限；
 *   · JPEG：必须走完 marker 链并读到 SOFx 段，且 SOI/EOI 齐全；
 *   · WEBP：必须 RIFF/WEBP 且 chunk 尺寸自洽；
 *   · GIF：必须有逻辑屏幕描述符 + 宽高非 0。
 * 这些检查都只读头尾，O(1)，却能挡掉绝大多数伪造与截断文件。
 *
 * ⚠ 它**不是**解码器：不做 CRC 校验、不解像素、不防解压炸弹（那是 decode 层
 * 的事）。要更强保证请换 sharp/原生库，或接微信侧审核。
 */

export interface ImageInfo {
  mime: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';
  ext: 'jpg' | 'png' | 'webp' | 'gif';
  width: number;
  height: number;
}

/** 单边像素上限：超过基本可判为伪造/炸弹，也超出任何展示需求 */
const MAX_DIMENSION = 20_000;
/** 像素总数上限（约 4 亿像素 ≈ 1.6GB RGBA，远超合理范围） */
const MAX_PIXELS = 400_000_000;

/** 通过 magic bytes 判定真实类型（不信任客户端 Content-Type） */
export function sniffMime(b: Buffer): ImageInfo['mime'] | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (
    b.length >= 8 &&
    b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  )
    return 'image/png';
  if (
    b.length >= 12 &&
    b.subarray(0, 4).toString('ascii') === 'RIFF' &&
    b.subarray(8, 12).toString('ascii') === 'WEBP'
  )
    return 'image/webp';
  if (b.length >= 6 && b.subarray(0, 3).toString('ascii') === 'GIF') return 'image/gif';
  return null;
}

/**
 * PNG：按块走一遍，要求 IHDR 是第一个块且长度=13、尺寸合理。
 * 顺带确认文件里有 IDAT（没有像素数据 = 空壳）与 IEND。
 */
function pngSize(b: Buffer): { width: number; height: number } | null {
  /* 8 字节签名 + IHDR(8 长度/类型 + 13 数据 + 4 CRC) 至少要 33 字节 */
  if (b.length < 33) return null;
  if (b.subarray(12, 16).toString('ascii') !== 'IHDR') return null;
  const ihdrLen = b.readUInt32BE(8);
  if (ihdrLen !== 13) return null;
  const width = b.readUInt32BE(16);
  const height = b.readUInt32BE(20);
  if (!width || !height) return null;

  /* 块链：从 IHDR 之后逐块走，确认 IDAT 存在且 IEND 收尾。
     只读 8 字节头 + 跳长度，不碰数据，O(块数)。 */
  let off = 8; // 跳过签名
  let sawIdat = false;
  let sawIend = false;
  let guard = 0;
  while (off + 8 <= b.length && guard++ < 10_000) {
    const len = b.readUInt32BE(off);
    const type = b.subarray(off + 4, off + 8).toString('ascii');
    const next = off + 8 + len + 4; // 长度 + 类型 + 数据 + CRC
    if (len > b.length || next > b.length + 4) return null; // 长度字段撒谎/截断
    if (type === 'IDAT') sawIdat = true;
    if (type === 'IEND') {
      sawIend = true;
      break;
    }
    if (next <= off) return null;
    off = next;
  }
  if (!sawIdat || !sawIend) return null;
  return { width, height };
}

/** GIF：逻辑屏幕描述符在固定偏移，宽高非 0 即可 */
function gifSize(b: Buffer): { width: number; height: number } | null {
  if (b.length < 13) return null;
  const sig = b.subarray(0, 6).toString('ascii');
  if (sig !== 'GIF87a' && sig !== 'GIF89a') return null;
  const width = b.readUInt16LE(6);
  const height = b.readUInt16LE(8);
  if (!width || !height) return null;
  return { width, height };
}

/**
 * JPEG：走 marker 链找 SOFx。
 *
 * 修掉两个老问题：
 *  1. 以前 `while (i + 9 < b.length)` 对**截断文件**会安静返回 null 是对的，
 *     但没有校验 SOI/EOI，一段 `FFD8FF` + SOF 伪造也能过；
 *  2. 段长度 `len < 2` 时以前直接 null（正确），但要保证 i 单调前进不死循环。
 */
function jpegSize(b: Buffer): { width: number; height: number } | null {
  if (b.length < 4) return null;
  if (b[0] !== 0xff || b[1] !== 0xd8) return null; // SOI
  /* EOI 是文件尾两字节 FFD9；允许后面有少量尾随字节（EXIF 写坏很常见） */
  if (b[b.length - 2] !== 0xff || b[b.length - 1] !== 0xd9) {
    /* 有些相机在 EOI 后补 padding，向前找 16 字节内的 FFD9 */
    let found = false;
    for (let k = b.length - 2; k >= Math.max(2, b.length - 16); k--) {
      if (b[k] === 0xff && b[k + 1] === 0xd9) {
        found = true;
        break;
      }
    }
    if (!found) return null;
  }

  let i = 2;
  let guard = 0;
  while (i + 9 <= b.length && guard++ < 100_000) {
    if (b[i] !== 0xff) {
      return null; // marker 必须是 0xFF 开头；不对就是坏文件
    }
    /* 连续 0xFF 是填充，跳过 */
    let marker = b[i + 1];
    while (marker === 0xff) {
      i += 1;
      if (i + 1 >= b.length) return null;
      marker = b[i + 1];
    }
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    if (marker === 0x01 || marker === 0x00) {
      i += 2;
      continue;
    }
    const len = b.readUInt16BE(i + 2);
    if (len < 2) return null;
    /* SOF0..SOF15，排除 DHT(C4)/JPG(C8)/DAC(CC) */
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = b.readUInt16BE(i + 5);
      const width = b.readUInt16BE(i + 7);
      if (!width || !height) return null;
      return { width, height };
    }
    const next = i + 2 + len;
    if (next <= i) return null;
    i = next;
  }
  return null;
}

/** WEBP：RIFF 头 + chunk 尺寸自洽 + 三个子格式各自的尺寸位置 */
function webpSize(b: Buffer): { width: number; height: number } | null {
  if (b.length < 30) return null;
  const riffSize = b.readUInt32LE(4);
  /* RIFF 声明的大小应 ≈ 文件长度 - 8；允许 ±16 容差（有的编码器算上 padding） */
  if (riffSize + 8 > b.length + 16) return null;
  const fourcc = b.subarray(12, 16).toString('ascii');
  const chunkSize = b.readUInt32LE(16);
  if (chunkSize + 20 > b.length + 16) return null;

  if (fourcc === 'VP8X') {
    if (b.length < 30) return null;
    const w = 1 + (b[24] | (b[25] << 8) | (b[26] << 16));
    const h = 1 + (b[27] | (b[28] << 8) | (b[29] << 16));
    if (!w || !h) return null;
    return { width: w, height: h };
  }
  if (fourcc === 'VP8 ') {
    /* 帧标签 3 字节 + 同步码 0x9d 0x01 0x2a，随后 2×14bit 尺寸 */
    const off = 26;
    if (b.length < off + 4) return null;
    if (b[off + 3] !== 0x9d || b[off + 4] !== 0x01 || b[off + 5] !== 0x2a) return null;
    const width = b.readUInt16LE(off) & 0x3fff;
    const height = b.readUInt16LE(off + 2) & 0x3fff;
    if (!width || !height) return null;
    return { width, height };
  }
  if (fourcc === 'VP8L') {
    const off = 21;
    if (b.length < off + 5) return null;
    if (b[off] !== 0x2f) return null; // VP8L 签名
    const bits = b.readUInt32LE(off + 1);
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >> 14) & 0x3fff) + 1;
    if (!width || !height) return null;
    return { width, height };
  }
  return null;
}

/**
 * 尺寸合理性：0 或超上限都判为无效。
 * 写成**类型守卫**（`size is {...}`）是为了让 readImageInfo 里能自动收窄，
 * 不必再写一遍 non-null 断言。
 */
function sane(
  size: { width: number; height: number } | null,
): size is { width: number; height: number } {
  if (!size) return false;
  const { width, height } = size;
  if (width <= 0 || height <= 0) return false;
  if (width > MAX_DIMENSION || height > MAX_DIMENSION) return false;
  if (width * height > MAX_PIXELS) return false;
  return true;
}

/**
 * 解析图片信息。**只有结构真实可信时才返回非 null** ——
 * 返回 null 表示"这不是一张能用的图片"，调用方应回 422。
 */
export function readImageInfo(buf: Buffer): ImageInfo | null {
  const mime = sniffMime(buf);
  if (!mime) return null;
  const size =
    mime === 'image/png'
      ? pngSize(buf)
      : mime === 'image/jpeg'
        ? jpegSize(buf)
        : mime === 'image/gif'
          ? gifSize(buf)
          : webpSize(buf);
  if (!sane(size)) return null;
  const ext = mime === 'image/jpeg' ? 'jpg' : (mime.split('/')[1] as ImageInfo['ext']);
  return { mime, ext, width: size.width, height: size.height };
}
