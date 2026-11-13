/* ================================================================
   stats.ts 单测

   统计是"用户不会核对的数字"——算错了没人当场发现，
   但「五分 7 道」和实际记录对不上，整面墙都会显得不可信。
   所以六行数据每一行都钉住。
   ================================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeStats, statRows, spotlightMeta } from '../src/stats.ts';
import { REAL_RECORDS } from '../src/demo.ts';
import type { FoodRecord } from '../src/types/domain.ts';

function rec(
  id: string,
  opts: Partial<FoodRecord> = {},
): FoodRecord {
  return {
    id,
    eat: opts.eat ?? id,
    shop: opts.shop ?? null,
    city: opts.city ?? null,
    district: null,
    rating: opts.rating ?? 4,
    at: opts.at ?? '2026-10-09T12:30',
    note: null,
    photo: null,
  };
}

/* ---------------- computeStats ---------------- */

test('computeStats：空数组不炸，全部为 0 / 空', () => {
  const s = computeStats([]);
  assert.equal(s.total, 0);
  assert.equal(s.fiveCount, 0);
  assert.equal(s.firstFiveEat, '');
  assert.equal(s.cities, 0);
  assert.equal(s.shops, 0);
  assert.equal(s.avg, 0);
  assert.deepEqual(s.repeated, []);
});

test('computeStats：总数与平均分', () => {
  const s = computeStats([
    rec('a', { rating: 5 }),
    rec('b', { rating: 4 }),
    rec('c', { rating: 3 }),
  ]);
  assert.equal(s.total, 3);
  assert.equal(s.avg, 4);
});

test('computeStats：平均分按全部记录算（没打分的按 0 参与）', () => {
  /* 这条是刻意的：原型就是这么算的。改成"只算打过分"会让
     统计的均分和墙上的记录数对不上，用户更难理解。 */
  const s = computeStats([rec('a', { rating: 5 }), rec('b', { rating: 0 })]);
  assert.equal(s.avg, 2.5);
});

test('computeStats：五分只数 rating === 5，并记住第一道的菜名', () => {
  const s = computeStats([
    rec('a', { eat: '北京烤鸭', rating: 5 }),
    rec('b', { eat: '冰粉', rating: 4 }),
    rec('c', { eat: '甜水面', rating: 5 }),
  ]);
  assert.equal(s.fiveCount, 2);
  assert.equal(s.firstFiveEat, '北京烤鸭');
});

test('computeStats：没有五分时 firstFiveEat 是空串', () => {
  const s = computeStats([rec('a', { rating: 3 })]);
  assert.equal(s.fiveCount, 0);
  assert.equal(s.firstFiveEat, '');
});

test('computeStats：城市与店铺去重，不把空的算进去', () => {
  const s = computeStats([
    rec('a', { city: '成都', shop: '马旺子' }),
    rec('b', { city: '成都', shop: '马旺子' }),
    rec('c', { city: null, shop: null }),
    rec('d', { city: '北京', shop: '四季民福' }),
  ]);
  assert.equal(s.cities, 2);
  assert.equal(s.shops, 2);
});

test('computeStats：反复吃按次数降序，只留 >= 2 次的', () => {
  const s = computeStats([
    rec('a', { eat: '冰粉' }),
    rec('b', { eat: '冰粉' }),
    rec('c', { eat: '冰粉' }),
    rec('d', { eat: '甜水面' }),
    rec('e', { eat: '甜水面' }),
    rec('f', { eat: '豆汁儿' }),
  ]);
  assert.deepEqual(s.repeated, [
    { eat: '冰粉', count: 3 },
    { eat: '甜水面', count: 2 },
  ]);
});

test('computeStats：没有重复菜时 repeated 为空', () => {
  const s = computeStats([rec('a', { eat: '冰粉' }), rec('b', { eat: '甜水面' })]);
  assert.deepEqual(s.repeated, []);
});

/* ---------------- statRows（六行文案） ---------------- */

test('statRows：固定六行，顺序和文案与原型一致', () => {
  const rows = statRows(computeStats([]));
  assert.equal(rows.length, 6);
  assert.deepEqual(rows.map((r) => r.k), ['拍过的', '五分', '去过', '吃过', '均分', '反复吃']);
});

test('statRows：每行都带自己的量词', () => {
  const rows = statRows(computeStats([rec('a', { rating: 5, city: '成都', shop: '马旺子' })]));
  assert.equal(rows[0].v, '1 张照片');
  assert.equal(rows[1].v, '1 道');
  assert.equal(rows[2].v, '1 座城市');
  assert.equal(rows[3].v, '1 家店');
});

test('statRows：没有评分时均分显示破折号', () => {
  const rows = statRows(computeStats([rec('a', { rating: 0 })]));
  assert.equal(rows[4].v, '—');
});

test('statRows：没有重复时第六行给一句话而不是空白', () => {
  const rows = statRows(computeStats([rec('a')]));
  assert.equal(rows[5].v, '无');
});

test('statRows：反复吃最多列三项', () => {
  const list = ['a', 'b', 'c', 'd'].flatMap((name) => [
    rec(`${name}1`, { eat: name }),
    rec(`${name}2`, { eat: name }),
  ]);
  const rows = statRows(computeStats(list));
  /* 三个菜名 + 三个次数，用顿号分隔 */
  const parts = rows[5].v.split('、');
  assert.equal(parts.length, 3);
});

test('statRows：五分那行带出第一道菜名', () => {
  const rows = statRows(computeStats([rec('a', { eat: '甜水面', rating: 5 })]));
  assert.equal(rows[1].n, '甜水面');
});

/* ---------------- 真实数据 ---------------- */

test('真实 12 条：统计数字与预置数据吻合', () => {
  const s = computeStats(REAL_RECORDS);
  assert.equal(s.total, 12);
  /* 预置数据里 5 分的有 7 条 */
  assert.equal(s.fiveCount, 7);
  /* 城市：成都/乐山/北京/上海/武汉/长沙/厦门 = 7，另有一条无城市 */
  assert.equal(s.cities, 7);
  /* 均分：40 / 12 ≈ 3.33（有几条 3 分） */
  assert.ok(s.avg > 3 && s.avg < 5, `均分异常：${s.avg}`);
});

/* ---------------- spotlightMeta ---------------- */

test('spotlightMeta：店、城市、几分、日期，段间只用 SEP', () => {
  const meta = spotlightMeta(rec('a', {
    shop: '马旺子川小馆',
    city: '成都',
    rating: 4,
    at: '2026-10-09T12:30',
  }));
  assert.equal(meta, ['马旺子川小馆', '成都', '4 分', '10.09'].join('\u00a0\u00a0'));
});

test('spotlightMeta：没店没城市时不留空段', () => {
  const meta = spotlightMeta(rec('a', { shop: null, city: null, rating: 3 }));
  assert.equal(meta, ['3 分', '10.09'].join('\u00a0\u00a0'));
  assert.ok(!meta.includes('undefined'));
});

test('spotlightMeta：没打分时写「未评」', () => {
  const meta = spotlightMeta(rec('a', { rating: 0 }));
  assert.ok(meta.includes('未评'));
});
