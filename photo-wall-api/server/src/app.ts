/**
 * Hono 应用装配：中间件 → 公开路由 → 受保护路由。
 * createApp() 可注入 store/config，测试里用它拿到干净的内存库。
 */
import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { loadConfig, type Config } from './config.js';
import { AppError } from './lib/errors.js';
import { formatUtcIso, nowMs } from './lib/time.js';
import { requireAuth } from './middleware/auth.js';
import { rateLimit } from './middleware/rate-limit.js';
import { requestId } from './middleware/request-id.js';
import { AggregateService } from './services/aggregates.js';
import { AuthService } from './services/auth.js';
import { MaintenanceService } from './services/maintenance.js';
import { PhotoService } from './services/photos.js';
import { RecordService } from './services/records.js';
import { ShopService } from './services/shops.js';
import { UserService } from './services/users.js';
import { MemoryStore } from './store/memory.js';
import { SqliteStore } from './store/sqlite.js';
import type { Store } from './store/store.js';
import type { AppEnv, Services } from './types.js';
import { authRoutes } from './routes/auth.js';
import { geoRoutes } from './routes/geo.js';
import { photosRoutes } from './routes/photos.js';
import { recordsRoutes } from './routes/records.js';
import { shareRoutes } from './routes/share.js';
import { shopsRoutes } from './routes/shops.js';
import { statsRoutes } from './routes/stats.js';
import { systemRoutes } from './routes/system.js';
import { usersRoutes } from './routes/users.js';

export interface CreateAppOptions {
  /** 覆盖配置（嵌套对象按字段合并） */
  config?: Partial<Config>;
  /** 注入自定义 store（测试） */
  store?: Store;
  /** false = 纯内存、不落盘（默认：sqlite 用 :memory:，memory 用内存） */
  persist?: boolean;
}

export interface AppBundle {
  app: Hono<AppEnv>;
  services: Services;
  store: Store;
  close(): Promise<void>;
}

export async function createApp(opts: CreateAppOptions = {}): Promise<AppBundle> {
  const base = loadConfig();
  const cfg: Config = {
    ...base,
    ...opts.config,
    wechat: { ...base.wechat, ...opts.config?.wechat },
    rateLimit: { ...base.rateLimit, ...opts.config?.rateLimit },
    imageCheck: { ...base.imageCheck, ...opts.config?.imageCheck },
  };

  const store =
    opts.store ??
    (cfg.storage === 'sqlite'
      ? await SqliteStore.open(opts.persist === false ? null : cfg.sqliteFile)
      : await MemoryStore.open());

  const services: Services = {
    cfg,
    store,
    auth: new AuthService(store, cfg),
    records: new RecordService(store, cfg),
    aggregates: new AggregateService(store),
    shops: new ShopService(store),
    photos: new PhotoService(store, cfg),
    users: new UserService(store),
    maintenance: new MaintenanceService(store, cfg),
  };

  const app = new Hono<AppEnv>();

  // ---- 全局中间件 ----
  app.use('*', requestId());
  app.use(
    '*',
    cors({
      origin: '*', // H5 跨域；生产建议收敛到白名单
      allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'If-Match', 'X-Request-Id', 'X-Timezone-Offset', 'X-Client-Version'],
      exposeHeaders: ['X-Request-Id', 'Idempotent-Replayed', 'Retry-After', 'ETag'],
      maxAge: 86400,
    }),
  );
  app.onError(handleError);
  app.notFound((c) =>
    c.json(
      { error: { code: 'NOT_FOUND', message: '接口不存在', requestId: c.get('requestId') ?? 'unknown' } },
      404,
    ),
  );

  // ---- 组装 /v1 ----
  const api = new Hono<AppEnv>();

  // 公开：运维、字典、认证
  api.route('/', systemRoutes(services));
  api.route('/geo', geoRoutes(services));

  /* 公开：分享读（契约 §11 #10）。
     必须挂在 secure() 之外 —— 转发卡片要被未登录的人/外部浏览器打开。
     安全性由 shareToken 保证（见 routes/share.ts 的注释）。
     单独限流：这是唯一免鉴权且能按 id 拉数据的入口，别让它成为枚举通道。 */
  const shareGroup = new Hono<AppEnv>();
  if (cfg.rateLimit.enabled) {
    shareGroup.use('*', rateLimit({ max: cfg.rateLimit.defaultPerMin, trustProxy: cfg.trustProxy }));
  }
  shareGroup.route('/', shareRoutes(services));
  api.route('/share', shareGroup);

  const authGroup = new Hono<AppEnv>();
  if (cfg.rateLimit.enabled) {
    authGroup.use('*', rateLimit({ max: cfg.rateLimit.authPerMin, trustProxy: cfg.trustProxy }));
  }
  authGroup.route('/', authRoutes(services));
  api.route('/auth', authGroup);

  // 受保护：全部按 userId 隔离
  const secure = (routes: Hono<AppEnv>, extraLimit?: number): Hono<AppEnv> => {
    const g = new Hono<AppEnv>();
    g.use('*', requireAuth(services.auth));
    if (cfg.rateLimit.enabled) {
      g.use('*', rateLimit({ max: cfg.rateLimit.defaultPerMin, trustProxy: cfg.trustProxy }));
      if (extraLimit) {
        g.use('*', rateLimit({ max: extraLimit, trustProxy: cfg.trustProxy }));
      }
    }
    g.route('/', routes);
    return g;
  };

  api.route('/records', secure(recordsRoutes(services)));
  api.route('/shops', secure(shopsRoutes(services)));
  api.route('/stats', secure(statsRoutes(services)));
  api.route('/photos', secure(photosRoutes(services), cfg.rateLimit.photoPerMin));
  api.route('/me', secure(usersRoutes(services)));

  app.route('/v1', api);

  // 根路径便捷入口（契约 base 是 /v1，运维常直接打 /healthz）
  app.get('/healthz', (c) => c.json({ status: 'ok', version: cfg.version, time: formatUtcIso(nowMs()) }));
  app.get('/', (c) => c.html(INDEX_HTML));

  return { app, services, store, close: () => store.close() };
}

function handleError(e: unknown, c: Context<AppEnv>): Response {
  let rid = 'unknown';
  try {
    rid = c.get('requestId') ?? c.req.header('X-Request-Id') ?? 'unknown';
  } catch {
    /* 中间件尚未执行（极少见） */
  }

  if (e instanceof AppError) {
    if (e.headers) for (const [k, v] of Object.entries(e.headers)) c.header(k, v);
    return c.json(
      {
        error: {
          code: e.code,
          message: e.message,
          requestId: rid,
          ...(e.fields ? { fields: e.fields } : {}),
        },
      },
      e.status as ContentfulStatusCode,
    );
  }

  console.error('[unhandled]', e);
  return c.json({ error: { code: 'INTERNAL_ERROR', message: '服务内部错误', requestId: rid } }, 500);
}

const INDEX_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>照片墙 API</title>
<style>body{font:15px/1.7 -apple-system,system-ui,sans-serif;max-width:720px;margin:48px auto;padding:0 20px;color:#222}
code{background:#f4f4f5;padding:2px 6px;border-radius:4px}li{margin:6px 0}</style></head>
<body>
<h1>照片墙 API v1</h1>
<p>契约文件：<a href="/v1/docs">/v1/docs</a>（Swagger UI） · <a href="/v1/openapi.yaml">/v1/openapi.yaml</a></p>
<ul>
  <li><code>POST /v1/auth/wechat/login</code> · <code>POST /v1/auth/anonymous</code> · <code>POST /v1/auth/refresh</code></li>
  <li><code>GET /v1/records</code> · <code>GET /v1/records/random</code> · <code>GET /v1/records/cities</code> · <code>GET /v1/records/months</code></li>
  <li><code>POST /v1/records</code> · <code>GET|PATCH|DELETE /v1/records/:id</code> · <code>POST /v1/records/:id/restore</code></li>
  <li><code>GET /v1/stats</code> · <code>GET /v1/shops/by-name</code> · <code>GET /v1/shops/:shopId</code></li>
  <li><code>POST /v1/photos</code> · <code>DELETE /v1/photos/:photoId</code> · <code>GET /v1/geo/cities</code> · <code>GET /v1/healthz</code></li>
</ul>
</body></html>`;
