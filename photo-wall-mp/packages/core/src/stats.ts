/* ================================================================
   统计（纯函数）

   原型 photo-wall-h5 的「统计」是一张从底部升起的小纸，六行：
     拍过的 / 五分 / 去过 / 吃过 / 均分 / 反复吃
   每一行都是"数据 → 一句话"，没有表格、没有图表 ——
   它是背景信息，不该和照片抢注意力。

   抽成纯函数是为了能单测：这些数字一旦算错，用户不会发现，
   但"五分 3 道"和实际记录对不上会显得整面墙都不可信。
   ================================================================ */
import type { FoodRecord } from './types/domain.ts';
import { citiesInUse, mmdd } from './records.ts';

/** 统计的每一行 */
export interface StatRow {
  /** 左侧标签，如「拍过的」 */
  k: string;
  /** 右侧值，如「12 张照片」 */
  v: string;
  /** 附加说明（「五分」那行用来兜出是哪道菜） */
  n?: string;
}

/** 反复吃的一道：菜名 + 次数 */
export interface RepeatedDish {
  eat: string;
  count: number;
}

/** 手上有哪些数（浮层和测试都用这份，避免各算各的） */
export interface WallStats {
  total: number;
  /** 五分（rating === 5）的条数 */
  fiveCount: number;
  /** 第一条五分菜的名字，没有则空串 */
  firstFiveEat: string;
  cities: number;
  shops: number;
  /** 平均分，没有评分时为 0 */
  avg: number;
  /** 至少吃过两次的菜，按次数降序 */
  repeated: RepeatedDish[];
}

/**
 * 从记录算出一份统计。
 *
 * @param records 当前墙上的记录（已经过滤/排序过的那份）
 */
export function computeStats(records: FoodRecord[]): WallStats {
  const total = records.length;

  const fives = records.filter((r) => r.rating === 5);
  const fiveCount = fives.length;
  const firstFiveEat = fives.length ? fives[0].eat : '';

  const shops = new Set(records.map((r) => r.shop).filter(Boolean)).size;

  const avg = total ? records.reduce((sum, r) => sum + (r.rating || 0), 0) / total : 0;

  const counts = new Map<string, number>();
  records.forEach((r) => counts.set(r.eat, (counts.get(r.eat) || 0) + 1));
  const repeated: RepeatedDish[] = [...counts.entries()]
    .filter(([, n]) => n >= 2)
    .map(([eat, count]) => ({ eat, count }))
    .sort((a, b) => b.count - a.count || a.eat.localeCompare(b.eat, 'zh-Hans-CN'));

  return { total, fiveCount, firstFiveEat, cities: citiesInUse(records), shops, avg, repeated };
}

/**
 * 把统计排版成浮层里的六行文字。
 *
 * 文案与原型逐字一致：数字后面带自己的量词，读起来是句子而不是表格。
 */
export function statRows(stats: WallStats): StatRow[] {
  const { total, fiveCount, firstFiveEat, cities, shops, avg, repeated } = stats;

  return [
    { k: '拍过的', v: `${total} 张照片` },
    {
      k: '五分',
      v: `${fiveCount} 道`,
      /* 只兜第一道；浮层里放不下更多，也不是重点 */
      n: firstFiveEat,
    },
    { k: '去过', v: `${cities} 座城市` },
    { k: '吃过', v: `${shops} 家店` },
    { k: '均分', v: avg ? avg.toFixed(1) : '—' },
    {
      k: '反复吃',
      v: repeated.length
        ? repeated.slice(0, 3).map((r) => `${r.eat} ${r.count} 次`).join('、')
        : '无',
    },
  ];
}

/** 随机一道浮窗里的一行元信息：店 · 城市 · 几分 · 日期 */
export function spotlightMeta(r: FoodRecord): string {
  const bits: string[] = [];
  const place = [r.shop, r.city].filter(Boolean).join(' · ');
  if (place) bits.push(place);
  bits.push(r.rating ? `${r.rating} 分` : '未评');
  bits.push(mmdd(r.at));
  return bits.join(' · ');
}
