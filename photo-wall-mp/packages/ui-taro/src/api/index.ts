/* ================================================================
   接口端点（薄封装，一个函数对一条接口）

   命名与 docs/api 的 §5 接口总表一一对应，参数顺序固定为
   （业务参数, 分页/游标参数），方便数据层直接透传。
   ================================================================ */
import { request, upload } from './client';
import type {
  ApiCityCounts,
  ApiMonths,
  ApiPage,
  ApiPhoto,
  ApiRecord,
  ApiRecordInput,
  ApiShop,
  ApiStats,
} from './types';

export interface ListQuery {
  limit?: number;
  cursor?: string | null;
  /** 城市名精确匹配（'' 不传；「未记」用 cityMissing） */
  city?: string | null;
  /** true = 只看未记城市 */
  cityMissing?: boolean;
  shopId?: string;
  /** 按省筛选（P1，服务端展开城市集合） */
  province?: string;
}

/** GET /records —— 游标分页列表 */
export function listRecords(q: ListQuery = {}): Promise<ApiPage> {
  return request<ApiPage>('GET', '/records', {
    query: {
      limit: q.limit,
      cursor: q.cursor || undefined,
      city: q.city || undefined,
      cityMissing: q.cityMissing ? true : undefined,
      shopId: q.shopId,
      province: q.province,
    },
  });
}

/** GET /records/{id} —— 单条（详情/编辑初始化） */
export function getRecord(id: string): Promise<ApiRecord> {
  return request<ApiRecord>('GET', `/records/${encodeURIComponent(id)}`);
}

/** POST /records —— 新建（带幂等键，弱网重试不会产生两条） */
export function createRecord(input: ApiRecordInput, idempotencyKey?: string): Promise<ApiRecord> {
  return request<ApiRecord>('POST', '/records', {
    body: input,
    headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined,
  });
}

/** PATCH /records/{id} —— 局部更新（可选乐观锁） */
export function patchRecord(
  id: string,
  patch: Partial<ApiRecordInput>,
  version?: number,
): Promise<ApiRecord> {
  return request<ApiRecord>('PATCH', `/records/${encodeURIComponent(id)}`, {
    body: patch,
    headers: version != null ? { 'If-Match': String(version) } : undefined,
  });
}

/** DELETE /records/{id} —— 软删、幂等 */
export function deleteRecordApi(id: string): Promise<void> {
  return request<void>('DELETE', `/records/${encodeURIComponent(id)}`);
}

/**
 * POST /records/{id}/restore —— 撤销删除（契约 §6.2.7，软删窗口内）。
 *
 * 后端已经实现：幂等（已恢复再调仍 200）、超过 `restoreWindowDays` 返回 410。
 * 前端的"5 秒撤销"就是删完立刻留着这个入口，超时才把 toast 收掉。
 */
export function restoreRecord(id: string): Promise<ApiRecord> {
  return request<ApiRecord>('POST', `/records/${encodeURIComponent(id)}/restore`);
}

/**
 * POST /records/{id}/share —— 开启分享，拿到不可猜的 shareToken（契约 §11 #10）。
 *
 * 为什么不直接用 id 分享：id 一旦贴到群里就永久可读、收不回来。token 由用户
 * 主动开启、撤销即刻失效；后端已保证幂等（重复调用复用原 token，已发出去的
 * 卡片不会失效）。
 */
export function openShare(id: string): Promise<{ shareToken: string; sharedAt: number }> {
  return request<{ shareToken: string; sharedAt: number }>(
    'POST',
    `/records/${encodeURIComponent(id)}/share`,
  );
}

/**
 * GET /share/records/{id}?token= —— **免登录**读一条被分享的记录。
 *
 * `auth: false` 是关键：落地页可能来自完全没登录过的外部浏览器/新用户，
 * 不能触发 `ensureSession()`（那会先走一遍 wx.login，慢且毫无必要）。
 */
export function readSharedRecord(id: string, token: string): Promise<{ record: ApiRecord; shared: boolean }> {
  return request<{ record: ApiRecord; shared: boolean }>(
    'GET',
    `/share/records/${encodeURIComponent(id)}`,
    { query: { token }, auth: false },
  );
}

/** GET /records/random —— 随机一道（可排除当前这张）
 *  服务端这条路由的响应是 { record } 外壳（区别于 /records/{id} 的裸对象），
 *  必须在这里拆掉：否则 toFoodRecord 会把外壳当记录转成全 undefined，
 *  渲染时 hashOf(undefined) 崩在 .length —— 浮窗弹不出来、整页卡死。 */
export async function randomRecord(q: {
  city?: string | null;
  cityMissing?: boolean;
  excludeId?: string | null;
} = {}): Promise<ApiRecord> {
  const { record } = await request<{ record: ApiRecord }>('GET', '/records/random', {
    query: {
      city: q.city || undefined,
      cityMissing: q.cityMissing ? true : undefined,
      excludeId: q.excludeId || undefined,
    },
  });
  return record;
}

/** GET /records/cities —— 全量城市计数（不吃城市筛选） */
export function listCityCounts(): Promise<ApiCityCounts> {
  return request<ApiCityCounts>('GET', '/records/cities');
}

/**
 * GET /records/months —— 月份桶（月轴用）。
 *
 * 分页后客户端只知道"已加载的几页"，算不出全库月份，所以必须问服务端。
 * 每项给两个游标：`firstCursor`（严格 after，旧）与 `firstCursorInclusive`
 * （配 `cursorInclusive=true` 才含当月第一条 —— 跳月要用这个）。
 */
export function listMonths(q: { city?: string | null; cityMissing?: boolean } = {}): Promise<ApiMonths> {
  return request<ApiMonths>('GET', '/records/months', {
    query: {
      city: q.city || undefined,
      cityMissing: q.cityMissing ? true : undefined,
    },
  });
}

/**
 * 跳到某月第一页：用 `cursorInclusive=true` 把该月最新一条**包含**进来。
 *
 * 这是月轴跳转的正确用法。若用 `cursor` 而不带 inclusive，keyset 是严格 `<`，
 * 当月第一张会稳定丢失（历史 B7）。
 */
export function listFromCursorInclusive(q: {
  cursor: string;
  limit?: number;
  city?: string | null;
  cityMissing?: boolean;
}): Promise<ApiPage> {
  return request<ApiPage>('GET', '/records', {
    query: {
      limit: q.limit,
      cursor: q.cursor,
      cursorInclusive: true,
      city: q.city || undefined,
      cityMissing: q.cityMissing ? true : undefined,
    },
  });
}

/** GET /stats —— 六行统计（默认全量口径） */
export function getStats(): Promise<ApiStats> {
  return request<ApiStats>('GET', '/stats');
}

/** GET /shops/by-name —— 按店名查店铺档案（过渡兼容，见 §6.4）
 *
 *  `city` 用于同名连锁店消歧；`limit/cursor` 用于翻页（后端默认 100，最大 200）。
 */
export function getShopByName(
  name: string,
  q: { city?: string | null; limit?: number; cursor?: string | null } = {},
): Promise<ApiShop> {
  return request<ApiShop>('GET', '/shops/by-name', {
    query: {
      name,
      city: q.city || undefined,
      limit: q.limit,
      cursor: q.cursor || undefined,
    },
  });
}

/** GET /shops/{shopId} —— 按 id 查店铺档案 */
export function getShopById(shopId: string): Promise<ApiShop> {
  return request<ApiShop>('GET', `/shops/${encodeURIComponent(shopId)}`);
}

/** POST /photos —— 上传照片，拿 photoId + 三个 URL */
export function uploadPhoto(filePath: string): Promise<ApiPhoto> {
  return upload<ApiPhoto>('/photos', filePath, { scene: 'record' });
}

/** GET /geo/cities —— 城市字典（P1，可继续用内置表）
 *  表单「从城市表选」走这条（墙上走 `/records/cities` 的 provinces）；
 *  二者都来自服务端同一份 208 城表，避免两处各自演进。 */
export function getGeoCities(): Promise<{
  version: string;
  provinces: Array<{ province: string; cities: string[] }>;
}> {
  return request('GET', '/geo/cities', { auth: false });
}

/**
 * 把服务端城市字典拍成 CityPicker 要的 ProvinceGroup[]（不带计数）。
 *
 * 服务端 `cities` 是 `string[]`，CityPicker 的 `ProvinceGroup.cities` 是
 * `{ city, count }[]`；表单场景 `showCounts={false}`，计数填 0 即可。
 * 这样表单与墙共用「服务端是字典真源」，本地 `provinceCatalogue()` 只作
 * 兜底（见 compose 页），不再各自维护一份分组实现。
 */
export function geoCitiesToGroups(
  data: Awaited<ReturnType<typeof getGeoCities>>,
): ProvinceGroup[] {
  return data.provinces.map((p) => ({
    province: p.province,
    count: 0,
    cities: p.cities.map((city) => ({ city, count: 0 })),
  }));
}

import type { ProvinceGroup } from '@photo-wall/core';
