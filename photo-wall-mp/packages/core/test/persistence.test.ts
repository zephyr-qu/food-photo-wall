/* ================================================================
   persistence.ts 单测

   这一条断言对应一个真实 bug：readStored 曾经写成
     if (Array.isArray(raw) && raw.length) return raw
   于是用户把 12 条记录全删光（落盘 []）之后，冷启动会判定"没数据"，
   回落到预置数据 —— 删除被静默撤销。空数组是**合法状态**，不是缺失。
   ================================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveInitialRecords } from '../src/persistence.ts';
import type { FoodRecord } from '../src/types/domain.ts';

const preset: readonly FoodRecord[] = [
  { id: 'p1', eat: '甜水面', shop: null, city: '成都', district: null, rating: 5, at: '2026-10-09T12:30', note: null, photo: null },
  { id: 'p2', eat: '冰粉', shop: null, city: '成都', district: null, rating: 4, at: '2026-10-09T13:10', note: null, photo: null },
];

test('storage 里是空数组 → 认这个空数组（删光后不能复活预置数据）', () => {
  assert.deepEqual(resolveInitialRecords([], preset), []);
});

test('storage 里是正常数组 → 原样返回', () => {
  const stored: FoodRecord[] = [
    { id: 'u1', eat: '自己加的', shop: null, city: null, district: null, rating: 3, at: '2026-10-10T10:00', note: null, photo: null },
  ];
  assert.deepEqual(resolveInitialRecords(stored, preset).map((r) => r.id), ['u1']);
});

test('storage 为 undefined（首次进入）→ 回落预置数据', () => {
  assert.deepEqual(resolveInitialRecords(undefined, preset).map((r) => r.id), ['p1', 'p2']);
});

test('storage 为 null → 回落预置数据', () => {
  assert.deepEqual(resolveInitialRecords(null, preset).map((r) => r.id), ['p1', 'p2']);
});

test('storage 被写坏成字符串/对象 → 回落预置数据，不炸', () => {
  assert.deepEqual(resolveInitialRecords('{"broken":true}', preset).length, 2);
  assert.deepEqual(resolveInitialRecords({ oops: 1 }, preset).length, 2);
});

test('回落的预置数据是副本，改它不会污染常量', () => {
  const got = resolveInitialRecords(undefined, preset);
  got[0].eat = '被改过了';
  assert.equal(preset[0].eat, '甜水面');
});
