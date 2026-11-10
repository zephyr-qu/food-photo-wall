/** 请求 ID：响应头回显 + 错误体里带，排障用（契约 §3.2） */
import { createMiddleware } from 'hono/factory';
import { newId } from '../lib/ids.js';
import type { AppEnv } from '../types.js';

export const requestId = () =>
  createMiddleware<AppEnv>(async (c, next) => {
    const id = c.req.header('X-Request-Id')?.trim() || newId('req');
    c.set('requestId', id);
    await next();
    c.header('X-Request-Id', id);
  });
