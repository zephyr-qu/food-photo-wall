/** 行模型 → 对外 DTO。字段名/可空性与契约 §4.2 / §6 完全一致。 */
import type { PhotoRow, RecordRow, ShopRow } from '../store/types.js';
import { encodeCursor } from './cursor.js';
import { compareCodePoint } from './sort.js';
import { formatUtcIsoMs } from './time.js';

export interface RecordDto {
  id: string;
  eat: string;
  shop: string | null;
  shopId: string | null;
  city: string | null;
  district: string | null;
  rating: number;
  at: string;
  tzOffset: string;
  eatenAtUtc: string;
  note: string | null;
  photo: string | null;
  photoThumb: string | null;
  photoId: string | null;
  /**
   * 全部照片（有序，0..5 张）。恒存在，空数组 = 没有自定义照片（用预置配图）。
   *
   * 为什么保留 `photo/photoThumb/photoId` 三个旧字段：老客户端只认它们。
   * 它们一律等于**封面**（= photos[0]），photos 为空时全为 null。
   */
  photos: RecordPhotoDto[];
  version: number;
  createdAt: string;
  updatedAt: string;
}

/** 记录里的一张照片 */
export interface RecordPhotoDto {
  photoId: string;
  /** 1080w 展示图 */
  photo: string;
  /** 400w 缩略图 */
  photoThumb: string;
}

export interface PageDto<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
  total: number;
}

/**
 * 行 → DTO。
 *
 * @param photos 该记录的**全部**照片行，按 `row.photoIds` 顺序排列
 *   （顺序必须由存储层保证：封面 = photos[0]，前端详情页左右切换也依赖它）。
 *
 * 已软删（deletedAt !== null）的照片**从 photos 里剔除**，且**不影响封面选取**
 * —— 封面取「剔除后」的第一张；剔除后为空 → photos=[] 且旧三字段全 null。
 */
export function toRecordDto(row: RecordRow, photos?: PhotoRow[]): RecordDto {
  const usable = (photos ?? []).filter((p) => p.deletedAt === null);
  const cover = usable[0] ?? null;
  return {
    id: row.id,
    eat: row.eat,
    shop: row.shop,
    shopId: row.shopId,
    city: row.city,
    district: row.district,
    rating: row.rating,
    at: row.atLocal,
    tzOffset: row.tzOffset,
    eatenAtUtc: row.eatenAtUtc,
    note: row.note,
    photo: cover ? cover.photoUrl : null,
    photoThumb: cover ? cover.thumbUrl : null,
    photoId: cover ? cover.id : null,
    photos: usable.map((p) => ({
      photoId: p.id,
      photo: p.photoUrl,
      photoThumb: p.thumbUrl,
    })),
    version: row.version,
    createdAt: formatUtcIsoMs(row.createdAt),
    updatedAt: formatUtcIsoMs(row.updatedAt),
  };
}

export interface ShopDto {
  id: string;
  name: string;
  cities: string[];
  createdAt: string;
}

export function toShopDto(shop: ShopRow, cities: string[]): ShopDto {
  return {
    id: shop.id,
    name: shop.name,
    cities: [...new Set(cities.filter(Boolean))].sort(compareCodePoint),
    createdAt: formatUtcIsoMs(shop.createdAt),
  };
}

export interface PhotoDto {
  photoId: string;
  url: string;
  photo: string;
  photoThumb: string;
  width: number;
  height: number;
  size: number;
  mime: string;
  status: 'approved' | 'rejected';
  createdAt: string;
}

export function toPhotoDto(row: PhotoRow): PhotoDto {
  return {
    photoId: row.id,
    url: row.url,
    photo: row.photoUrl,
    photoThumb: row.thumbUrl,
    width: row.width,
    height: row.height,
    size: row.size,
    mime: row.mime,
    status: row.status,
    createdAt: formatUtcIsoMs(row.createdAt),
  };
}

export function cursorOf(row: { eatenAtUtc: string; id: string }): string {
  return encodeCursor({ at: row.eatenAtUtc, id: row.id });
}

/** 金额/均分类：保留 2 位小数（文档示例 4.32 / 3.5 / 4.67） */
export const round2 = (n: number): number => Math.round(n * 100) / 100;
