/* ================================================================
   布局：4 列 masonry（填最矮列）
   把「数据 → 坐标」抽成纯函数，React 只负责渲染 —— 这样布局可单测，
   也不会因为组件重渲染而跳位。

   ⚠ 单位是 rpx（小程序标准），不是 px。
   Taro 的 designWidth=750，即 750rpx = 屏宽。
   设计稿按 390px 宽做的，所以 px → rpx 的换算是 ×(750/390) ≈ ×1.923。
   下面所有常量都已经是 rpx。

   ---------- 算法与原型 photo-wall-h5/src/data/layout.js 保持一致 ----------
   这一层是从 H5 原型逐字翻译过来的，**不要再自创块型节奏**。
   默认视图（showDate=false）是一整面连续的墙，12 条记录用 3 行一循环的
   块型节奏正好铺满 4 列，实测空洞数为 0。

   已知局限（原型同样存在，属设计取舍而非 bug）：
   打开「按月」后每组记录数是 5/4/2/1 条，不是 3 的倍数，
   组尾会出现少量空洞（4 条那组 1 个、2 条组 3 个、1 条组 4 个）。
   这是"墙的错落"换来的代价；要修它必须改块型节奏，
   而那会连带改掉默认视图的观感 —— 所以保持与原型一致。
   ================================================================ */
import type {
  FoodRecord,
  LayoutTile,
  TileSpan,
  WallLayout,
  WallSection,
} from './types/domain';

/* 页面左右各留 32rpx（16px），墙宽 = 750 - 2×32 = 686rpx。
   墙的左右边缘因此和顶栏、月份标题、底部按钮完全对齐到同一条竖线 ——
   这是整页唯一的对齐基准，别再为某一处单独加 padding。 */
export const WALL_W: number = 686;
export const GAP: number = 10;                              // 块间距：5px
export const COL: number = (WALL_W - GAP * 3) / 4;           // 单列宽：164rpx
export const UNIT: number = Math.round(COL * 1.16);          // 单格高：≈190rpx
export const HEAD_H: number = 64;                            // 月份标题带高
export const GROUP_GAP: number = 40;                         // 组与组之间

/** 块型尺寸：占几列几行 */
interface TileDim {
  c: number;
  r: number;
}

export const DIM: Record<TileSpan, TileDim> = {
  hero: { c: 2, r: 2 },
  wide: { c: 2, r: 1 },
  tall: { c: 1, r: 2 },
  small: { c: 1, r: 1 },
};

/**
 * 块型节奏：既要"墙"的错落，又不能让 4 列留洞。
 * 每 3 行一循环，每种循环都正好铺满 4 列：
 *   第 1 行：2 列 + 1 列 + 1 列
 *   第 2 行：1 列 + 1 列 + 2 列
 *   第 3 行：2 列 + 2 列
 * 5 分的那道尽量给 hero（2×2），让高分菜有分量。
 *
 * ⚠ 与原型逐字一致。改这里会同时改变默认视图的观感，先对照截图再动。
 */
export function spanFor(record: FoodRecord, index: number): TileSpan {
  const row = Math.floor(index / 3) % 3;
  const col = index % 3;
  const big: TileSpan = record.rating === 5 ? 'hero' : 'wide';
  if (row === 0) return col === 0 ? big : 'small';
  if (row === 1) return col === 2 ? big : 'small';
  return big;
}

/** 候选落位 */
interface BestSlot {
  c: number;
  top: number;
}

/**
 * 给一组记录算绝对坐标（rpx）。
 * @param records 已排序的记录
 * @param headH   这一组顶部要留的高度（月份标题）
 */
export function layoutGroup(
  records: FoodRecord[],
  headH = 0,
): { tiles: LayoutTile[]; height: number } {
  const cols: number[] = [0, 0, 0, 0];
  const tiles: LayoutTile[] = [];
  let maxUnit = 0;

  records.forEach((record, index) => {
    const span = spanFor(record, index);
    const d = DIM[span] || DIM.wide;

    // 找一个能放下的位置：优先两列高度相同的地方（跨列块不会被切断）
    let best: BestSlot | null = null;
    for (let c = 0; c + d.c <= 4; c++) {
      let mx = 0;
      let mn = Infinity;
      for (let k = c; k < c + d.c; k++) {
        if (cols[k] > mx) mx = cols[k];
        if (cols[k] < mn) mn = cols[k];
      }
      if (mx !== mn) continue;
      if (!best || mx < best.top || (mx === best.top && c < best.c)) {
        best = { c, top: mx };
      }
    }
    // 放不下就退而求其次：放到最矮的位置（可能出现小洞，但不会丢块）
    if (!best) {
      let c2 = 0;
      let top2 = Infinity;
      for (let c = 0; c + d.c <= 4; c++) {
        let mx = 0;
        for (let k = c; k < c + d.c; k++) if (cols[k] > mx) mx = cols[k];
        if (mx < top2) { top2 = mx; c2 = c; }
      }
      best = { c: c2, top: top2 };
    }

    const y = best.top;
    for (let k = best.c; k < best.c + d.c; k++) cols[k] = y + d.r;
    if (y + d.r > maxUnit) maxUnit = y + d.r;

    tiles.push({
      record,
      span,
      x: Math.round(best.c * (COL + GAP)),
      y: Math.round(headH + y * (UNIT + GAP)),
      w: Math.round(d.c * COL + (d.c - 1) * GAP),
      h: Math.round(d.r * UNIT + (d.r - 1) * GAP),
    });
  });

  return { tiles, height: Math.round(headH + maxUnit * (UNIT + GAP)) };
}

/**
 * 整面墙的布局。
 * showDate=true 时按月切组、插标题行；false 时是一整面连续的墙。
 */
export function layoutWall(records: FoodRecord[], showDate: boolean): WallLayout {
  const sections: WallSection[] = [];
  let top = 0;

  if (showDate) {
    // 按月分组（记录已按时间倒序，所以直接顺序扫）
    interface MonthGroup {
      key: string;
      rows: FoodRecord[];
    }
    const groups: MonthGroup[] = [];
    const map = new Map<string, MonthGroup>();
    records.forEach((r) => {
      const k = r.at.slice(0, 7);
      if (!map.has(k)) {
        const g: MonthGroup = { key: k, rows: [] };
        map.set(k, g);
        groups.push(g);
      }
      map.get(k)!.rows.push(r);
    });

    groups.forEach((g, index) => {
      const { tiles, height } = layoutGroup(g.rows, HEAD_H);
      sections.push({
        key: g.key,
        label: g.key,
        count: g.rows.length,
        tiles,
        height,
        top,
      });
      /* 组间留白：最后一段不留，否则 totalHeight 尾部会多出一段空白 */
      top += height + (index < groups.length - 1 ? GROUP_GAP : 0);
    });
  } else {
    const { tiles, height } = layoutGroup(records, 0);
    sections.push({ key: null, tiles, height, top: 0 });
    top = height;
  }

  return { sections, totalHeight: Math.max(0, top) };
}

/** 过滤 + 排序：唯一的"一切从哪来"入口 */
export function visibleRecords(
  records: FoodRecord[],
  filterCity: string | null,
): FoodRecord[] {
  let list = records;
  if (filterCity !== null) {
    list = list.filter((r) => (r.city || '') === filterCity);
  }
  return list.slice().sort((a, b) => b.at.localeCompare(a.at));
}
