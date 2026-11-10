/* ================================================================
   multipart/form-data 解析（零依赖）

   为什么手写而不是引 busboy/formidable：
   mock 后端要求零运行时依赖，而这里只需要「取出 file 字段的字节 +
   几个文本字段」，20 行足够。

   关键点（踩过才知道）：
   - boundary 要从 Content-Type 里取，**不带**前面的 `--`；
     分隔符才是 `--<boundary>`，结束符是 `--<boundary>--`。
   - 必须按 Buffer 处理，不能先 toString('utf8') 再切 ——
     JPEG 字节里有 0x0D 0x0A 和任意高位字节，转成字符串会被改写。
   - 文件内容里理论上可能出现与 boundary 相同的字节序列，
     所以用「查找分隔符」而不是正则分割。
   ================================================================ */
/* global Buffer */

import { badRequest } from './errors.js';

/** 从 Content-Type 头里取 boundary */
export function boundaryOf(contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(String(contentType || ''));
  if (!m) return null;
  const b = (m[1] || m[2] || '').trim();
  return b || null;
}

/**
 * 解析 multipart body。
 * @param {Buffer} buf
 * @param {string} boundary
 * @returns {{fields:Record<string,string>, files:Array<{name:string,filename:string,contentType:string,data:Buffer}>}}
 */
export function parseMultipart(buf, boundary) {
  if (!boundary) throw badRequest('缺少 multipart boundary');
  const delim = Buffer.from(`--${boundary}`, 'utf8');
  const fields = {};
  const files = [];

  let pos = buf.indexOf(delim);
  if (pos < 0) throw badRequest('multipart body 缺少分隔符');

  while (pos >= 0) {
    let start = pos + delim.length;
    // 结束符：--boundary--
    if (buf.slice(start, start + 2).toString('latin1') === '--') break;
    // 跳过分隔符后的 CRLF
    if (buf[start] === 0x0d && buf[start + 1] === 0x0a) start += 2;

    const next = buf.indexOf(delim, start);
    if (next < 0) throw badRequest('multipart body 不完整');

    // part 内容到下一个分隔符前，去掉尾部 CRLF
    let end = next;
    if (buf[end - 2] === 0x0d && buf[end - 1] === 0x0a) end -= 2;
    const part = buf.slice(start, end);

    // 头/体分界：CRLFCRLF
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd < 0) throw badRequest('multipart part 缺少头部');
    const headerText = part.slice(0, headerEnd).toString('utf8');
    const data = part.slice(headerEnd + 4);

    const nameMatch = /name="([^"]*)"/i.exec(headerText);
    const filenameMatch = /filename="([^"]*)"/i.exec(headerText);
    const typeMatch = /Content-Type:\s*([^\r\n]+)/i.exec(headerText);
    const name = nameMatch ? nameMatch[1] : '';

    if (filenameMatch) {
      files.push({
        name,
        filename: filenameMatch[1],
        contentType: typeMatch ? typeMatch[1].trim().toLowerCase() : '',
        data,
      });
    } else if (name) {
      fields[name] = data.toString('utf8');
    }

    pos = next;
  }

  return { fields, files };
}

/* ---------------- 图片元信息 ---------------- */

/** 按魔数判断真实类型 —— 不信 filename 的扩展名（AC-29：.gif 要 415） */
export function sniffImageMime(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (
    buf.length >= 12 &&
    buf.slice(0, 4).toString('latin1') === 'RIFF' &&
    buf.slice(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

/** 读 PNG 尺寸（IHDR 块，固定偏移） */
function pngSize(buf) {
  if (buf.length < 24) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** 读 WebP 尺寸（VP8 / VP8L / VP8X 三种） */
function webpSize(buf) {
  if (buf.length < 30) return null;
  const chunk = buf.slice(12, 16).toString('latin1');
  if (chunk === 'VP8 ') {
    // 关键帧：帧头 3 字节 + 起始码 9d 01 2a，随后 14 位宽高
    const w = buf.readUInt16LE(26) & 0x3fff;
    const h = buf.readUInt16LE(28) & 0x3fff;
    return { width: w, height: h };
  }
  if (chunk === 'VP8L') {
    const bits = buf.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X') {
    const w = (buf[24] | (buf[25] << 8) | (buf[26] << 16)) + 1;
    const h = (buf[27] | (buf[28] << 8) | (buf[29] << 16)) + 1;
    return { width: w, height: h };
  }
  return null;
}

/** 读 JPEG 尺寸（扫描 SOFn 段）；找不到返回 null */
function jpegSize(buf) {
  let i = 2;
  while (i < buf.length - 9) {
    if (buf[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = buf[i + 1];
    // SOF0..SOF3, SOF5..SOF7, SOF9..SOF11, SOF13..SOF15
    const isSof =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc;
    const len = buf.readUInt16BE(i + 2);
    if (isSof) {
      return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
    }
    if (len < 2) return null;
    i += 2 + len;
  }
  return null;
}

/** 读图片尺寸；读不出返回 null（mock 允许 null，前端会自适应） */
export function imageSize(buf, mime) {
  if (mime === 'image/png') return pngSize(buf);
  if (mime === 'image/webp') return webpSize(buf);
  if (mime === 'image/jpeg') return jpegSize(buf);
  return null;
}
