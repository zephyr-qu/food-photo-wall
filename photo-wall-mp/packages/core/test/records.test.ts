/* ================================================================
   records.ts 单测

   这层是"字符串 → 字符串"的工具集，看似琐碎，但 joinBits / parseAt / photoOf
   三处的行为直接决定界面文案和图片能不能出来，都值得钉住。
   ================================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PHOTO_MAP,
  SEP,
  FIELD_LIMITS,
  citiesInUse,
  countByCity,
  dateOf,
  hashOf,
  joinBits,
  overLength,
  parseAt,
  photoOf,
  rngOf,
  timeOf,
} from '../src/records.ts';
import { REAL_RECORDS, makeOlder } from '../src/demo.ts';

/* ---------------- 预置数据 ---------------- */

test('REAL_RECORDS：12 条，id 唯一，eat 都非空', () => {
  assert.equal(REAL_RECORDS.length, 12);
  assert.equal(new Set(REAL_RECORDS.map((r) => r.id)).size, 12);
  for (const r of REAL_RECORDS) {
    assert.ok(r.eat && r.eat.length > 0, `记录 ${r.id} 缺菜名`);
  }
});

test('REAL_RECORDS：日期格式统一为 YYYY-MM-DDTHH:mm（无时区）', () => {
  for (const r of REAL_RECORDS) {
    assert.match(r.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, `${r.id} 的 at 格式不对：${r.at}`);
  }
});

/* ---------------- 拼接 ---------------- */

test('joinBits：用不间断空格连接，不是普通空格', () => {
  const out = joinBits(['马旺子', '成都']);
  assert.equal(out, `马旺子${SEP}成都`);
  /* SEP 必须是 nbsp（U+00A0），普通空格在排版里会被折叠 */
  assert.ok(out.includes('\u00a0'), 'joinBits 用的不是 nbsp');
  assert.ok(!out.includes(' '), 'joinBits 混入了普通空格');
});

test('joinBits：过滤 null / undefined / 空串，保留 0', () => {
  assert.equal(joinBits([null, undefined, '', 'a']), 'a');
  assert.equal(joinBits([0, 'a']), `0${SEP}a`);
});

test('joinBits：全空时返回 fallback', () => {
  assert.equal(joinBits([null, ''], '没记店名'), '没记店名');
  assert.equal(joinBits([], ''), '');
});

/* ---------------- 日期 ---------------- */

test('dateOf：把 2026-10-09T12:30 变成 2026.10.09', () => {
  assert.equal(dateOf('2026-10-09T12:30'), '2026.10.09');
});

test('timeOf：取到 HH:mm', () => {
  assert.equal(timeOf('2026-10-09T12:30'), '12:30');
  assert.equal(timeOf('2026-10-09'), '');
});

test('parseAt：能解析本地时间串（iOS 兼容的关键点）', () => {
  const d = parseAt('2026-10-09T12:30');
  assert.ok(!Number.isNaN(d.getTime()), 'parseAt 返回了 Invalid Date');
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 9); // 0-based
  assert.equal(d.getDate(), 9);
});

test('parseAt：垃圾输入不炸，退回当前时间', () => {
  const d = parseAt('not-a-date');
  assert.ok(!Number.isNaN(d.getTime()));
});

/* ---------------- 照片 ---------------- */

test('photoOf：预置菜名走 PHOTO_MAP', () => {
  assert.equal(photoOf({ eat: '甜水面', photo: null }), PHOTO_MAP['甜水面']);
});

test('photoOf：用户自选照片优先于预置图', () => {
  assert.equal(photoOf({ eat: '甜水面', photo: 'wxfile://tmp_abc.jpg' }), 'wxfile://tmp_abc.jpg');
});

test('photoOf：未知菜名按哈希轮换，且结果稳定', () => {
  const a = photoOf({ eat: '没听过的菜', photo: null });
  const b = photoOf({ eat: '没听过的菜', photo: null });
  assert.equal(a, b, '同一菜名两次结果不一致');
  assert.ok(Object.values(PHOTO_MAP).includes(a), '回落的不是预置图');
});

/* ---------------- 哈希 / 伪随机 ---------------- */

test('hashOf：稳定且非负', () => {
  assert.equal(hashOf('abc'), hashOf('abc'));
  assert.notEqual(hashOf('abc'), hashOf('abd'));
  assert.ok(hashOf('anything') >= 0);
});

test('rngOf：同种子序列可复现，值域 [0,1)', () => {
  const s1 = rngOf(42);
  const s2 = rngOf(42);
  for (let i = 0; i < 5; i++) {
    const v = s1();
    assert.equal(v, s2(), '同种子的序列不一致');
    assert.ok(v >= 0 && v < 1, `随机值越界：${v}`);
  }
});

/* ---------------- 生成更早的记录 ---------------- */

test('makeOlder：条数对、日期递减、id 唯一', () => {
  const from = new Date(2026, 9, 9, 12, 0);
  const list = makeOlder(10, from);
  assert.equal(list.length, 10);
  for (let i = 1; i < list.length; i++) {
    assert.ok(
      parseAt(list[i].at).getTime() < parseAt(list[i - 1].at).getTime(),
      `第 ${i} 条不比前一条更早：${list[i].at} vs ${list[i - 1].at}`,
    );
  }
  assert.equal(new Set(list.map((r) => r.id)).size, 10);
});

test('makeOlder：评分落在 3-5，城市非空', () => {
  const list = makeOlder(20, new Date(2026, 9, 9));
  for (const r of list) {
    assert.ok(r.rating >= 3 && r.rating <= 5, `评分越界：${r.rating}`);
    assert.ok(r.city, '城市为空');
  }
});

/* ---------------- 字段长度上限 ---------------- */

test('FIELD_LIMITS：与后端 schemas.ts 的上限逐条一致', () => {
  /* 这几个数字必须与 server/src/lib/constants.ts 的 FIELD_LIMITS 一致。
     漂移的后果：前端能输入 → 能提交 → 被服务端 422 拒掉。 */
  assert.equal(FIELD_LIMITS.eat, 60);
  assert.equal(FIELD_LIMITS.shop, 80);
  assert.equal(FIELD_LIMITS.city, 40);
  assert.equal(FIELD_LIMITS.district, 40);
  assert.equal(FIELD_LIMITS.note, 200);
});

test('overLength：正好等于上限不算超长', () => {
  assert.equal(overLength('eat', '甜'.repeat(60)), 0);
  assert.equal(overLength('shop', '店'.repeat(80)), 0);
  assert.equal(overLength('note', '备'.repeat(200)), 0);
});

test('overLength：超长时给出超出的字符数', () => {
  assert.equal(overLength('eat', '甜'.repeat(61)), 1);
  assert.equal(overLength('eat', '甜'.repeat(70)), 10);
  assert.equal(overLength('shop', '店'.repeat(81)), 1);
});

test('overLength：按 trim 后的长度算（与服务端 POST 同口径）', () => {
  /* 首尾空白不算「占额度」：服务端 nullableText 先 trim 再判长度。
     不 trim 的话，前端会误报「超长」，用户却什么都没多写。 */
  assert.equal(overLength('eat', `  ${'甜'.repeat(60)}  `), 0);
  assert.equal(overLength('eat', `  ${'甜'.repeat(61)}  `), 1);
});

test('overLength：空值与 null 不算超长', () => {
  assert.equal(overLength('shop', ''), 0);
  assert.equal(overLength('shop', null), 0);
  assert.equal(overLength('shop', undefined), 0);
});

/* ---------------- 统计 ---------------- */

test('countByCity：按数量降序，未记城市用空串作 key', () => {
  const list = [
    { id: '1', eat: 'a', city: '成都', rating: 4, at: '2026-10-01T10:00' },
    { id: '2', eat: 'b', city: '成都', rating: 4, at: '2026-10-02T10:00' },
    { id: '3', eat: 'c', city: null, rating: 4, at: '2026-10-03T10:00' },
  ] as never[];
  const rows = countByCity(list);
  assert.deepEqual(rows[0], ['成都', 2]);
  assert.ok(rows.some(([city]) => city === ''));
});

test('citiesInUse：不把空城市算进去', () => {
  const list = [
    { id: '1', eat: 'a', city: '成都', rating: 4, at: '2026-10-01T10:00' },
    { id: '2', eat: 'b', city: null, rating: 4, at: '2026-10-02T10:00' },
  ] as never[];
  assert.equal(citiesInUse(list), 1);
});
