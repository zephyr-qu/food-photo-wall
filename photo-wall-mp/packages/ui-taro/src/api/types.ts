/* ================================================================
   接口类型（对齐 docs/api/photo-wall-api.md §4）

   为什么不直接复用 FoodRecord：
   · FoodRecord 是**渲染用**的 9 字段形状，页面只认它；
   · 接口 Record 多了 version / eatenAtUtc / photoId / shopId 等
     服务端字段，前端不读但写请求要用（PATCH 的 photoId、If-Match 的 version）。
   两者在 src/data/adapters.ts 里做一次性转换，页面代码不用感知。
   ================================================================ */

/** 接口返回的一条记录（§4.2） */
export interface ApiRecord {
  id: string;
  eat: string;
  shop: string | null;
  shopId?: string | null;
  city: string | null;
  district?: string | null;
  rating: number;
  /** YYYY-MM-DDTHH:mm（本地墙钟，无时区） */
  at: string;
  tzOffset?: string | null;
  /** RFC3339 UTC，排序/游标口径，前端不读 */
  eatenAtUtc?: string;
  note: string | null;
  /** https URL；null = 用预置配图。**封面**（= photos[0]） */
  photo: string | null;
  photoThumb?: string | null;
  photoId?: string | null;
  /** 全部照片（有序，0..5）；空 = 用预置配图。
   *  老服务端没有这个字段 —— 适配层会用 photo/photoThumb 补一条。 */
  photos?: ApiRecordPhoto[];
  version?: number;
  createdAt?: string;
  updatedAt?: string;
}

/** 记录里的一张照片（§4.2 photos[]） */
export interface ApiRecordPhoto {
  photoId: string;
  /** 1080w 展示图 */
  photo: string;
  /** 400w 缩略图 */
  photoThumb: string;
}

/** 列表分页（§6.2.1） */
export interface ApiPage {
  items: ApiRecord[];
  nextCursor: string | null;
  hasMore: boolean;
  total: number;
}

/** 城市计数（§6.3.1） */
export interface ApiCityCounts {
  total: number;
  uncityCount: number;
  /** 城市名 → 条数；不含「未记」 */
  cityCounts: Array<{ city: string; count: number }>;
  /** 省 → 城市列表（含计数），已按码点序 */
  provinces: Array<{ province: string; count: number; cities: Array<{ city: string; count: number }> }>;
  generatedAt?: string;
}

/** 月份桶（§6.3.2，月轴用） */
export interface ApiMonth {
  month: string;
  count: number;
  /** @deprecated 严格 after 语义，翻页时不含该条；用 firstCursorInclusive */
  firstCursor: string | null;
  /** 配 `cursorInclusive=true` 使用 → 包含该月最新一条（跳月正确姿势） */
  firstCursorInclusive: string | null;
}

export interface ApiMonths {
  items: ApiMonth[];
}

/** 统计（§6.3.3） */
export interface ApiStats {
  total: number;
  fiveCount: number;
  firstFiveEat: string | null;
  cities: number;
  shops: number;
  /** 分母包含未评分（0 分）的记录 */
  avgRating: number;
  /** 分母只含有评分的记录 */
  avgRatingRated: number;
  repeated: Array<{ eat: string; count: number }>;
  /** 以下为文档里的辅助字段，前端暂不展示，保留以免类型收窄 */
  dishCount?: number;
  ratedCount?: number;
  scope?: { city: string | null; cityMissing: boolean; from: string | null; to: string | null };
  generatedAt?: string;
}

/** 店铺档案（§6.4.1 / §6.4.2） */
export interface ApiShop {
  shop: { id: string; name: string; cities: string[]; createdAt?: string } | null;
  stats: {
    visitCount: number;
    dishCount: number;
    cityCount?: number;
    /** 只对 rating>0 的记录求平均（与墙统计口径不同） */
    avgRating: number;
    ratedCount?: number;
    fiveCount: number;
    firstAt: string | null;
    lastAt: string | null;
  };
  records: ApiRecord[];
  nextCursor?: string | null;
  hasMore?: boolean;
  /** by-name 命中多家同名店时的候选 */
  candidates?: Array<{ id: string; name: string; cities: string[] }>;
}

import type { FoodRecord } from '@photo-wall/core';

/** 页面用的店铺视图（把接口的 shop/stats 拍平，避免页面里 shop.shop.name） */
export interface ShopView {
  name: string;
  cities: string[];
  visitCount: number;
  dishCount: number;
  avgRating: number;
  fiveCount: number;
  firstAt: string | null;
  lastAt: string | null;
  items: FoodRecord[];
  /** 同名连锁店候选（by-name 未指定城市且命中多家同名店时，接口给 shop:null + candidates） */
  candidates: Array<{ id: string; name: string; cities: string[] }>;
  /** 还有更早的记录可翻（A6：以前直接丢弃 nextCursor/hasMore，100 条后静默截断） */
  hasMore: boolean;
  nextCursor: string | null;
}

/** 上传结果（§6.5.1） */
export interface ApiPhoto {
  photoId: string;
  url: string;
  photo: string;
  photoThumb: string;
  width?: number;
  height?: number;
  size?: number;
  mime?: string;
  status?: string;
}

/** 新建/更新入参（§6.2.3 / §6.2.4） */
export interface ApiRecordInput {
  eat: string;
  shop?: string | null;
  shopId?: string | null;
  city?: string | null;
  district?: string | null;
  rating?: number;
  note?: string | null;
  /** 最多 5 个；整体替换。缺省 = 不动（PATCH）/ 无照片（POST）
   *
   *  旧的单图字段 photoId 已被 photoIds 取代，不再出现在入参里。 */
  photoIds?: string[] | null;
  at?: string;
  tzOffset?: string;
}
