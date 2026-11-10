/* ================================================================
   adapters 的多图对齐（ui-taro）

   这层是「接口对象 → 页面对象」的唯一转换，墙/详情/编辑三处都靠它。

   ⚠ 钉住的核心不变式：**photos[i] 与 photoIds[i] 必须指向同一张照片**。
   编辑页回填后 PATCH 是「整体替换」photoIds —— 一旦错位，
   保存一次就会把 A 的图配成 B 的 id（服务端照单全收，照片从此对不上）。

   错位是怎么来的：契约允许 `photos[].photoThumb` 为空（§4.2「可空（为空时
   前端用 photo）」）。URL 侧若把没缩略图的那张 filter 掉、id 侧却按未过滤
   的列表 map，两者下标就错开了。
   ================================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { toFoodRecord, toFoodRecords } from '../src/data/adapters.ts';
import type { ApiRecord } from '../src/api/types.ts';

const base: ApiRecord = {
  id: 'rec_1',
  eat: '甜水面',
  shop: null,
  city: '成都',
  rating: 5,
  at: '2026-10-09T12:30',
  note: null,
  photo: null,
  photoThumb: null,
  photoId: null,
};

/* ---------------- 基本映射 ---------------- */

test('photos 按接口顺序映射到页面', () => {
  const rec: ApiRecord = {
    ...base,
    photo: 'https://x/a.jpg',
    photoId: 'pho_a',
    photos: [
      { photoId: 'pho_a', photo: 'https://x/a.jpg', photoThumb: 'https://x/a-thumb.jpg' },
      { photoId: 'pho_b', photo: 'https://x/b.jpg', photoThumb: 'https://x/b-thumb.jpg' },
    ],
  };
  const out = toFoodRecord(rec, 'full');
  assert.deepEqual(out.photos, ['https://x/a.jpg', 'https://x/b.jpg']);
  assert.deepEqual(out.photoIds, ['pho_a', 'pho_b']);
  assert.equal(out.photo, 'https://x/a.jpg', '详情封面 = photos[0]');
});

test('thumb 尺寸用 photoThumb', () => {
  const rec: ApiRecord = {
    ...base,
    photos: [{ photoId: 'pho_a', photo: 'https://x/a.jpg', photoThumb: 'https://x/a-thumb.jpg' }],
  };
  assert.equal(toFoodRecord(rec, 'thumb').photos[0], 'https://x/a-thumb.jpg');
});

/* ---------------- 对齐不变式（回归） ---------------- */

test('photoThumb 缺失时回落 photo，且 photos 与 photoIds 仍逐项对齐', () => {
  const rec: ApiRecord = {
    ...base,
    photos: [
      { photoId: 'pho_a', photo: 'https://x/a.jpg', photoThumb: '' },
      { photoId: 'pho_b', photo: 'https://x/b.jpg', photoThumb: 'https://x/b-thumb.jpg' },
    ],
  };
  const out = toFoodRecord(rec, 'thumb');
  assert.equal(out.photos.length, 2, '没缩略图的那张不该凭空消失');
  assert.equal(out.photos[0], 'https://x/a.jpg', '缩略图缺失 → 回落展示图');
  assert.equal(out.photos[1], 'https://x/b-thumb.jpg');
  assert.deepEqual(out.photoIds, ['pho_a', 'pho_b']);
  assert.equal(out.photos.length, out.photoIds.length, '两个数组必须等长');
  /* 逐项核对：photos[i] 与 photoIds[i] 属于同一张 */
  const byId = new Map(rec.photos!.map((p) => [p.photoId, p]));
  out.photos.forEach((url, i) => {
    const p = byId.get(out.photoIds[i] as string)!;
    assert.equal(url, p.photoThumb || p.photo, `第 ${i} 项错位了`);
  });
});

test('photo 与 photoThumb 都为空的那张被跳过，不影响其余项的对齐', () => {
  const rec: ApiRecord = {
    ...base,
    photos: [
      { photoId: 'pho_a', photo: '', photoThumb: '' },
      { photoId: 'pho_b', photo: 'https://x/b.jpg', photoThumb: 'https://x/b-thumb.jpg' },
    ],
  };
  const out = toFoodRecord(rec, 'thumb');
  assert.deepEqual(out.photos, ['https://x/b-thumb.jpg']);
  assert.deepEqual(out.photoIds, ['pho_b'], '被跳过的那张不能留下一个孤儿 id');
});

/* ---------------- 老服务端兜底（迁移后已不需要） ---------------- */
/* ⚠ 迁移（photo-ids）上线后，服务端一律在 `photos[]` 里给出全部照片，
   顶层的 photo/photoThumb/photoId 只是封面副本（见 server/src/lib/dto.ts）。
   没有 photos[] 的记录在适配层不再回落单图 —— 那支兜底分支已删除（R4）。
   下面的用例钉住「新版契约」：缺 photos[] 就出空，逼服务端老老实实带数组。 */

test('没有 photos 数组（旧服务端形态）在迁移后得不到图 —— 空数组', () => {
  const rec: ApiRecord = { ...base, photo: 'https://x/a.jpg', photoId: 'pho_a' };
  const out = toFoodRecord(rec, 'full');
  assert.deepEqual(out.photos, [], '顶层 photo 不再被兜底当成一张图');
  assert.deepEqual(out.photoIds, []);
  assert.equal(out.photo, null);
});

test('即便顶层带了 photoThumb，没有 photos[] 也取不到缩略图', () => {
  const rec: ApiRecord = {
    ...base,
    photo: 'https://x/a.jpg',
    photoThumb: 'https://x/a-thumb.jpg',
    photoId: 'pho_a',
  };
  const out = toFoodRecord(rec, 'thumb');
  assert.deepEqual(out.photos, []);
  assert.equal(out.photo, null, '封面也回落成 null，page 再决定预置配图');
});

test('什么都没有 → 空数组（页面据此回落预置配图）', () => {
  const out = toFoodRecord({ ...base }, 'thumb');
  assert.deepEqual(out.photos, []);
  assert.deepEqual(out.photoIds, []);
  assert.equal(out.photo, null);
});

/* ---------------- 随机封面 ---------------- */

test('coverSeed 选出的封面一定在 photos 里，且同 seed 稳定', () => {
  const rec: ApiRecord = {
    ...base,
    photos: [
      { photoId: 'pho_a', photo: 'https://x/a.jpg', photoThumb: 'https://x/a-thumb.jpg' },
      { photoId: 'pho_b', photo: 'https://x/b.jpg', photoThumb: 'https://x/b-thumb.jpg' },
      { photoId: 'pho_c', photo: 'https://x/c.jpg', photoThumb: 'https://x/c-thumb.jpg' },
    ],
  };
  const a1 = toFoodRecord(rec, 'thumb', 'SEED');
  const a2 = toFoodRecord(rec, 'thumb', 'SEED');
  assert.equal(a1.photo, a2.photo, '同 seed 必须选出同一张（否则墙上图片会跳变）');
  assert.ok(rec.photos!.some((p) => p.photoThumb === a1.photo), '封面必须是其中一张');
});

test('不带 coverSeed 时封面 = photos[0]（详情页语义）', () => {
  const rec: ApiRecord = {
    ...base,
    photos: [
      { photoId: 'pho_a', photo: 'https://x/a.jpg', photoThumb: 'https://x/a-thumb.jpg' },
      { photoId: 'pho_b', photo: 'https://x/b.jpg', photoThumb: 'https://x/b-thumb.jpg' },
    ],
  };
  assert.equal(toFoodRecord(rec, 'thumb').photo, 'https://x/a-thumb.jpg');
});

test('toFoodRecords 逐条映射', () => {
  const rec: ApiRecord = { ...base, photos: [{ photoId: 'pho_a', photo: 'https://x/a.jpg', photoThumb: 'https://x/a-thumb.jpg' }] };
  const out = toFoodRecords([rec, { ...base, id: 'rec_2' }], 'thumb');
  assert.equal(out.length, 2);
  assert.equal(out[0].photos.length, 1);
  assert.deepEqual(out[1].photos, []);
});
