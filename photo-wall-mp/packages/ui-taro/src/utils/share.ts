/* ================================================================
   分享

   · **墙页**：可以转发 / 分享到朋友圈 —— 对方打开看到的是自己的墙，
     作为「邀请你看看这个小程序」是成立的；
   · **单条记录**：已启用（`RECORD_SHARE_ENABLED = true`）。

   单条分享的完整链路（后端已就绪，见 server/src/routes/share.ts）：
   1. 用户点「转发」→ detail 页先调 `POST /records/{id}/share` 拿 shareToken；
   2. 卡片路径带 `?id=...&share=...`；
   3. 对方打开 → 落地页**免登录**调 `GET /share/records/{id}?token=...` 渲染；
   4. 用户撤销分享 / 删除记录 → 旧链接立刻 404（不会留下永久公开的口子）。

   以前这里写死 `false`，因为记录只在本机 storage，分享出去必然是
   「这一条已经不在了」。后端补上 token 门控的匿名读之后这个前提才成立。
   ================================================================ */

import { resolveAssetUrl } from './asset';

/** 单条记录分享开关：后端已支持 token 门控的匿名读，可以打开。 */
export const RECORD_SHARE_ENABLED = true;

/** 转发卡片封面（5:4，包内资源；实际文件 src/static/img/share-cover.jpg）。
 *
 *  ⚠ 路径必须带 `img/` 段：Taro 的 copy 规则是
 *  `src/static/img/` → `${outputRoot}/static/img/`（见 config/index.js），
 *  产物里只有 `static/img/xxx.jpg`，不存在 `static/xxx.jpg`。
 *  以前写成 `/static/share-cover.jpg`，构建后必 404 —— 微信会回落到页面截图，
 *  分享卡片观感完全不可控（这是拉新第一屏）。
 *
 *  配了 `TARO_APP_ASSET_BASE` 时这里会变成 CDN 的 https 地址（微信分享封面
 *  支持网络图），两张封面因此可以不占主包（P1-8）。 */
export const SHARE_COVER = resolveAssetUrl('/static/img/share-cover.jpg');

/** 朋友圈卡片封面（1:1）。同上，必须带 img/ 段。 */
export const SHARE_TIMELINE_COVER = resolveAssetUrl('/static/img/share-timeline.jpg');

const WALL_TITLE = 'X师傅美食记 · 一面贴满吃的墙';

/** 墙页转发：回首页（而不是带筛选态/详情 id —— 对方没有对应数据）。 */
export function wallShare(): { title: string; path: string; imageUrl: string } {
  return {
    title: WALL_TITLE,
    path: '/pages/wall/index',
    imageUrl: SHARE_COVER,
  };
}

/** 墙页分享到朋友圈。query 留空：朋友圈进入的是单页模式，筛选态没有意义。 */
export function wallTimelineShare(): {
  title: string;
  query: string;
  imageUrl: string;
} {
  return {
    title: WALL_TITLE,
    query: '',
    imageUrl: SHARE_TIMELINE_COVER,
  };
}

/**
 * 单条记录的转发参数。
 *
 * @param eat       菜名（卡片标题用）
 * @param id        记录 id
 * @param shareToken 服务端 `POST /records/{id}/share` 返回的令牌。
 *                   必须带 —— 落地页靠它证明"作者确实分享过这一条"。
 * @param photo     可选：记录自己的照片 URL（比通用封面更有说服力）
 */
export function buildRecordShare(
  eat: string,
  id: string,
  shareToken: string,
  photo?: string | null,
): {
  title: string;
  path: string;
  imageUrl: string;
} {
  /* 路径里**不能**直接放 https 图片地址：微信卡片 imageUrl 支持网络图，
     但兜底仍用包内封面（万一照片被删/失效，卡片不会变白块）。 */
  const cover =
    photo && /^https?:/i.test(photo) ? photo : SHARE_COVER;
  return {
    title: `${eat} · X师傅美食记`,
    path: `/pages/detail/index?id=${encodeURIComponent(id)}&share=${encodeURIComponent(shareToken)}`,
    imageUrl: cover,
  };
}

/** 分享落地页读一条（免登录）：`GET /share/records/{id}?token=` */
export function parseShareParams(params: Record<string, string | undefined>): {
  id: string;
  shareToken: string | null;
} {
  return {
    id: params.id || '',
    shareToken: params.share || null,
  };
}
