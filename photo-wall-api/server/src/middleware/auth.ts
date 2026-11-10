/**
 * 鉴权中间件：Bearer accessToken → c.get('userId')。
 * 401 三态区分（契约 §3.3）：TOKEN_MISSING / TOKEN_INVALID / TOKEN_EXPIRED。
 */
import { createMiddleware } from 'hono/factory';
import { err } from '../lib/errors.js';
import type { AuthService } from '../services/auth.js';
import type { AppEnv } from '../types.js';

export const requireAuth = (auth: AuthService) =>
  createMiddleware<AppEnv>(async (c, next) => {
    const header = c.req.header('Authorization');
    if (!header) throw err.tokenMissing();
    const [scheme, token] = header.split(' ');
    if (!/^Bearer$/i.test(scheme ?? '') || !token) throw err.tokenMissing();
    c.set('userId', await auth.verifyAccess(token.trim()));
    await next();
  });

/** 路由里取当前用户 id（鉴权中间件保证存在） */
export const userIdOf = (c: { get: (k: 'userId') => string }): string => c.get('userId');
