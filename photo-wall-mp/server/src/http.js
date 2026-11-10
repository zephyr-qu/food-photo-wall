/* ================================================================
   极简 HTTP 框架：路由 + 请求解析 + 统一错误 + CORS

   为什么不用 Express/Hono：契约要求 mock 后端零运行时依赖，
   而这里只需要「路径匹配 + JSON 解析 + 错误体统一」，
   node:http 足够，且启动快、无版本冲突。

   路由注册顺序很重要（§5 警示）：
   /records/random、/records/cities、/records/months 必须**先于**
   /records/{id} 注册，否则 "random" 会被当成 id。
   本文件的 `defineRoutes()` 就是按这个顺序写的。
   ================================================================ */
/* global Buffer, URL, process, console */

import { ApiError, errorBody } from './errors.js';
import { findAccessToken } from './store.js';
import { newId } from './ids.js';

const JSON_LIMIT = 1024 * 1024; // 1 MiB
export const MAX_BODY = 12 * 1024 * 1024; // 12 MiB（10 MiB 文件 + multipart 余量）

/** 路由表：{ method, segments, handler, auth } */
export function createRouter() {
  const routes = [];
  return {
    get: (pattern, handler, opts) => add('GET', pattern, handler, opts),
    post: (pattern, handler, opts) => add('POST', pattern, handler, opts),
    patch: (pattern, handler, opts) => add('PATCH', pattern, handler, opts),
    delete: (pattern, handler, opts) => add('DELETE', pattern, handler, opts),
    match(method, pathname) {
      for (const r of routes) {
        if (r.method !== method) continue;
        const params = matchSegments(r.segments, pathname);
        if (params) return { route: r, params };
      }
      return null;
    },
  };

  function add(method, pattern, handler, opts = {}) {
    routes.push({ method, segments: pattern.split('/').filter(Boolean), handler, auth: !!opts.auth });
  }
}

function matchSegments(segments, pathname) {
  const parts = pathname.split('/').filter(Boolean);
  if (parts.length !== segments.length) return null;
  const params = {};
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg.startsWith(':')) {
      params[seg.slice(1)] = decodeURIComponent(parts[i]);
    } else if (seg !== parts[i]) {
      return null;
    }
  }
  return params;
}

/* ---------------- 请求体 ---------------- */

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let overflow = false;
    req.on('data', (chunk) => {
      if (overflow) return; // 已判定超限：继续排空，别让客户端写不完
      size += chunk.length;
      if (size > limit) {
        overflow = true;
        // 不能 destroy：destroy 会掐断 socket，响应就发不出去，
        // 客户端只会看到 ECONNRESET 而不是 413。
        reject(new ApiError('FILE_TOO_LARGE', '请求体过大'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!overflow) resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const buf = await readBody(req, JSON_LIMIT);
  if (!buf.length) return {};
  let parsed;
  try {
    parsed = JSON.parse(buf.toString('utf8'));
  } catch {
    throw new ApiError('BAD_REQUEST', 'JSON 解析失败');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ApiError('BAD_REQUEST', '请求体必须是 JSON 对象');
  }
  return parsed;
}

/* ---------------- 响应 ---------------- */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
  'Access-Control-Allow-Headers':
    'Authorization,Content-Type,Idempotency-Key,If-Match,X-Client-Version,X-Request-Id,X-Timezone-Offset,X-Mock-Reject-Image',
  'Access-Control-Expose-Headers': 'X-Request-Id,Idempotent-Replayed,ETag,Retry-After',
  'Access-Control-Max-Age': '86400',
};

function send(res, status, headers, body) {
  res.writeHead(status, { ...CORS_HEADERS, ...headers });
  if (body === undefined || body === null) res.end();
  else res.end(body);
}

function sendJson(res, status, payload, headers = {}) {
  const text = JSON.stringify(payload);
  send(res, status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    ...headers,
  }, text);
}

/* ---------------- 应用 ---------------- */

/**
 * @param {{router:object, rateLimitPerMin?:number, prefix?:string}} opts
 */
export function createApp({ router, rateLimitPerMin = 0, prefix = '/v1' }) {
  const rateBuckets = new Map(); // key -> { count, windowStart }

  function checkRateLimit(key) {
    if (!rateLimitPerMin) return null;
    const now = Date.now();
    const windowMs = 60_000;
    let b = rateBuckets.get(key);
    if (!b || now - b.windowStart >= windowMs) {
      b = { count: 0, windowStart: now };
      rateBuckets.set(key, b);
    }
    b.count += 1;
    if (b.count > rateLimitPerMin) {
      const retryAfter = Math.max(1, Math.ceil((b.windowStart + windowMs - now) / 1000));
      throw new ApiError('RATE_LIMITED', '请求过于频繁，请稍后再试', {
        headers: { 'Retry-After': String(retryAfter) },
      });
    }
    return null;
  }

  return async function handle(req, res) {
    const requestId = req.headers['x-request-id'] || newId('req');
    const started = Date.now();
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;

    // CORS 预检：H5 联调必须过（浏览器不会带 Authorization 发 OPTIONS）
    if (req.method === 'OPTIONS') {
      send(res, 204, { 'X-Request-Id': requestId }, null);
      return;
    }

    // 业务接口统一挂 /v1；/healthz 留在根路径（运维探活习惯）
    const routePath = pathname.startsWith(prefix) ? pathname.slice(prefix.length) || '/' : pathname;

    try {
      const matched = router.match(req.method, routePath);
      if (!matched) {
        // 路径存在但方法不对，也统一 404（不暴露路由表）
        throw new ApiError('NOT_FOUND', `接口不存在: ${req.method} ${pathname}`);
      }

      const { route, params } = matched;
      let userId = null;
      if (route.auth) {
        const auth = req.headers.authorization || '';
        const m = /^Bearer\s+(.+)$/i.exec(auth);
        if (!m) throw new ApiError('TOKEN_MISSING', '缺少 Authorization 头');
        const token = m[1].trim();
        const rec = findAccessToken(token);
        if (!rec) throw new ApiError('TOKEN_INVALID', 'token 无效');
        if (rec.expiresAt <= Date.now()) throw new ApiError('TOKEN_EXPIRED', 'token 已过期');
        userId = rec.userId;
        checkRateLimit(userId);
      } else {
        checkRateLimit(req.socket.remoteAddress || 'anon');
      }

      const ctx = {
        req,
        res,
        requestId,
        params,
        query: url.searchParams,
        userId,
        body: () => readJsonBody(req),
        rawBody: () => readBody(req, MAX_BODY),
        json: (status, payload, headers) => sendJson(res, status, payload, { 'X-Request-Id': requestId, ...headers }),
        noContent: (headers) => send(res, 204, { 'X-Request-Id': requestId, ...headers }, null),
        raw: (status, buf, contentType, headers) =>
          send(res, status, {
            'Content-Type': contentType,
            'Content-Length': buf.length,
            'X-Request-Id': requestId,
            ...headers,
          }, buf),
        log: () => {
          const ms = Date.now() - started;
          if (process.env.MOCK_QUIET !== '1') {
            console.log(`${req.method} ${pathname} ${res.statusCode} ${ms}ms${userId ? ` u=${userId}` : ''}`);
          }
        },
      };

      await route.handler(ctx);
      ctx.log();
    } catch (err) {
      const apiErr =
        err instanceof ApiError
          ? err
          : new ApiError('INTERNAL_ERROR', '服务端异常', {});
      if (!(err instanceof ApiError)) {
        console.error(`[${requestId}] 未捕获异常:`, err);
      }
      sendJson(res, apiErr.status, errorBody(apiErr, requestId), {
        'X-Request-Id': requestId,
        'Cache-Control': 'no-store',
        // 413 时请求体可能还没读完：声明 close，避免复用一条脏连接
        ...(apiErr.status === 413 ? { Connection: 'close' } : {}),
        ...(apiErr.headers || {}),
      });
      if (process.env.MOCK_QUIET !== '1') {
        console.log(`${req.method} ${pathname} ${apiErr.status} ${apiErr.code}`);
      }
    }
  };
}
