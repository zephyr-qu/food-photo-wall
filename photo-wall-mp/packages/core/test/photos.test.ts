/* ================================================================
   多图相关单测（photosOf / pickCover / MAX_PHOTOS）

   为什么单独一个文件：多图是这次改造的新能力，
   而 photoOf 的老行为**不能动**（老单测在 records.test.ts 里钉着）。
   放在一处方便对照着看"哪些是新增、哪些是老的"。
   ================================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MAX_PHOTOS, PHOTO_MAP, photoOf, photosOf, pickCover } from '../src/records.ts';

/* ---------------- 上限常量 ---------------- */

test('MAX_PHOTOS：一条记录至多 5 张', () => {
  assert.equal(MAX_PHOTOS, 5);
});

/* ---------------- photosOf ---------------- */

test('photosOf：有自定义照片就按原序返回', () => {
  const out = photosOf({
    eat: '甜水面',
    photo: 'https://x/a.jpg',
    photos: ['https://x/a.jpg', 'https://x/b.jpg', 'https://x/c.jpg'],
  });
  assert.deepEqual(out, ['https://x/a.jpg', 'https://x/b.jpg', 'https://x/c.jpg']);
});

test('photosOf：过滤掉空串，但保留其余的顺序', () => {
  const out = photosOf({
    eat: '甜水面',
    photo: null,
    photos: ['https://x/a.jpg', '', 'https://x/b.jpg'],
  });
  assert.deepEqual(out, ['https://x/a.jpg', 'https://x/b.jpg']);
});

test('photosOf：photos 全是空串 → 回落预置图（和 photoOf 一致）', () => {
  const out = photosOf({ eat: '甜水面', photo: null, photos: ['', ''] });
  assert.deepEqual(out, [photoOf({ eat: '甜水面', photo: null })]);
  assert.deepEqual(out, [PHOTO_MAP['甜水面']]);
});

test('photosOf：没有 photos 字段 → 回落预置图', () => {
  const out = photosOf({ eat: '甜水面', photo: null });
  assert.deepEqual(out, [photoOf({ eat: '甜水面', photo: null })]);
});

test('photosOf：photos 为 null → 回落预置图', () => {
  const out = photosOf({ eat: '甜水面', photo: null, photos: null });
  assert.deepEqual(out, [photoOf({ eat: '甜水面', photo: null })]);
});

test('photosOf：有 photo 没 photos → 也回落成一张（photo 本身是封面）', () => {
  const out = photosOf({ eat: '甜水面', photo: 'wxfile://tmp_a.jpg' });
  assert.deepEqual(out, ['wxfile://tmp_a.jpg']);
});

test('photosOf：返回的是副本，改它不影响原记录', () => {
  const rec = { eat: '甜水面', photo: null, photos: ['https://x/a.jpg'] };
  const out = photosOf(rec);
  out.push('https://x/b.jpg');
  assert.equal(rec.photos!.length, 1);
});

/* ---------------- pickCover ---------------- */

test('pickCover：空数组 → null', () => {
  assert.equal(pickCover([], 'seed'), null);
});

test('pickCover：全是空串 → null', () => {
  assert.equal(pickCover(['', ''], 'seed'), null);
});

test('pickCover：同一 seed 两次结果相同（会话内不跳变）', () => {
  const photos = ['https://x/a.jpg', 'https://x/b.jpg', 'https://x/c.jpg'];
  assert.equal(pickCover(photos, 'seed-1'), pickCover(photos, 'seed-1'));
});

test('pickCover：结果必在输入数组里', () => {
  const photos = ['https://x/a.jpg', 'https://x/b.jpg', 'https://x/c.jpg'];
  for (const seed of ['s1', 's2', 's3', 's4', 's5']) {
    assert.ok(photos.includes(pickCover(photos, seed)!), `seed ${seed} 挑出了不在数组里的图`);
  }
});

test('pickCover：单元素数组恒返回它', () => {
  assert.equal(pickCover(['https://x/a.jpg'], 'any-seed'), 'https://x/a.jpg');
});

test('pickCover：会跳过空串', () => {
  const out = pickCover(['', 'https://x/b.jpg'], 'seed');
  assert.equal(out, 'https://x/b.jpg');
});

test('pickCover：不同 seed 可能挑到不同图（真的是"随机"）', () => {
  const photos = ['https://x/a.jpg', 'https://x/b.jpg', 'https://x/c.jpg'];
  const hits = new Set<string>();
  for (let i = 0; i < 50; i++) {
    hits.add(pickCover(photos, `seed-${i}`)!);
  }
  assert.ok(hits.size > 1, '不同 seed 挑出来的图都一样，不算随机');
});
