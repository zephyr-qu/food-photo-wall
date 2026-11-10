/** 店铺路由（§6.4）：/shops/by-name 必须先于 /shops/:shopId 注册 */
import { Hono } from 'hono';
import { parseQuery } from '../lib/validate.js';
import { shopByNameQuerySchema, shopDetailQuerySchema } from '../schemas.js';
import type { AppEnv, Services } from '../types.js';

export function shopsRoutes(s: Services): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  const uid = (c: { get: (k: 'userId') => string }) => c.get('userId');

  // 过渡兼容：前端路由是 /pages/shop/index?name=<店名>
  r.get('/by-name', (c) => {
    const q = parseQuery(c, shopByNameQuerySchema);
    return c.json(
      s.shops.getByName(uid(c), q.name, q.city, { limit: q.limit, cursor: q.cursor }),
    );
  });

  r.get('/:shopId', (c) => {
    const q = parseQuery(c, shopDetailQuerySchema);
    return c.json(s.shops.getById(uid(c), c.req.param('shopId'), { limit: q.limit, cursor: q.cursor }));
  });

  return r;
}
