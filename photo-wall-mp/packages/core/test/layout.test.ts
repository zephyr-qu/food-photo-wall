/* ================================================================
   layout.ts 单测

   这一层是"数据 → 坐标"的纯函数，也是整个项目最容易出视觉 bug 的地方。

   ⚠ 重要前提：算法与 H5 原型 photo-wall-h5/src/data/layout.js 逐字一致，
   测试的目的是**守住这个一致性**，而不是重新设计块型节奏。
   曾经有一版把这里改成 "band 打包" 来消除按月视图的组尾空洞，
   结果连带改掉了默认视图（日期关的连续墙）的观感 —— 已被回退。
   想改块型节奏，先对照原型截图，再改这里的断言。
   ================================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  COL,
  DIM,
  GAP,
  GROUP_GAP,
  HEAD_H,
  UNIT,
  WALL_W,
  layoutGroup,
  layoutWall,
  spanFor,
  visibleRecords,
} from '../src/layout.ts';
import type { FoodRecord, LayoutTile, TileSpan } from '../src/types/domain.ts';

/** 造一条最小可用的记录 */
function rec(id: string, rating = 4, at = '2026-10-09T12:30', city: string | null = '成都'): FoodRecord {
  return { id, eat: id, shop: null, city, district: null, rating, at, note: null, photo: null };
}

/** 造 n 条同月记录，评分按数组循环 */
function recs(n: number, ratings: number[] = [4]): FoodRecord[] {
  return Array.from({ length: n }, (_, i) =>
    rec(`r${i}`, ratings[i % ratings.length], `2026-10-${String((i % 28) + 1).padStart(2, '0')}T12:00`),
  );
}

/** 把 tile 展开成"被占用的格子"集合（单位：列 × 行） */
function occupied(tiles: LayoutTile[], headH = HEAD_H): Set<string> {
  const set = new Set<string>();
  for (const t of tiles) {
    const cols = Math.round((t.w + GAP) / (COL + GAP));
    const rows = Math.round((t.h + GAP) / (UNIT + GAP));
    const x = Math.round(t.x / (COL + GAP));
    const y = Math.round((t.y - headH) / (UNIT + GAP));
    for (let dx = 0; dx < cols; dx++) {
      for (let dy = 0; dy < rows; dy++) set.add(`${x + dx},${y + dy}`);
    }
  }
  return set;
}

/** 一组铺完后的空洞（含右下方"没被任何块覆盖"的格子） */
function holes(tiles: LayoutTile[], headH = HEAD_H): string[] {
  const set = occupied(tiles, headH);
  let maxRow = 0;
  for (const cell of set) maxRow = Math.max(maxRow, Number(cell.split(',')[1]) + 1);
  const out: string[] = [];
  for (let x = 0; x < 4; x++) {
    for (let y = 0; y < maxRow; y++) {
      if (!set.has(`${x},${y}`)) out.push(`${x},${y}`);
    }
  }
  return out;
}

/* ---------------- 常量自洽 ---------------- */

test('常量：4 列 + 3 个间距正好等于墙宽', () => {
  assert.equal(Math.round(COL * 4 + GAP * 3), WALL_W);
});

test('常量：单格高比单列略高（3:3.5 的图片感）', () => {
  assert.ok(UNIT > COL, `UNIT(${UNIT}) 应大于 COL(${COL})`);
});

test('DIM：只有原型那四种块型，没有 full', () => {
  assert.deepEqual(Object.keys(DIM).sort(), ['hero', 'small', 'tall', 'wide']);
  assert.deepEqual(DIM.hero, { c: 2, r: 2 });
  assert.deepEqual(DIM.wide, { c: 2, r: 1 });
  assert.deepEqual(DIM.tall, { c: 1, r: 2 });
  assert.deepEqual(DIM.small, { c: 1, r: 1 });
});

/* ---------------- 块型节奏：与原型逐字一致 ---------------- */

test('spanFor：第 3 行返回 big（注释写 2+2，代码实际是三条 big）', () => {
  const five = rec('x', 5);     // 5 分 → big = hero (2×2)
  const four = rec('y', 4);     // 4 分 → big = wide (2×1)

  /* 第 1 行：col0 拿 big，其余 small → 2+1+1 = 4 列 */
  assert.equal(spanFor(five, 0), 'hero');
  assert.equal(spanFor(five, 1), 'small');
  assert.equal(spanFor(five, 2), 'small');
  /* 第 2 行：只有 col2 拿 big → 1+1+2 = 4 列 */
  assert.equal(spanFor(five, 3), 'small');
  assert.equal(spanFor(five, 4), 'small');
  assert.equal(spanFor(five, 5), 'hero');
  /* 第 3 行：三条都拿 big。
     ⚠ 原型注释写的是"2 列 + 2 列"，但代码 `return big` 让三条都变大块，
     合计 6 列 > 4 列，**必然溢出**。这是原型自身的 bug（注释与代码不符），
     这里照实记录，避免有人按注释去"修正"。
     影响：第 3 行的块只能靠填最矮列硬塞，是空洞的来源之一。 */
  assert.equal(spanFor(four, 6), 'wide');
  assert.equal(spanFor(four, 7), 'wide');
  assert.equal(spanFor(four, 8), 'wide');
  /* 回到第 1 行 */
  assert.equal(spanFor(five, 9), 'hero');
});

test('spanFor：5 分给 2×2、非 5 分给 2×1', () => {
  assert.equal(spanFor(rec('a', 5), 0), 'hero');
  assert.equal(spanFor(rec('a', 4), 0), 'wide');
  assert.equal(spanFor(rec('a', 3), 0), 'wide');
  assert.equal(spanFor(rec('a', 0), 0), 'wide');
});

test('spanFor：第 1、2 行的 3 条正好铺满 4 列；第 3 行溢出到 6 列', () => {
  /* 第 1、2 行（index 0-5）：一轮正好 4 列 */
  for (const rating of [5, 4, 3, 1]) {
    for (const start of [0, 3]) {
      let width = 0;
      for (let i = start; i < start + 3; i += 1) {
        width += DIM[spanFor(rec('x', rating), i)].c;
      }
      assert.equal(width, 4, `rating=${rating} 第 ${start / 3 + 1} 行 3 条的列宽和是 ${width}`);
    }
  }
  /* 第 3 行（index 6-8）：三条 big，宽 6 列 —— 溢出的既定事实 */
  for (const rating of [5, 4]) {
    let width = 0;
    for (let i = 6; i < 9; i += 1) {
      width += DIM[spanFor(rec('x', rating), i)].c;
    }
    assert.equal(width, 6, `rating=${rating} 第 3 行的列宽和应为 6（溢出），实得 ${width}`);
  }
});

/* ---------------- 默认视图（日期关）：必须无洞 ---------------- */

test('默认视图：真实 12 条数据（日期关）无洞 —— 这是用户默认看到的画面', () => {
  const eats = ['甜水面', '冰粉', '跷脚牛肉', '钵钵鸡', '北京烤鸭', '番茄牛腩',
    '蛋烘糕', '生煎包', '豆汁儿', '热干面', '糖油粑粑', '沙茶面'];
  const ratings = [5, 4, 5, 4, 5, 4, 3, 5, 3, 5, 5, 5];
  const list = eats.map((eat, i) => rec(eat, ratings[i]));
  const { tiles, height } = layoutGroup(list, 0);
  assert.equal(tiles.length, 12);
  assert.deepEqual(holes(tiles, 0), [], '默认视图出现空洞');
  assert.ok(height > 0);
});

test('默认视图：块型分布与原型一致（hero 3 / wide 3 / small 6，无 tall）', () => {
  const ratings = [5, 4, 5, 4, 5, 4, 3, 5, 3, 5, 5, 5];
  const list = ratings.map((r, i) => rec(`r${i}`, r));
  const { tiles } = layoutGroup(list, 0);
  const count: Record<string, number> = {};
  for (const t of tiles) count[t.span] = (count[t.span] || 0) + 1;
  assert.deepEqual(count, { hero: 3, small: 6, wide: 3 });
  assert.equal(count.tall, undefined, '默认视图不应该出现 tall 竖块');
});

/* ---------------- 按月视图：已知局限（不追求无洞） ---------------- */

test('按月视图：组尾会因为条数不是 3 的倍数而留洞（已知取舍，非 bug）', () => {
  /* 这一条是把"现状"钉住，防止有人以为它是 bug 又去改算法。
     真正要改的话，必须同时确认默认视图观感不变。 */
  for (const n of [5, 4, 2, 1]) {
    const list = recs(n, [5, 4, 3]);
    const { tiles } = layoutGroup(list, HEAD_H);
    assert.equal(tiles.length, n);
  }
  const three = layoutGroup(recs(3, [4]), HEAD_H);
  assert.deepEqual(holes(three.tiles), [], '3 条的组应该无洞');
});

/* ---------------- 坐标合法性 ---------------- */

test('layoutGroup：tile 坐标不越界（不出墙）', () => {
  for (let n = 1; n <= 16; n++) {
    const { tiles } = layoutGroup(recs(n, [5, 4]), HEAD_H);
    for (const t of tiles) {
      assert.ok(t.x >= 0, `x 为负：${t.x}`);
      assert.ok(t.x + t.w <= WALL_W, `右侧越界：x=${t.x} w=${t.w}`);
    }
  }
});

test('layoutGroup：x/y 按 COL/UNIT 对齐到网格', () => {
  const { tiles } = layoutGroup(recs(9, [5, 4, 3]), HEAD_H);
  for (const t of tiles) {
    assert.equal(t.x % (COL + GAP), 0, `x 未对齐：${t.x}`);
    assert.equal((t.y - HEAD_H) % (UNIT + GAP), 0, `y 未对齐：${t.y}（headH=${HEAD_H}）`);
  }
});

test('layoutGroup：高度等于最后一行底边', () => {
  for (let n = 1; n <= 12; n++) {
    const { tiles, height } = layoutGroup(recs(n, [5, 4]), HEAD_H);
    const bottom = Math.max(...tiles.map((t) => t.y + t.h));
    assert.ok(height >= bottom, `height(${height}) 小于内容底边(${bottom})`);
    assert.ok(height - bottom < UNIT + GAP, `height(${height}) 与内容底边(${bottom}) 差距过大，尾部有空白`);
  }
});

test('layoutGroup：只产出 DIM 里定义过的块型', () => {
  const allowed: TileSpan[] = ['hero', 'wide', 'tall', 'small'];
  for (let n = 1; n <= 12; n++) {
    const { tiles } = layoutGroup(recs(n, [5, 4, 3]), HEAD_H);
    for (const t of tiles) assert.ok(allowed.includes(t.span), `未知 span: ${t.span}`);
  }
});

/* ---------------- 整墙布局 ---------------- */

test('layoutWall(showDate=false)：只有一个无标题段', () => {
  const { sections, totalHeight } = layoutWall(recs(12), false);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].key, null);
  assert.equal(sections[0].top, 0);
  assert.equal(totalHeight, sections[0].height);
});

test('layoutWall(showDate=true)：按月切段，每段都有 key 和 count', () => {
  const list = [
    rec('a', 5, '2026-10-09T12:30'),
    rec('b', 4, '2026-10-01T12:30'),
    rec('c', 3, '2026-09-21T12:30'),
  ];
  const { sections } = layoutWall(list, true);
  assert.equal(sections.length, 2);
  assert.equal(sections[0].key, '2026-10');
  assert.equal(sections[0].count, 2);
  assert.equal(sections[1].key, '2026-09');
  assert.equal(sections[1].count, 1);
});

test('layoutWall：段与段之间恰好留 GROUP_GAP，且 totalHeight 不含尾部空白', () => {
  const list = [
    rec('a', 5, '2026-10-09T12:30'),
    rec('b', 4, '2026-09-21T12:30'),
    rec('c', 3, '2026-08-21T12:30'),
  ];
  const { sections, totalHeight } = layoutWall(list, true);
  assert.equal(sections.length, 3);

  for (let i = 1; i < sections.length; i++) {
    const gap = sections[i].top - (sections[i - 1].top + sections[i - 1].height);
    assert.equal(gap, GROUP_GAP, `第 ${i} 段前的间距是 ${gap}，应为 ${GROUP_GAP}`);
  }

  const last = sections[sections.length - 1];
  assert.equal(totalHeight, last.top + last.height);
});

test('layoutWall：空列表不炸，totalHeight 为 0', () => {
  const { sections, totalHeight } = layoutWall([], true);
  assert.equal(sections.length, 0);
  assert.equal(totalHeight, 0);
});

/* ---------------- 过滤 + 排序 ---------------- */

test('visibleRecords：按时间倒序', () => {
  const list = [
    rec('old', 4, '2026-01-01T10:00'),
    rec('new', 4, '2026-12-01T10:00'),
    rec('mid', 4, '2026-06-01T10:00'),
  ];
  assert.deepEqual(visibleRecords(list, null).map((r) => r.id), ['new', 'mid', 'old']);
});

test('visibleRecords：filterCity=null 表示不过滤（含未记城市的记录）', () => {
  const list = [rec('a', 4, '2026-10-01T10:00', '成都'), rec('b', 4, '2026-10-02T10:00', null)];
  assert.equal(visibleRecords(list, null).length, 2);
});

test('visibleRecords：空串筛选出"未记城市"的记录', () => {
  const list = [rec('a', 4, '2026-10-01T10:00', '成都'), rec('b', 4, '2026-10-02T10:00', null)];
  const got = visibleRecords(list, '');
  assert.equal(got.length, 1);
  assert.equal(got[0].id, 'b');
});

test('visibleRecords：不修改入参数组（返回副本）', () => {
  const list = [rec('a', 4, '2026-01-01T10:00'), rec('b', 4, '2026-12-01T10:00')];
  const snapshot = list.map((r) => r.id);
  visibleRecords(list, null);
  assert.deepEqual(list.map((r) => r.id), snapshot);
});
