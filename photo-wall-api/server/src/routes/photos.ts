/** 照片路由（§6.5）：multipart 上传 + 删除 */
import { Hono } from 'hono';
import { err } from '../lib/errors.js';
import type { AppEnv, Services } from '../types.js';

export function photosRoutes(s: Services): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  const uid = (c: { get: (k: 'userId') => string }) => c.get('userId');

  r.post('/', async (c) => {
    let body: Record<string, unknown>;
    try {
      body = (await c.req.parseBody()) as Record<string, unknown>;
    } catch {
      throw err.badRequest('请求必须是 multipart/form-data');
    }
    const file = body.file;
    if (!(file instanceof File)) throw err.validation({ file: '缺少 file 字段' });
    return c.json(await s.photos.upload(uid(c), file), 201);
  });

  r.delete('/:photoId', (c) => {
    s.photos.remove(uid(c), c.req.param('photoId'));
    return c.body(null, 204);
  });

  return r;
}
