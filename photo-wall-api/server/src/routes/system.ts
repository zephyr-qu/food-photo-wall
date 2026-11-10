/** 运维与静态资源：/healthz、/openapi.yaml、/docs、/files/:name */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Hono, type Context } from 'hono';
import { err } from '../lib/errors.js';
import { resolvePresetAssetDir } from '../lib/preset-assets.js';
import { formatUtcIso, nowMs } from '../lib/time.js';
import type { AppEnv, Services } from '../types.js';

/** openapi.yaml 可能位于源码目录或构建产物目录，按候选依次尝试 */
function openapiCandidates(): string[] {
  return [
    new URL('../../../docs/api/openapi.yaml', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
    new URL('../../../../docs/api/openapi.yaml', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
    resolve(process.cwd(), '../docs/api/openapi.yaml'),
    resolve(process.cwd(), 'docs/api/openapi.yaml'),
  ];
}

/**
 * 允许的静态文件名：扁平名（不含 `/`、`\`、`..`），字母数字下划线连字符 + 单个扩展名。
 * 上传文件是 `pho_<id>.<ext>`，预置图是 `kaoya.jpg` / `share-cover.jpg`，两者都落在这里。
 */
const NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}\.(jpe?g|png|webp|gif)$/;
const MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
};

/**
 * `/files/*` 的实际读取，两处来源依次回退：
 *   1. storageDir 里的上传文件（本实现用同一文件充当 url/photo/photoThumb）
 *   2. 预置图目录（`TARO_APP_ASSET_BASE` 指向本服务时，前端要 12 张预置菜品图 + 2 张分享封面）
 * 生产按契约 §6.5.1 换成对象存储 + CDN 后这两条路自然退出。
 */
async function serveFile(
  c: Context<AppEnv>,
  name: string,
  storageDir: string,
  presetDir: string | null,
): Promise<Response> {
  const m = NAME_RE.exec(name);
  if (!m) throw err.notFound('文件不存在');
  const mime = MIME[m[1].toLowerCase()];
  const dirs = presetDir ? [storageDir, presetDir] : [storageDir];
  for (const dir of dirs) {
    try {
      const buf = await readFile(resolve(dir, name));
      c.header('Cache-Control', 'public, max-age=31536000, immutable');
      return c.body(new Uint8Array(buf), 200, { 'Content-Type': mime });
    } catch {
      /* 换下一个目录 */
    }
  }
  throw err.notFound('文件不存在');
}

export function systemRoutes(s: Services): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  r.get('/healthz', (c) => c.json({ status: 'ok', version: s.cfg.version, time: formatUtcIso(nowMs()) }));

  r.get('/openapi.yaml', async (c) => {
    for (const candidate of openapiCandidates()) {
      try {
        const text = await readFile(candidate, 'utf8');
        return c.body(text, 200, { 'Content-Type': 'application/yaml; charset=utf-8' });
      } catch {
        /* 换下一个候选 */
      }
    }
    throw err.notFound('openapi.yaml 未找到（docs/api/openapi.yaml）');
  });

  r.get('/docs', (c) => c.html(SWAGGER_HTML));

  /* 预置图目录在启动时定一次：每次请求都去探测目录是白花钱 */
  const presetDir = resolvePresetAssetDir();

  /* 照片静态资源（本实现用同一文件充当 url/photo/photoThumb；生产换 CDN）。
     同时挂两种形态：`/files/kaoya.jpg`（前端 resolveAssetUrl 剥前缀后的扁平名）
     与 `/files/static/img/kaoya.jpg`（mock 里也成立的带前缀形态）。 */
  r.get('/files/:name', (c) => serveFile(c, c.req.param('name'), s.cfg.storageDir, presetDir));
  r.get('/files/static/img/:name', (c) =>
    serveFile(c, c.req.param('name'), s.cfg.storageDir, presetDir),
  );

  return r;
}

const SWAGGER_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>照片墙 API · OpenAPI</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
  <style>body{margin:0}#swagger-ui{max-width:1100px;margin:0 auto}</style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js" crossorigin></script>
  <script>
    window.ui = SwaggerUIBundle({ url: '/v1/openapi.yaml', dom_id: '#swagger-ui', deepLinking: true });
  </script>
</body>
</html>`;
