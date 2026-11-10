/* ================================================================
   静态资源地址（P1-8 包体开关）

   主包 1.25 MiB 里 64% 是 `src/static/img/`（12 张预置菜图 + 2 张分享封面
   + 2 个图标）。这些图是"没有用户照片时按菜名哈希兜底"的固定资源，
   完全可以放 CDN / 对象存储，用网络 URL 引用（微信 <Image> 与分享封面
   都支持 https 图片）。

   开关：构建期环境变量 `TARO_APP_ASSET_BASE`（例如
   `https://cdn.example.com/photo-wall`）。
     · 不设置（默认）：行为完全不变，`/static/...` 原样返回，图随包发布；
     · 设置：只改写 **jpg/jpeg**，且把 `/static/img/` 前缀整体剥掉、只留文件名 ——
       `/static/img/x.jpg` → `<base>/x.jpg`（远端只需一个吃单段文件名的
       `/files/:name` 路由，不用复刻 /static/img 目录树）。png 图标
       （camera/dice）仍走包内路径。构建配置同时**跳过**把 jpg 拷进产物，
       主包直接少 ~820 KB。

   ⚠ 打开开关前，必须先把那 14 张 jpg（12 张预置菜图 + 2 张分享封面）**按文件名**
   传到该 base 下（`<base>/kaoya.jpg` 能 200），否则包内路径没了、远端又取不到
   = 全站预置图裂开。后端一侧的实现见 photo-wall-api 的
   `server/src/routes/system.ts` 与 `server/src/lib/preset-assets.ts`。
   ================================================================ */

/** 构建期内联的资源 base（末尾斜杠已去掉；空串 = 不启用） */
const ASSET_BASE = (process.env.TARO_APP_ASSET_BASE || '').trim().replace(/\/+$/, '');

/** 是否启用 CDN 资源前缀（给调试/日志用） */
export const ASSET_CDN_ENABLED = Boolean(ASSET_BASE);

/**
 * 把包内静态资源路径解析成最终可用地址。
 *
 * 只处理 `/static/` 开头的包内路径；http(s)/本机文件/空值原样返回，
 * 所以调用方可以无脑套在 `photoOf()` / `photosOf()` 的结果上。
 *
 * 启用 ASSET_BASE（远端托管预置图，减主包体积）时，**只改写 jpg/jpeg**
 * （12 张预置菜图 + 2 张分享封面，约 820KB）：
 *   `/static/img/x.jpg` → `${ASSET_BASE}/x.jpg`
 * 即把 `/static/img/` 前缀整体剥掉、只留文件名。这样远端只需一个
 * 接受单段文件名的 `/files/:name` 路由（见 photo-wall-mp/server 的
 * `routes.js` 与 photo-wall-api 的 `system.ts`），无需复刻 /static/img 目录树。
 *
 * png（camera.png / dice.png 这类 UI 图标，才几 KB）**不走远端**，保持包内路径——
 * 它们是界面必需元素，留在包里最稳，且对 2MB 预算影响可忽略。
 */
export function resolveAssetUrl(path: string): string {
  if (!path) return path;
  if (!ASSET_BASE || !path.startsWith('/static/')) return path;
  /* 仅 jpg/jpeg 走远端；png 等其余静态资源仍走包内路径 */
  if (!/\.jpe?g$/i.test(path)) return path;
  const file = path.replace(/^\/static\/img\//, '');
  return `${ASSET_BASE}/${file}`;
}
