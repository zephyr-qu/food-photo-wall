/** GET /stats（§6.3.3）：墙统计六行数字，默认全量口径 */
import { Hono } from 'hono';
import { parseQuery } from '../lib/validate.js';
import { statsQuerySchema } from '../schemas.js';
import type { AppEnv, Services } from '../types.js';

export function statsRoutes(s: Services): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.get('/', (c) => c.json(s.aggregates.stats(c.get('userId'), parseQuery(c, statsQuerySchema))));
  return r;
}
