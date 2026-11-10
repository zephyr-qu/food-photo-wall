/* ================================================================
   `src/pages/compose/helpers.ts` 的单元测试。

   这些判定以前长在 900 行的组件里，错法都是"不报错、但结果不对"：
   日期减一天跨月、未来时间没拦住（提交后吃 422）、编辑老记录丢原照片 id
   （保存即清空照片）、未保存判定在加载中就弹框。现在逐条钉住。
   ================================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { FoodRecord } from '@photo-wall/core';

import {
  appendPicked,
  collectTooLong,
  firstTooLongText,
  formatDateForDisplay,
  isFormDirty,
  isFutureMinute,
  isNowMinute,
  nextKey,
  pickedFromRecord,
  removeByKey,
  shiftDate,
} from '../src/pages/compose/helpers.ts';

function rec(over: Partial<FoodRecord> & { id: string; at: string }): FoodRecord {
  return { eat: '菜', rating: 0, ...over } as FoodRecord;
}

/* ---------------- 长度校验 ---------------- */

test('collectTooLong：按 core 的上限逐字段报，文案带上限与超出字数', () => {
  const bad = collectTooLong({ eat: 'a'.repeat(61), shop: 'ok', city: 'b'.repeat(41), note: '' });
  assert.deepEqual(Object.keys(bad).sort(), ['city', 'eat']);
  assert.match(String(bad.eat), /最多 60 个字（超了 1 个）/);
  assert.match(String(bad.city), /最多 40 个字/);
});

test('collectTooLong：正好等于上限不算超（边界不能差一）', () => {
  assert.deepEqual(collectTooLong({ eat: 'a'.repeat(60), shop: '', city: '', note: '' }), {});
});

test('collectTooLong：空白与 null 都不算超长（trim 后判）', () => {
  assert.deepEqual(collectTooLong({ eat: '   ', shop: null, city: undefined, note: '' }), {});
});

test('firstTooLongText：有则取第一条文案，无则兜底', () => {
  assert.equal(firstTooLongText({ eat: '吃了什么最多 60 个字' }), '吃了什么最多 60 个字');
  assert.equal(firstTooLongText({}), '内容太长了');
});

/* ---------------- 日期 ---------------- */

test('shiftDate：跨月、跨年、闰年都对（用 UTC 算，不吃本地时区）', () => {
  assert.equal(shiftDate('2026-03-01', -1), '2026-02-28');
  assert.equal(shiftDate('2026-01-01', -1), '2025-12-31');
  assert.equal(shiftDate('2026-12-31', 1), '2027-01-01');
  assert.equal(shiftDate('2024-02-28', 1), '2024-02-29');
  assert.equal(shiftDate('2026-10-09', 0), '2026-10-09');
});

test('formatDateForDisplay：今天 / 昨天 / 同年 / 跨年', () => {
  const today = '2026-10-09';
  assert.equal(formatDateForDisplay('2026-10-09', today), '今天');
  assert.equal(formatDateForDisplay('2026-10-08', today), '昨天');
  assert.equal(formatDateForDisplay('2026-03-01', today), '3 月 1 日');
  assert.equal(formatDateForDisplay('2025-12-28', today), '2025 年 12 月 28 日');
});

test('formatDateForDisplay：跨年的"昨天"仍叫昨天，不退回完整日期', () => {
  /* 站在 2026-01-01 看 2025-12-31：它就是昨天。
     退回「2025 年 12 月 31 日」是更啰嗦也更难扫的信息，所以实现优先判昨天。 */
  assert.equal(formatDateForDisplay('2025-12-31', '2026-01-01'), '昨天');
  /* 前天则必须补年份 —— 否则「12 月 30 日」会让人以为是今年的。 */
  assert.equal(formatDateForDisplay('2025-12-30', '2026-01-01'), '2025 年 12 月 30 日');
});

/* ---------------- 时间比较 ---------------- */

test('isNowMinute：同一分钟为真，差一分钟为假', () => {
  const now = '2026-10-09T12:30';
  assert.equal(isNowMinute({ date: '2026-10-09', time: '12:30' }, now), true);
  assert.equal(isNowMinute({ date: '2026-10-09', time: '12:31' }, now), false);
  assert.equal(isNowMinute({ date: '2026-10-08', time: '12:30' }, now), false);
});

test('isFutureMinute：未来拦、现在和过去放行（服务端会拒未来时间）', () => {
  const now = '2026-10-09T12:30';
  assert.equal(isFutureMinute({ date: '2026-10-09', time: '12:29' }, now), false);
  assert.equal(isFutureMinute({ date: '2026-10-09', time: '12:30' }, now), false);
  assert.equal(isFutureMinute({ date: '2026-10-09', time: '12:31' }, now), true);
  /* 跨天也要拦住 —— 以前按"时:分"比，23:59 之后选次日 00:01 会漏 */
  assert.equal(isFutureMinute({ date: '2026-10-10', time: '00:01' }, now), true);
  assert.equal(isFutureMinute({ date: '2026-10-08', time: '23:59' }, now), false);
});

/* ---------------- 照片回填 ---------------- */

test('pickedFromRecord：多图按顺序回填，photoIds 逐位对应', () => {
  const out = pickedFromRecord(
    rec({ id: 'r1', at: '2026-10-09T12:30', photos: ['p1', 'p2'], photoIds: ['ph1', null] }),
  );
  assert.deepEqual(
    out.map((p) => [p.path, p.id]),
    [
      ['p1', 'ph1'],
      ['p2', null],
    ],
  );
});

test('pickedFromRecord：老服务端只有单张 photo 时，id 取 photoIds[0]（丢了会清空原照片）', () => {
  const out = pickedFromRecord(
    rec({ id: 'r2', at: '2026-10-09T12:30', photo: 'legacy.jpg', photoIds: ['ph9'] }),
  );
  assert.deepEqual(
    out.map((p) => [p.path, p.id]),
    [['legacy.jpg', 'ph9']],
  );
});

test('pickedFromRecord：没有照片时返回空数组（页面显示"贴上照片"占位）', () => {
  assert.deepEqual(pickedFromRecord(rec({ id: 'r3', at: '2026-10-09T12:30' })), []);
  assert.deepEqual(pickedFromRecord(rec({ id: 'r4', at: '2026-10-09T12:30', photos: [] })), []);
});

test('nextKey：同一路径两次得到不同的 key（同一张图可以选两次）', () => {
  const a = nextKey('/tmp/x.jpg');
  const b = nextKey('/tmp/x.jpg');
  assert.notEqual(a, b);
  assert.ok(a.startsWith('/tmp/x.jpg'));
});

/* ---------------- 未保存判定 ---------------- */

const INIT = {
  eat: '担担面',
  shop: '老店',
  city: '成都',
  note: '',
  rating: 3,
  at: { date: '2026-10-09', time: '12:30' },
  paths: ['p1'],
};

test('isFormDirty：编辑态还没回填（init=null）不算改过，否则一进页就弹拦截', () => {
  assert.equal(isFormDirty(true, INIT, null), false);
});

test('isFormDirty：编辑态与原值一致不算改过', () => {
  assert.equal(isFormDirty(true, { ...INIT }, { ...INIT }), false);
});

test('isFormDirty：编辑态任一字段（含时间、照片顺序）变了就算改过', () => {
  assert.equal(isFormDirty(true, { ...INIT, eat: '甜水面' }, INIT), true);
  assert.equal(isFormDirty(true, { ...INIT, rating: 4 }, INIT), true);
  assert.equal(
    isFormDirty(true, { ...INIT, at: { date: '2026-10-09', time: '12:31' } }, INIT),
    true,
  );
  assert.equal(isFormDirty(true, { ...INIT, paths: [] }, INIT), true);
});

test('isFormDirty：新建态空表单不算改过，填了字/评了分/选了图才算', () => {
  const empty = {
    eat: '',
    shop: '',
    city: '',
    note: '',
    rating: 0,
    at: { date: '2026-10-09', time: '12:30' },
    paths: [] as string[],
  };
  assert.equal(isFormDirty(false, empty, null), false);
  assert.equal(isFormDirty(false, { ...empty, eat: '  ' }, null), false);
  assert.equal(isFormDirty(false, { ...empty, eat: '面' }, null), true);
  assert.equal(isFormDirty(false, { ...empty, rating: 5 }, null), true);
  assert.equal(isFormDirty(false, { ...empty, paths: ['p'] }, null), true);
});

/* ---------------- 槽位增删 ---------------- */

const slot = (path: string, id: string | null = null) => ({ key: nextKey(path), path, id });

test('appendPicked：追加时按剩余槽位截断，超出的路径不进列表', () => {
  const prev = [slot('a'), slot('b'), slot('c')];
  const out = appendPicked(prev, ['d', 'e', 'f', 'g'], 5);
  assert.deepEqual(
    out.map((p) => p.path),
    ['a', 'b', 'c', 'd', 'e'],
  );
  assert.deepEqual(
    out.map((p) => p.id),
    [null, null, null, null, null],
  );
});

test('appendPicked：已满 / 空输入时原样返回同一个数组引用（不制造重渲染）', () => {
  const full = [slot('a'), slot('b'), slot('c'), slot('d'), slot('e')];
  assert.equal(appendPicked(full, ['f'], 5), full);
  const prev = [slot('a')];
  assert.equal(appendPicked(prev, [], 5), prev);
});

test('appendPicked：同一路径选两次得到两个不同 key（React 列表不能撞 key）', () => {
  const out = appendPicked([], ['/tmp/x.jpg', '/tmp/x.jpg'], 5);
  assert.equal(out.length, 2);
  assert.notEqual(out[0].key, out[1].key);
});

test('removeByKey：只删命中那张，其余顺序不变；没命中时引用不变', () => {
  const prev = [slot('a'), slot('b'), slot('c')];
  const out = removeByKey(prev, prev[1].key);
  assert.deepEqual(
    out.map((p) => p.path),
    ['a', 'c'],
  );
  assert.equal(removeByKey(prev, '不存在的 key'), prev);
});
