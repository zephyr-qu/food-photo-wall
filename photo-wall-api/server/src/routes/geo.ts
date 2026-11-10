/** 城市字典（§6.6）：公开、可缓存、支持 If-None-Match → 304 */
import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { CITY_PROVINCE, GEO_UPDATED_AT, GEO_VERSION } from '../data/geo-cities.js';
import { compareCodePoint } from '../lib/sort.js';
import type { AppEnv, Services } from '../types.js';

// 省/市均按码点序（对齐前端 provinceCatalogue()，不依赖 ICU）
const catalogue = [...new Set(Object.values(CITY_PROVINCE))]
  .sort(compareCodePoint)
  .map((province) => ({
    province,
    cities: Object.entries(CITY_PROVINCE)
      .filter(([, p]) => p === province)
      .map(([city]) => city)
      .sort(compareCodePoint),
  }));

const BODY = JSON.stringify({
  version: GEO_VERSION,
  updatedAt: GEO_UPDATED_AT,
  provinces: catalogue,
});
const ETAG = `"geo-${createHash('sha1').update(BODY).digest('hex').slice(0, 16)}"`;

export function geoRoutes(_s: Services): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  r.get('/cities', (c) => {
    c.header('ETag', ETAG);
    c.header('Cache-Control', 'public, max-age=86400');
    if (c.req.header('If-None-Match') === ETAG) return c.body(null, 304);
    return c.body(BODY, 200, { 'Content-Type': 'application/json; charset=utf-8' });
  });

  return r;
}
