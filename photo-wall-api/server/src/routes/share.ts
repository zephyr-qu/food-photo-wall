/**
 * 分享读接口（**免鉴权**，契约 §11 #10）。
 *
 * 用途：小程序转发出去的卡片，对方（可能没登录过、甚至是 H5 外部浏览器）
 * 点开后要能看到那一条。所以这条路由不能挂在 `secure()` 里。
 *
 * 安全模型（为什么不是"按 id 直接公开读"）：
 *   · 记录 id 是不可枚举的 ULID，但**不可枚举 ≠ 不公开**：一旦某条链接
 *     被贴到群里，任何人都能读，且无法收回；
 *   · 所以要求 `?token=`，值与记录上的 `shareToken` 严格相等才返回。
 *     用户不点「分享」就没有 token，链接根本不存在；点「撤销分享」即刻失效；
 *   · 不匹配时**不区分**"记录不存在"与"token 错"，统一 404，避免被用来
 *     探测某条记录是否存在。
 *
 * 刻意只读：分享落地页不能改、不能删 —— 写操作仍然需要登录态。
 */
import { Hono } from 'hono';
import type { AppEnv, Services } from '../types.js';

export function shareRoutes(s: Services): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  r.get('/records/:id', (c) => {
    const token = (c.req.query('token') ?? '').trim();
    if (!token) {
      /* 缺 token 与 token 错用同一个响应：不给出"这里确实有东西"的信号 */
      return c.json(
        { error: { code: 'NOT_FOUND', message: '这一条已经不在了', requestId: c.get('requestId') } },
        404,
      );
    }
    const record = s.records.readShared(c.req.param('id'), token);
    /* 分享内容会随记录编辑变化，不要让 CDN/浏览器缓存住旧版本 */
    c.header('Cache-Control', 'no-store');
    return c.json({ record, shared: true });
  });

  return r;
}
