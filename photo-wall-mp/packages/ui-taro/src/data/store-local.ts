/* ================================================================
   本地模式（不连后端）用的**纯函数**：筛选、城市计数、统计、月份分桶。

   它们和 `packages/core` 里的同名单源是两回事：core 是"契约形状"的纯逻辑，
   这里是"本地 12 条示例数据 + 用户本地新增"的本地实现。刻意写成纯函数（不读
   wall、不读 storage），这样能直接单元测试 —— `test/store-local.test.ts`。
   ================================================================ */
import { groupCitiesByProvince } from '@photo-wall/core';
import type { FoodRecord } from '@photo-wall/core';
import type { ApiCityCounts, ApiMonth, ApiStats } from '../api/types';

/** 把筛选态翻译成接口参数（null=全部 / ''=未记 / 名字=精确） */
export function cityQuery(filterCity: string | null): { city?: string; cityMissing?: boolean } {
  if (filterCity === null) return {};
  if (filterCity === '') return { cityMissing: true };
  return { city: filterCity };
}

/** 本地模式下按筛选过滤（与 core.visibleRecords 同语义） */
export function localFilter(list: FoodRecord[], filterCity: string | null): FoodRecord[] {
  const out =
    filterCity === null ? list : list.filter((r) => (r.city || '') === filterCity);
  return out.slice().sort((a, b) => b.at.localeCompare(a.at));
}

/** 本地模式下的城市计数（结构对齐接口，页面不用分支） */
export function localCityCounts(list: FoodRecord[]): ApiCityCounts {
  const counts = new Map<string, number>();
  let uncityCount = 0;
  for (const r of list) {
    const city = r.city || '';
    if (!city) {
      uncityCount += 1;
      continue;
    }
    counts.set(city, (counts.get(city) || 0) + 1);
  }
  const cityCounts = [...counts.entries()]
    .map(([city, count]) => ({ city, count }))
    .sort((a, b) => b.count - a.count || (a.city < b.city ? -1 : 1));
  /* 离线兜底也要给出 provinces：服务端在 /records/cities 已带好，
     本地没有就用同一份 groupCitiesByProvince 算，保证墙页和线上同一条
     分组实现（否则离线城市选择器会拿不到分组）。 */
  const provinces = groupCitiesByProvince(cityCounts.map((c) => [c.city, c.count] as const));
  return { total: list.length, uncityCount, cityCounts, provinces };
}

/** 本地模式下的统计（对齐接口字段） */
export function localStats(list: FoodRecord[]): ApiStats {
  const fives = list.filter((r) => r.rating === 5);
  const rated = list.filter((r) => r.rating > 0);
  const sum = list.reduce((s, r) => s + (r.rating || 0), 0);
  const repeatedMap = new Map<string, number>();
  for (const r of list) repeatedMap.set(r.eat, (repeatedMap.get(r.eat) || 0) + 1);
  return {
    total: list.length,
    fiveCount: fives.length,
    firstFiveEat: fives.length ? fives[0].eat : null,
    cities: new Set(list.map((r) => r.city).filter(Boolean)).size,
    shops: new Set(list.map((r) => r.shop).filter(Boolean)).size,
    avgRating: list.length ? sum / list.length : 0,
    avgRatingRated: rated.length
      ? rated.reduce((s, r) => s + r.rating, 0) / rated.length
      : 0,
    repeated: [...repeatedMap.entries()]
      .filter(([, n]) => n >= 2)
      .map(([eat, count]) => ({ eat, count }))
      .sort((a, b) => b.count - a.count || (a.eat < b.eat ? -1 : 1)),
  };
}

/* ---------------- 聚合：城市计数 + 统计 + 月份 ---------------- */

/** 本地模式下的月份桶（跟随筛选，与接口同形状） */
export function localMonths(list: FoodRecord[], filterCity: string | null): ApiMonth[] {
  const filtered = localFilter(list, filterCity);
  const map = new Map<string, { count: number; first: FoodRecord }>();
  for (const r of filtered) {
    const key = r.at.slice(0, 7);
    const hit = map.get(key);
    if (hit) hit.count += 1;
    else map.set(key, { count: 1, first: r }); // filtered 已倒序 → 首次即该月最新
  }
  return [...map.entries()]
    .map(([month, v]) => ({
      month,
      count: v.count,
      /* 本地模式没有游标概念，给 null；页面按「本地跳月=切数组」处理 */
      firstCursor: null,
      firstCursorInclusive: null,
    }))
    .sort((a, b) => (a.month < b.month ? 1 : a.month > b.month ? -1 : 0));
}
