/** 认证路由（§6.1）：/auth/wechat/login、/auth/anonymous、/auth/refresh */
import { Hono } from 'hono';
import { parseBody } from '../lib/validate.js';
import { parseTzOffset } from '../lib/time.js';
import { anonymousLoginSchema, refreshSchema, wechatLoginSchema } from '../schemas.js';
import type { AppEnv, Services } from '../types.js';

export function authRoutes(s: Services): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  /**
   * 取客户端的时区偏移。
   *
   * 为什么要给登录接口也带上它：种子数据（示例记录）在**创建用户那一刻**
   * 就落库了，它的 `tzOffset` 与日期归属必须用**用户自己的**时区 ——
   * 否则非东八区的用户看到的是「按东八区算的今天/这个月」。
   *
   * ⚠ 这里**不**因为格式非法就 400：登录失败不该因为一个头而失败。
   * 解析不出来就返回 undefined，服务端会回落默认偏移。
   */
  const clientTz = (c: { req: { header: (n: string) => string | undefined } }): string | undefined => {
    const raw = c.req.header('X-Timezone-Offset')?.trim();
    if (!raw) return undefined;
    return parseTzOffset(raw) === null ? undefined : raw;
  };

  // 小程序静默登录：code 换 token（不弹授权窗）
  r.post('/wechat/login', async (c) => {
    const body = await parseBody(c, wechatLoginSchema);
    return c.json(await s.auth.wechatLogin(body.code, clientTz(c)), 200);
  });

  // H5 / 开发环境匿名登录：同一 deviceId 幂等返回同一账号
  r.post('/anonymous', async (c) => {
    const body = await parseBody(c, anonymousLoginSchema);
    return c.json(await s.auth.anonymousLogin(body.deviceId, clientTz(c)), 200);
  });

  // 刷新令牌（refreshToken 轮换，旧的一次性作废）
  r.post('/refresh', async (c) => {
    const body = await parseBody(c, refreshSchema);
    return c.json(await s.auth.refresh(body.refreshToken), 200);
  });

  return r;
}
