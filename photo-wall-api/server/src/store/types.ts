/** 存储层行模型（与 §7.1 表结构一一对应；时间用 epoch ms 存） */

export interface UserRow {
  id: string;
  wechatOpenid: string | null;
  deviceId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface RecordRow {
  id: string;
  userId: string;
  eat: string;
  shop: string | null;
  shopId: string | null;
  city: string | null;
  district: string | null;
  rating: number;
  /** 'YYYY-MM-DDTHH:mm' 本地墙钟，直接下发 */
  atLocal: string;
  tzOffset: string;
  /** RFC3339 UTC，排序/游标口径 */
  eatenAtUtc: string;
  note: string | null;
  /**
   * 记录的全部照片（有序，0..5 张）。
   *
   * 为什么是数组而不是单个 photoId：一条美食支持至多 5 张照片，
   * 详情页要能左右切换，墙上还要从这几张里随机挑一张当封面 ——
   * 单个 id 表达不了"顺序"也表达不了"多张"。
   *
   * 旧版本只有 `photoId: string | null`。迁移时把旧值折成 `[photoId]`
   * （见 store/memory.ts 的 hydrate 与 store/sqlite.ts 的迁移），
   * 之后旧字段不再写入。
   */
  photoIds: string[];
  version: number;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  /**
   * 分享令牌（契约 §11 #10）：**默认 null = 未分享**。
   *
   * 为什么不是"记录 id 直接可读"：那等于全库公开枚举。用户主动点「分享」
   * 才生成一个不可猜的随机串，`GET /share/records/{id}?token=` 校验它。
   * 撤销分享 = 置回 null，旧链接立即失效。
   */
  shareToken: string | null;
  /** 分享令牌生成时间（null = 未分享）；用于排查"这个链接什么时候开的" */
  sharedAt: number | null;
}

export interface ShopRow {
  id: string;
  userId: string;
  name: string;
  city: string | null;
  createdAt: number;
}

export interface PhotoRow {
  id: string;
  userId: string;
  /** 原图 */
  url: string;
  /** 1080w 展示图 */
  photoUrl: string;
  /** 400w 缩略图 */
  thumbUrl: string;
  width: number;
  height: number;
  size: number;
  mime: string;
  status: 'approved' | 'rejected';
  createdAt: number;
  deletedAt: number | null;
}

export interface RefreshRow {
  token: string;
  userId: string;
  createdAt: number;
  expiresAt: number;
}

export interface IdempotencyRow {
  userId: string;
  key: string;
  status: number;
  body: unknown;
  createdAt: number;
  expiresAt: number;
}
