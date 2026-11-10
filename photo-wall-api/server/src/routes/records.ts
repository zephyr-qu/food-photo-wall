/**
 * 记录路由（§6.2 / §6.3）。
 * ⚠ 注册顺序：/random、/cities、/months 必须在 /:id 之前，否则会被当成 id。
 */
import { Hono } from 'hono';
import { parseBody, parseQuery } from '../lib/validate.js';
import { createRecordSchema, listQuerySchema, monthsQuerySchema, patchRecordSchema, randomQuerySchema } from '../schemas.js';
import type { AppEnv, Services } from '../types.js';

export function recordsRoutes(s: Services): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  const uid = (c: { get: (k: 'userId') => string }) => c.get('userId');

  // ---- 固定路径段（先注册）----

  r.get('/random', (c) => {
    const q = parseQuery(c, randomQuerySchema);
    const record = s.records.random(uid(c), q);
    c.header('Cache-Control', 'no-store'); // 随机必须每次重算
    return c.json({ record });
  });

  r.get('/cities', (c) => c.json(s.aggregates.cities(uid(c))));

  r.get('/months', (c) => {
    const q = parseQuery(c, monthsQuerySchema);
    return c.json(s.aggregates.months(uid(c), q));
  });

  // ---- 集合 ----

  r.get('/', (c) => {
    const q = parseQuery(c, listQuerySchema);
    return c.json(s.records.list(uid(c), q));
  });

  r.post('/', async (c) => {
    const body = await parseBody(c, createRecordSchema);
    const idempotencyKey = c.req.header('Idempotency-Key')?.trim() || undefined;
    const timezoneHeader = c.req.header('X-Timezone-Offset')?.trim() || undefined;
    const { dto, replayed } = s.records.create(uid(c), body, { idempotencyKey, timezoneHeader });
    if (replayed) c.header('Idempotent-Replayed', 'true');
    return c.json(dto, 201);
  });

  // ---- 单条（后注册）----

  r.get('/:id', (c) => c.json(s.records.get(uid(c), c.req.param('id'))));

  r.patch('/:id', async (c) => {
    const body = await parseBody(c, patchRecordSchema);
    const ifMatch = c.req.header('If-Match')?.trim();
    return c.json(s.records.patch(uid(c), c.req.param('id'), body, ifMatch));
  });

  r.delete('/:id', (c) => {
    s.records.remove(uid(c), c.req.param('id'));
    return c.body(null, 204);
  });

  r.post('/:id/restore', (c) => c.json(s.records.restore(uid(c), c.req.param('id'))));

  /* 分享开关（需鉴权，契约 §11 #10）：
     POST   /records/{id}/share   → 生成/复用 shareToken（幂等）
     DELETE /records/{id}/share   → 撤销，旧链接立即失效 */
  r.post('/:id/share', (c) => c.json(s.records.share(uid(c), c.req.param('id'))));
  r.delete('/:id/share', (c) => {
    s.records.unshare(uid(c), c.req.param('id'));
    return c.body(null, 204);
  });

  return r;
}
