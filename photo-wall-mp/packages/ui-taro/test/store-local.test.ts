/* ================================================================
   `src/data/store-local.ts` 的单元测试 —— 本地模式（不连后端）下的筛选、
   城市计数、统计、月份分桶。

   为什么值得单测：这四个函数是「离线仍可用」这条产品承诺的算法部分，
   而它们的错法都是**看懂但不报错**：
     · 筛选把 `''`（未记城市）当成"全部"，离线时城市选择器会显示全库；
     · 计数排序没做同数兜底，城市列表每次刷新顺序抖动；
     · 统计的分母算错（含 0 分 / 不含 0 分），分数看起来"差一点"；
     · 月份分桶用了 UTC 而不是本地墙钟，月初月末的记录会跑到隔壁月。
   以前这些只能靠整机点一遍，现在拆成纯函数就能钉住。
   ================================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { FoodRecord } from '@photo-wall/core';

import {
  cityQuery,
  localCityCounts,
  localFilter,
  localMonths,
  localStats,
} from '../src/data/store-local.ts';

/** 造一条记录（只写测试关心的字段） */
function rec(over: Partial<FoodRecord> & { id: string; at: string }): FoodRecord {
  return { eat: '随便', rating: 0, ...over } as FoodRecord;
}

const LIST: FoodRecord[] = [
  rec({ id: 'a', eat: '担担面', city: '成都', shop: '老店', rating: 5, at: '2026-10-09T12:30' }),
  rec({ id: 'b', eat: '担担面', city: '成都', shop: '老店', rating: 4, at: '2026-10-21T08:05' }),
  rec({ id: 'c', eat: '沙茶面', city: '厦门', rating: 0, at: '2026-09-30T23:59' }),
  rec({ id: 'd', eat: '甜水面', city: null, rating: 5, at: '2026-08-01T00:00' }),
];

test('cityQuery：null=全部 / ""=未记 / 名字=精确', () => {
  assert.deepEqual(cityQuery(null), {});
  assert.deepEqual(cityQuery(''), { cityMissing: true });
  assert.deepEqual(cityQuery('成都'), { city: '成都' });
});

test('localFilter：null 返回全部且按 at 倒序，不改原数组', () => {
  const out = localFilter(LIST, null);
  assert.deepEqual(out.map((r) => r.id), ['b', 'a', 'c', 'd']);
  /* 原数组顺序不能被动过（浅排序也算 bug：调用方可能还在用） */
  assert.deepEqual(LIST.map((r) => r.id), ['a', 'b', 'c', 'd']);
});

test('localFilter："" 只留未记城市的记录，不返回全部', () => {
  const out = localFilter(LIST, '');
  assert.deepEqual(out.map((r) => r.id), ['d']);
});

test('localFilter：按城市精确匹配', () => {
  assert.deepEqual(localFilter(LIST, '成都').map((r) => r.id), ['b', 'a']);
});

test('localCityCounts：计数、未记数、同数按城市名兜底排序、带省分组', () => {
  const c = localCityCounts(LIST);
  assert.equal(c.total, 4);
  /* city: null 与 undefined 都算"未记" */
  assert.equal(c.uncityCount, 1);
  assert.deepEqual(c.cityCounts, [
    { city: '成都', count: 2 },
    { city: '厦门', count: 1 },
  ]);
  /* 省分组用的是 core 同一份实现（离线城市选择器要按省显示） */
  assert.ok(Array.isArray(c.provinces));
  assert.ok(c.provinces.some((p) => p.province === '四川'));
});

test('localStats：分母口径两条（含 0 分 / 只含有评分）', () => {
  const s = localStats(LIST);
  assert.equal(s.total, 4);
  assert.equal(s.fiveCount, 2);
  assert.equal(s.firstFiveEat, '担担面');
  assert.equal(s.cities, 2);
  /* shops 只数非空：老店算 1 家，null 不算 */
  assert.equal(s.shops, 1);
  /* 5+4+0+5=14，14/4=3.5（含未评分） */
  assert.equal(s.avgRating, 14 / 4);
  /* 只算有评分的：14/3 */
  assert.equal(s.avgRatingRated, 14 / 3);
  assert.deepEqual(s.repeated, [{ eat: '担担面', count: 2 }]);
});

test('localStats：空列表不出现 NaN（除零要兜住）', () => {
  const s = localStats([]);
  assert.equal(s.total, 0);
  assert.equal(s.avgRating, 0);
  assert.equal(s.avgRatingRated, 0);
  assert.equal(s.firstFiveEat, null);
  assert.deepEqual(s.repeated, []);
});

test('localMonths：按本地墙钟的 YYYY-MM 分桶，新月份在前，游标恒为 null', () => {
  const months = localMonths(LIST, null);
  assert.deepEqual(months.map((m) => m.month), ['2026-10', '2026-09', '2026-08']);
  assert.deepEqual(months.map((m) => m.count), [2, 1, 1]);
  assert.ok(months.every((m) => m.firstCursor === null && m.firstCursorInclusive === null));
});

test('localMonths：跟随筛选（切城市后月轴只显示该城的月份）', () => {
  assert.deepEqual(localMonths(LIST, '成都').map((m) => m.month), ['2026-10']);
  assert.deepEqual(localMonths(LIST, '').map((m) => m.month), ['2026-08']);
});

test('localMonths：跨月边界的记录只落在自己那个月（23:59 不算下个月）', () => {
  const edge = [
    rec({ id: 'x', at: '2026-09-30T23:59' }),
    rec({ id: 'y', at: '2026-10-01T00:00' }),
  ];
  const months = localMonths(edge, null);
  assert.deepEqual(months.map((m) => [m.month, m.count]), [
    ['2026-10', 1],
    ['2026-09', 1],
  ]);
});
