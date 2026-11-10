/** 测试基础设施：每个用例一套干净内存库 + 少量请求助手 */
import zlib from 'node:zlib';
import { createApp, type AppBundle, type CreateAppOptions } from '../src/app.js';

export interface TestBundle extends AppBundle {}

const TEST_CONFIG = {
  storageDir: 'var/test-uploads',
  publicBaseUrl: 'http://localhost:8787',
  rateLimit: {
    enabled: false,
    defaultPerMin: 1000,
    photoPerMin: 1000,
    authPerMin: 1000,
  },
  seedDemoRecords: false,
  strictWechatCodes: false,
} satisfies NonNullable<CreateAppOptions['config']>;

export async function makeApp(overrides: NonNullable<CreateAppOptions['config']> = {}): Promise<TestBundle> {
  return createApp({
    persist: false,
    config: {
      ...TEST_CONFIG,
      ...overrides,
      rateLimit: { ...TEST_CONFIG.rateLimit, ...overrides.rateLimit },
    },
  });
}

export type RawBody = FormData | Blob | string | Uint8Array | URLSearchParams;

export interface Res<T = any> {
  status: number;
  body: T;
  headers: Headers;
  text: string;
}

export async function call<T = any>(
  app: AppBundle['app'],
  path: string,
  opts: { method?: string; token?: string; body?: unknown; headers?: Record<string, string>; raw?: RawBody } = {},
): Promise<Res<T>> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  let body: RawBody | undefined = opts.raw;
  if (opts.body !== undefined) {
    headers['Content-Type'] = headers['Content-Type'] ?? 'application/json';
    body = JSON.stringify(opts.body);
  }
  const res = await app.request(path, { method: opts.method ?? 'GET', headers, body: body as never });
  const text = await res.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  return { status: res.status, body: parsed as T, headers: res.headers, text };
}

/** 匿名登录拿 token（H5 路径，测试最稳） */
export async function login(app: AppBundle['app'], deviceId = 'dev-test'): Promise<string> {
  const res = await call(app, '/v1/auth/anonymous', { method: 'POST', body: { deviceId } });
  if (res.status !== 200) throw new Error(`登录失败 ${res.status} ${res.text}`);
  return res.body.accessToken as string;
}

/** 建一条记录，返回 Record 响应 */
export async function addRecord(
  app: AppBundle['app'],
  token: string,
  body: Record<string, unknown> = {},
): Promise<any> {
  const res = await call(app, '/v1/records', {
    method: 'POST',
    token,
    body: { eat: '甜水面', ...body },
  });
  if (res.status !== 201) throw new Error(`建记录失败 ${res.status} ${res.text}`);
  return res.body;
}

/**
 * 结构**完整**的最小 PNG（含 IHDR + IDAT + IEND，CRC 用真实 zlib 计算）。
 *
 * 为什么不能再用 24 字节的「魔数 + IHDR 头」糊弄：
 * `lib/image.ts` 现在会走块链，要求 IHDR 长度=13、存在 IDAT、以 IEND 收尾。
 * 那种半截文件正是要拒绝的对象（实测曾把 208 字节垃圾图当合法图入库）。
 * 测试夹具必须是真图，否则测的是"拒绝"而不是"上传成功"。
 */
export function tinyPng(width = 4, height = 3): Buffer {
  const crcTable: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const crc32 = (buf: Buffer): number => {
    let c = 0xffffffff;
    for (const byte of buf) c = (crcTable[(c ^ byte) & 0xff] as number) ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'ascii');
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
    return Buffer.concat([len, typeBuf, data, crcBuf]);
  };

  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor

  /* 每行前 1 字节 filter(0) + width*3 字节 RGB */
  const raw = Buffer.alloc(height * (1 + width * 3));
  /* zlib 压缩（PNG 的 IDAT 必须是 zlib 流） */
  const idat = zlib.deflateSync(raw);

  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

/** 半截假图：只有 PNG 魔数 + IHDR 头，没有 IDAT/IEND —— 必须被拒绝 */
export function truncatedPng(width = 4, height = 3): Buffer {
  const b = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

/**
 * 结构**完全合法**、但体积 >1MB 的 PNG。
 *
 * 用途：验证「内容审核的 1MB 上限」这条分支。
 *
 * 为什么不能拿 `tinyPng` 后面补零凑大小：那样 `pngSize()` 的块链校验会失败
 * （IEND 之后的数据让它走到"长度字段撒谎"分支），请求会在**图片结构校验**
 * 那一步就以"无法解析"被拒 —— 看起来也是 422，但**测的根本不是大小限制**。
 * 这个坑我踩过：断言用正则宽松匹配「压缩」二字，结果两条不同的拒绝原因
 * 被混为一谈。
 *
 * 做法：IHDR 之后放一个**超大但合法**的 IDAT（zlib 流，内容是全零，
 * deflate 压不动，所以体积真实膨胀），再收尾 IEND。
 */
export function oversizedPng(targetBytes = 1024 * 1024 + 64 * 1024): Buffer {
  const crcTable: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const crc32 = (buf: Buffer): number => {
    let c = 0xffffffff;
    for (const byte of buf) c = (crcTable[(c ^ byte) & 0xff] as number) ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'ascii');
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
    return Buffer.concat([len, typeBuf, data, crcBuf]);
  };

  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(4, 0);
  ihdr.writeUInt32BE(3, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;

  /* 用不可压缩的数据（伪随机）让 deflate 也压不小，确保真超 1MB */
  const rawSize = targetBytes;
  const raw = Buffer.alloc(rawSize);
  let x = 123456789;
  for (let i = 0; i < rawSize; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    raw[i] = x & 0xff;
  }
  /* 每行首字节约为 0（filter=none）不是必须的：pngSize 不校验图像数据内容，
     只要求 IDAT 存在、块长度自洽。 */
  const idat = zlib.deflateSync(raw, { level: 0 }); // level 0 = 不压缩，体积确定

  const out = Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  return out;
}


/** PNG 魔数 + 随机字节：曾经能骗过校验的那类垃圾，必须被拒绝 */
export function garbagePng(bytes = 200): Buffer {
  const rnd = Buffer.alloc(bytes);
  for (let i = 0; i < bytes; i++) rnd[i] = (i * 37 + 11) & 0xff;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), rnd]);
}

export function formWithFile(buf: Buffer, filename = 'a.png', type = 'image/png'): FormData {
  const fd = new FormData();
  fd.append('file', new Blob([new Uint8Array(buf)], { type }), filename);
  return fd;
}
