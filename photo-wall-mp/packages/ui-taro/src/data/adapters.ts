/* ================================================================
   接口对象 → 渲染对象

   页面只认 `FoodRecord`（渲染用形状）。服务端多了 photoId/version/eatenAtUtc
   等字段，也把 photo 拆成 photo / photoThumb 两个 URL —— 这里收敛成一份
   转换，避免每个页面各写一遍「用 thumb 还是原图」。

   反向（渲染对象 → 写接口入参）也放这里：照片可能是本机路径、
   包内路径或 https URL，写记录时必须换成 photoId，否则服务端不认。

   ---------- 多图（至多 5 张） ----------
   服务端把全部照片放在 `photos[]`（有序），`photo/photoThumb/photoId` 是封面。
   适配层负责把两条口径收敛成页面用的两个字段：
   · `photos`  —— 全部照片 URL（详情页切图、编辑页列图用）
   · `photo`   —— 封面 URL（列表 / 分享卡片用）
   封面有两种取法：详情页取 photos[0]（用户选的第一张就是封面），
   列表页取「按种子稳定随机挑的一张」（照片墙的随机感）。
   ================================================================ */
import { isRemoteUrl, pickCover } from '@photo-wall/core';
import type { FoodRecord, NewRecordInput, RecordPatch } from '@photo-wall/core';

import type { ApiRecord, ApiRecordInput } from '../api/types';

/**
 * 接口记录 → 页面记录。
 *
 * 列表场景优先用缩略图（photoThumb，约 400w），详情场景要原图：
 * 用 `size` 区分，默认 'thumb'（墙 / 店铺页），详情页传 'full'。
 *
 * @param coverSeed 非空 → 封面用 pickCover 在多张照片里**稳定**挑一张
 *                  （照片墙要随机感，但同一会话内不能跳变）；
 *                  为空 → 封面 = photos[0]（详情页语义：用户选的第一张）。
 */
export function toFoodRecord(
  rec: ApiRecord,
  size: 'thumb' | 'full' = 'thumb',
  coverSeed = '',
): FoodRecord {
  const slots = collectPhotoSlots(rec, size);
  const urls = slots.map((s) => s.url);
  const cover = coverSeed ? pickCover(urls, coverSeed + rec.id) : urls[0] ?? null;
  return {
    id: rec.id,
    eat: rec.eat,
    shop: rec.shop ?? null,
    city: rec.city ?? null,
    district: rec.district ?? null,
    rating: rec.rating ?? 0,
    at: rec.at,
    note: rec.note ?? null,
    photo: cover,
    photos: urls,
    /* photoId 一并带过来：编辑态要靠它把「没换过的照片」原样写回去 */
    photoIds: slots.map((s) => s.id),
    /* 版本号一并带过来：PATCH 时作为 If-Match 发出，做乐观锁 */
    version: rec.version,
  };
}

export function toFoodRecords(
  list: ApiRecord[],
  size: 'thumb' | 'full' = 'thumb',
  coverSeed = '',
): FoodRecord[] {
  return list.map((r) => toFoodRecord(r, size, coverSeed));
}

/** 一张照片在适配层里的位置：URL 与 id 必须在**同一个槽位**。 */
interface PhotoSlot {
  url: string;
  id: string | null;
}

/**
 * 收齐一条记录的全部照片（有序），URL 与 id 一一对应。
 *
 * ⚠ 为什么必须用「槽位」而不是两个独立数组（urls / ids）：
 *   契约允许 `photos[].photoThumb` 为空（§4.2：「可空（为空时前端用 photo）」）。
 *   如果 URL 用 `.filter(Boolean)` 把没缩略图的那张**丢掉**、而 id 用未过滤的
 *   列表去 map，两者就**错位**了 —— 第 0 项的 URL 属于 b、第 0 项的 id 却是 a。
 *   后果很实在：编辑页回填后 PATCH（整体替换）会把 b 的图配成 a 的 id，
 *   服务端存下来的就成了一张不对应的照片。
 *
 *   所以这里一次遍历产出一组槽位（url 与 id 同时来自**同一条** photos 项），
 *   顺序与 photos 完全一致，长度天然相等。
 *
 * 缩略图缺失时的取法：契约说「为空时前端用 photo」，所以回落 `photo`，
 * 而不是把这张照片从列表里剔除（剔除会让它凭空消失，少一张图）。
 */
function collectPhotoSlots(rec: ApiRecord, size: 'thumb' | 'full'): PhotoSlot[] {
  const fromList: PhotoSlot[] = [];
  for (const p of rec.photos || []) {
    const url = size === 'full' ? p.photo : p.photoThumb || p.photo;
    if (!url) continue; // 连展示图都没有 = 这条数据不可用，跳过
    fromList.push({ url, id: p.photoId ?? null });
  }
  return fromList;
}

/** 新建入参（页面 → 接口）。照片由调用方先换成 photoId 列表。 */
export function toCreateInput(
  input: NewRecordInput,
  photoIds?: string[] | null,
  at?: string,
  tzOffset?: string,
): ApiRecordInput {
  const out: ApiRecordInput = {
    eat: input.eat,
    shop: input.shop ?? null,
    city: input.city ?? null,
    district: input.district ?? null,
    rating: input.rating ?? 0,
    note: input.note ?? null,
    ...(at ? { at } : {}),
    /* ⚠ `at` 与 `tzOffset` 必须成对出现。
       只发 `at` 不发偏移，服务端会按默认 +08:00 解释它 —— 用户在
       UTC-5 时时间会差 13 小时，排序、分月全乱。 */
    ...(tzOffset ? { tzOffset } : {}),
  };
  /* undefined = 不写这个字段；null/[] = 明确「没有照片」 */
  if (photoIds !== undefined) out.photoIds = photoIds ?? [];
  return out;
}

/** 更新入参（页面 → 接口）。只发送出现的字段，避免误清空。 */
export function toPatchInput(
  patch: RecordPatch,
  photoIds?: string[] | null,
  tzOffset?: string,
): Partial<ApiRecordInput> {
  const out: Partial<ApiRecordInput> = {};
  if ('eat' in patch) out.eat = patch.eat;
  if ('shop' in patch) out.shop = patch.shop ?? null;
  if ('city' in patch) out.city = patch.city ?? null;
  if ('district' in patch) out.district = patch.district ?? null;
  if ('rating' in patch) out.rating = patch.rating ?? 0;
  if ('note' in patch) out.note = patch.note ?? null;
  if ('at' in patch && patch.at) out.at = patch.at;
  /* 与 `at` 成对：改了时间就要把当前时区一起报上去，否则服务端按
     记录原有的偏移换算 —— 用户搬家后改时间会算错。 */
  if ('at' in patch && patch.at && tzOffset) out.tzOffset = tzOffset;
  /* undefined = 不动照片（PATCH 的缺省语义）；null/[] = 整体替换成空（清空） */
  if (photoIds !== undefined) out.photoIds = photoIds ?? [];
  return out;
}

/** 记录里的照片是不是「远端 URL」（决定换图时要不要删本地文件） */
export function isRemotePhoto(photo?: string | null): boolean {
  return isRemoteUrl(photo);
}
