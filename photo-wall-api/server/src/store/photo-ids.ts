/**
 * 照片 id 数组（`photoIds`）的读取、归一化与序列化。
 *
 * 为什么单独一个模块：旧行（只有单个 `photoId`）→ 新行（`photoIds` 数组）的
 * 兼容规则要在**三处**用到 —— 内存库的行归一化、SQLite 的迁移与读行、
 * 快照导入。三处各写一遍迟早会漂移，尤其下面这条最容易错：
 *
 *   「显式清空」（photoIds = []）与「从没写过 photoIds」（NULL）必须区别对待。
 *   如果清空时也回落旧列，用户早就删掉的照片会因为旧列里的残留值**复活**。
 *
 * 所以规则只有这一份，其它地方一律调用这里。
 */
import type { PhotoRow, RecordRow } from './types.js';
import type { Store } from './store.js';

/** 携带照片 id 的行（新版或旧版都兼容） */
export interface PhotoIdsCarrier {
  /** 新版：有序 id 数组 */
  photoIds?: unknown;
  /** 旧版：单个 id */
  photoId?: string | null;
}

/**
 * 取出一行记录引用的照片 id 数组。
 *
 * 规则：
 *   · `photoIds` 是数组 → 原样采用（**包括空数组**：那是"用户显式清空"）；
 *   · `photoIds` 缺失 → 回落旧字段 `photoId`（旧数据兼容）；
 *   · 都没有 → 空数组。
 */
export function readPhotoIds(row: PhotoIdsCarrier): string[] {
  if (Array.isArray(row.photoIds)) {
    return row.photoIds.filter((id): id is string => typeof id === 'string' && id !== '');
  }
  const legacy = typeof row.photoId === 'string' && row.photoId !== '' ? row.photoId : null;
  return legacy ? [legacy] : [];
}

/**
 * 从**存储列**取值：`photoIds` 列是 JSON 串。
 *
 * 与 `readPhotoIds` 的关键区别：
 *   · 列值是 `'[]'` → 空数组（用户显式清空），**绝不**回落旧列；
 *   · 列值是 NULL / 空串 → 老数据（还没写过这个列）→ 回落旧列 `photoId`。
 */
export function readPhotoIdsColumn(text: unknown, legacyPhotoId: unknown): string[] {
  if (typeof text === 'string' && text !== '') return parsePhotoIds(text);
  return typeof legacyPhotoId === 'string' && legacyPhotoId !== '' ? [legacyPhotoId] : [];
}

/** 写库：id 数组 → JSON 数组串。空数组存 `'[]'` 而不是 NULL（NULL = 老数据） */
export function serializePhotoIds(ids: string[]): string {
  return JSON.stringify(ids);
}

/**
 * 读库：JSON 数组串 → id 数组。
 *
 * 脏数据（非 JSON 串 / 不是数组）一律当空数组 —— 让一条坏行炸掉整页列表查询
 * 比丢一张封面严重得多。
 */
export function parsePhotoIds(text: unknown): string[] {
  if (typeof text !== 'string' || text === '') return [];
  try {
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === 'string' && id !== '');
  } catch {
    return [];
  }
}

/**
 * 收集一批记录引用的全部照片 id（"这张照片还被谁引用"的判定依据）。
 *
 * 注意只统计**未删除**的记录：软删记录上的照片已经进了待回收流程，
 * 不该再挡住回收。
 */
export function referencedPhotoIds(rows: Iterable<PhotoIdsCarrier>): Set<string> {
  const out = new Set<string>();
  for (const row of rows) {
    for (const id of readPhotoIds(row)) out.add(id);
  }
  return out;
}

/**
 * 取一条记录引用的**全部**照片行（按 `row.photoIds` 顺序）。
 *
 * 为什么顺序在这里保证：封面 = photos[0]，前端详情页的左右切换也依赖顺序，
 * 而存储层返回的是 Map/表的自然顺序。顺序必须由 `photoIds` 说了算。
 *
 * ⚠ 用**批量**查询（store.getPhotos）而不是逐个 getPhoto：
 * 列表一页 20 条 × 每条最多 5 张 = 最多 100 次单行查询，
 * 批量后压成 1 次。顺序由本方法负责（存储层只保证"存在性"）。
 */
export function photosOfRecord(store: Store, row: RecordRow): PhotoRow[] {
  const ids = row.photoIds ?? [];
  if (ids.length === 0) return [];
  const found = store.getPhotos(ids);
  const byId = new Map(found.map((p) => [p.id, p]));
  const out: PhotoRow[] = [];
  for (const id of ids) {
    const photo = byId.get(id);
    if (photo) out.push(photo);
  }
  return out;
}
