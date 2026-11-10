/** GET /me（§6.1.4） */
import { Hono } from 'hono';
import type { AppEnv, Services } from '../types.js';

export function usersRoutes(s: Services): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.get('/', (c) => c.json(s.users.me(c.get('userId'))));
  return r;
}
