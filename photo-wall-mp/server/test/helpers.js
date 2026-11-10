/* ================================================================
   测试辅助：起一个真实 HTTP 服务 + 便捷请求封装

   每个 test 文件在 before() 里起服务、after() 里关掉，
   每个用例之间调 resetStore() —— 内存 store 是模块级单例，
   不重置就会互相污染（例如「翻页不重不漏」被前一条新建记录打乱）。
   ================================================================ */
/* global Buffer, fetch */

import { startServer } from '../src/index.js';
import {
  resetStore,
  setSeedNewUsers,
  setDemoSeeds,
  seedRecordCount,
  SEED_REAL_COUNT,
  SEED_DEMO_COUNT,
} from '../src/store.js';

export const DEV_TOKEN = 'dev-access-token';

/** 透传 store 的播种开关（测试用例可显式关掉，验证空数据态） */
export { setSeedNewUsers, setDemoSeeds };

/** 种子条数：断言里别硬编码 12 —— 演示数据开/关会改变它 */
export { seedRecordCount, SEED_REAL_COUNT, SEED_DEMO_COUNT };

export async function withServer() {
  const { server, url } = await startServer({ port: 0, host: '127.0.0.1' });
  return {
    url,
    server,
    close: () => new Promise((r) => server.close(r)),
  };
}

/** 带默认鉴权的请求封装；返回 { status, headers, body, text } */
export function api(baseUrl) {
  return async function request(method, path, { token = DEV_TOKEN, body, headers = {}, raw } = {}) {
    const h = { ...headers };
    if (token !== null) h.Authorization = `Bearer ${token}`;
    let payload;
    if (raw !== undefined) {
      payload = raw;
    } else if (body !== undefined) {
      h['Content-Type'] = h['Content-Type'] || 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(`${baseUrl}${path}`, { method, headers: h, body: payload });
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: res.status, headers: res.headers, body: json, text };
  };
}

/** 登录一个全新用户，返回 token（用于隔离测试） */
export async function loginFresh(baseUrl, code) {
  const res = await fetch(`${baseUrl}/v1/auth/wechat/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  const json = await res.json();
  if (!json.accessToken) throw new Error(`登录失败: ${JSON.stringify(json)}`);
  return { token: json.accessToken, userId: json.userId, refreshToken: json.refreshToken };
}

/** 造一条记录，返回创建结果 */
export async function createRecord(baseUrl, token, input) {
  const res = await fetch(`${baseUrl}/v1/records`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(input),
  });
  const json = await res.json();
  return { status: res.status, body: json };
}

export { resetStore };

/** 生成一张最小的合法 JPEG（1x1 灰点），用于上传测试 */
export function tinyJpeg() {
  return Buffer.from(
    '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
      'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIy' +
      'MjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAED' +
      'ASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUF' +
      'BAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0' +
      'NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKj' +
      'pKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QA' +
      'HwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEE' +
      'BSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZH' +
      'SElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0' +
      'tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3' +
      '+iiigD//2Q==',
    'base64',
  );
}

/** 生成一张 PNG 头（仅用于类型/尺寸嗅探测试） */
export function tinyPng(width = 2, height = 3) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 'latin1');
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr[16] = 8; // bit depth
  ihdr[17] = 6; // color type RGBA
  return Buffer.concat([sig, ihdr, Buffer.alloc(32)]);
}

/** 构造 multipart body */
export function multipartBody(fileBuffer, { filename = 'a.jpg', fieldName = 'file', contentType = 'image/jpeg', extraFields = {} } = {}) {
  const boundary = '----mockboundary' + Math.random().toString(16).slice(2);
  const parts = [];
  for (const [k, v] of Object.entries(extraFields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
    ),
  );
  parts.push(fileBuffer);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return { boundary, body: Buffer.concat(parts) };
}

export async function uploadPhoto(baseUrl, token, fileBuffer, opts = {}) {
  const { boundary, body } = multipartBody(fileBuffer, opts);
  const res = await fetch(`${baseUrl}/v1/photos`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      ...(opts.headers || {}),
    },
    body,
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, body: json, headers: res.headers };
}
