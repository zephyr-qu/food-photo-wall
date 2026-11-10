/** 运行配置：全部可通过环境变量覆盖（见 .env.example） */
export interface Config {
  nodeEnv: string;
  port: number;
  version: string;
  jwtSecret: string;
  /** accessToken 有效期（秒），契约 2h */
  accessTtlSec: number;
  /** refreshToken 有效期（秒），契约 30d */
  refreshTtlSec: number;
  /** 缺省时区偏移，契约 +08:00 */
  defaultTzOffset: string;
  wechat: { appId: string | null; secret: string | null };
  /** 上传文件落盘目录 */
  storageDir: string;
  /** 对外基址，用于拼照片 URL */
  publicBaseUrl: string;
  /** 存储后端：memory（纯内存，仅测试/本地联调）| sqlite（单文件 SQLite，单机生产推荐） */
  storage: 'memory' | 'sqlite';
  /** SQLite 数据库文件（storage=sqlite 时生效）；内存模式忽略 */
  sqliteFile: string;
  /** 新用户是否注入 12 条示例记录（默认关，AC-01 要求 recordCount=0） */
  seedDemoRecords: boolean;
  /** 撤销删除窗口（天） */
  restoreWindowDays: number;
  /** 单张照片上限 10 MiB */
  photoMaxBytes: number;
  rateLimit: { enabled: boolean; defaultPerMin: number; photoPerMin: number; authPerMin: number };
  /**
   * 是否信任反向代理传来的 `X-Forwarded-For` / `X-Real-IP`。
   *
   * **默认 false**，因为这决定了限流的 key 是否可被客户端伪造：
   *   · false（默认/直连）→ 用 TCP 对端地址（`getConnInfo`），客户端伪造头无效；
   *   · true（部署在 Nginx/Caddy 后面）→ 取 `X-Forwarded-For` 的**最右一跳**
   *     （由我们自己的代理追加的那一条），仍不受客户端伪造的左侧值影响。
   *
   * 只有当服务**确实**只接受来自自己反向代理的连接时才该打开。
   * 直连公网却打开它 = 限流形同虚设（换一个假 IP 就绕过，已实测）。
   */
  trustProxy: boolean;
  /** 微信内容安全（imgSecCheck）；未配置时按 approved 放行 */
  imageCheck: { enabled: boolean };
  /** 是否在 / 提供 Swagger UI */
  serveDocs: boolean;
  /**
   * 微信 code 是否强制一次性（真实环境必然如此）。
   * 开发模式默认关：方便同一个 code 反复登录调试；测试里打开以覆盖 AC-02。
   */
  strictWechatCodes: boolean;
}

const num = (v: string | undefined, d: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const bool = (v: string | undefined, d: boolean): boolean =>
  v === undefined ? d : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    nodeEnv: env.NODE_ENV ?? 'development',
    port: num(env.PORT, 8787),
    version: env.APP_VERSION ?? '1.0.0',
    jwtSecret: env.JWT_SECRET ?? 'dev-only-insecure-secret-change-me',
    accessTtlSec: num(env.ACCESS_TTL_SEC, 2 * 60 * 60),
    refreshTtlSec: num(env.REFRESH_TTL_SEC, 30 * 24 * 60 * 60),
    defaultTzOffset: env.DEFAULT_TZ_OFFSET ?? '+08:00',
    wechat: { appId: env.WECHAT_APPID ?? null, secret: env.WECHAT_SECRET ?? null },
    storageDir: env.STORAGE_DIR ?? 'var/uploads',
    publicBaseUrl: (env.PUBLIC_BASE_URL ?? `http://localhost:${num(env.PORT, 8787)}`).replace(/\/$/, ''),
    storage: (env.STORAGE === 'sqlite' ? 'sqlite' : 'memory') as 'memory' | 'sqlite',
    sqliteFile: env.SQLITE_FILE ?? 'var/db.sqlite',
    seedDemoRecords: bool(env.SEED_DEMO_RECORDS, false),
    restoreWindowDays: num(env.RESTORE_WINDOW_DAYS, 30),
    photoMaxBytes: num(env.PHOTO_MAX_BYTES, 10 * 1024 * 1024),
    rateLimit: {
      enabled: bool(env.RATE_LIMIT_ENABLED, true),
      defaultPerMin: num(env.RATE_LIMIT_DEFAULT, 60),
      photoPerMin: num(env.RATE_LIMIT_PHOTO, 20),
      authPerMin: num(env.RATE_LIMIT_AUTH, 10),
    },
    imageCheck: { enabled: bool(env.IMAGE_CHECK_ENABLED, false) },
    serveDocs: bool(env.SERVE_DOCS, true),
    strictWechatCodes: bool(env.STRICT_WECHAT_CODES, false),
    /* 默认不信任代理头：直连部署下，伪造 X-Forwarded-For 就能无限绕过限流 */
    trustProxy: bool(env.TRUST_PROXY, false),
  };
}

/**
 * 生产模式启动自检。
 *
 * 为什么必须「硬失败」而不是 console.warn：默认 JWT 密钥是仓库里公开的字符串，
 * 漏配环境变量直接上线 = 任何人都能伪造 accessToken。这类事故只需要发生一次，
 * 而 warn 在容器日志里几乎必然被忽略。同理，未配置微信凭据时
 * `openid = 'dev:' + code`，等于允许任意 code 登录成任意用户。
 *
 * 只在 NODE_ENV=production 时收紧；开发/测试保持宽松（本地要能随便起）。
 *
 * @returns 人类可读的问题列表；空数组表示通过。
 */
export function validateProduction(cfg: Config): string[] {
  if (cfg.nodeEnv !== 'production') return [];
  const problems: string[] = [];

  if (cfg.jwtSecret.includes('dev-only')) {
    problems.push(
      'JWT_SECRET 仍是默认值（dev-only-insecure-...）。生成随机密钥：' +
        'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    );
  }
  if (!cfg.wechat.appId || !cfg.wechat.secret) {
    problems.push(
      'WECHAT_APPID / WECHAT_SECRET 未配置。生产缺失它们会导致 ' +
        'openid=dev:<code> 的伪登录（谁都能登成任何用户）。',
    );
  }
  if (!cfg.strictWechatCodes) {
    problems.push(
      'STRICT_WECHAT_CODES 必须为 true（code 一次性；关闭时同一 code 可反复换 token）。',
    );
  }
  /* IMAGE_CHECK_ENABLED 这里**不再拦**。
     以前这里推一条「imgSecCheck 尚未接入真实调用」，而那条信息是错的：
     `lib/wechat-sec-check.ts` 早已真调 `wxa/img_sec_check`（fail-closed、
     token 缓存、>1MB 明确拒绝），photos.ts 上传时逐张过审。
     留着它等于「把正确的生产配置判成错误」，比不检查更坏。
     它需要的凭据前提（WECHAT_APPID / WECHAT_SECRET）由上面那条检查负责。 */
  return problems;
}
