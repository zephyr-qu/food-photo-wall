/**
 * 聚合服务：城市计数 / 墙统计 / 月份桶。
 * 关键口径（契约 §6.3）：
 *   - 全部来自"同一份未删除记录"，且**不吃城市筛选**（除非显式传筛选参数，P2 预留）
 *   - avgRating 分母 = total（rating=0 计入）；另给 avgRatingRated
 *   - 月份桶按 atLocal.slice(0,7) 归桶，**不是** UTC
 */
import type { Store } from '../store/store.js';
import { CITY_PROVINCE, OTHER_PROVINCE } from '../data/geo-cities.js';
import { monthKeyOf } from '../lib/time.js';
import { sortedDesc } from '../lib/cursor.js';
import { byCountThen, compareCodePoint, compareZh } from '../lib/sort.js';
import { cursorOf, round2 } from '../lib/dto.js';
import { formatUtcIso, nowMs } from '../lib/time.js';
import { matchRecord, provinceOf } from './filters.js';
import type { MonthsQuery, StatsQuery } from '../schemas.js';
import { toFilters } from './records.js';

export interface CityCountDto {
  city: string;
  count: number;
}

export interface ProvinceGroupDto {
  province: string;
  count: number;
  cities: CityCountDto[];
}

export interface CitiesAggregateDto {
  total: number;
  uncityCount: number;
  cityCounts: CityCountDto[];
  provinces: ProvinceGroupDto[];
  generatedAt: string;
}

export interface RepeatedItemDto {
  eat: string;
  count: number;
}

export interface StatsDto {
  scope: { city: string | null; cityMissing: boolean; from: string | null; to: string | null };
  total: number;
  fiveCount: number;
  firstFiveEat: string;
  cities: number;
  shops: number;
  dishCount: number;
  avgRating: number;
  ratedCount: number;
  avgRatingRated: number;
  repeated: RepeatedItemDto[];
  generatedAt: string;
}

export interface MonthItemDto {
  month: string;
  count: number;
  /**
   * 该月最新一条的游标。⚠ 这是**严格 after** 语义的游标：
   * 传给 `GET /records?cursor=` 时，那条记录本身**不会**出现在结果里
   * （keyset 是严格 `<`）。做月轴跳转会漏掉当月第一张。
   *
   * 保留它是为了兼容已发出的旧调用方；**新代码请用 `firstCursorInclusive`**。
   * @deprecated 用 firstCursorInclusive + `?cursorInclusive=true`
   */
  firstCursor: string | null;
  /**
   * 同上，但配合 `GET /records?cursor=<它>&cursorInclusive=true` 使用 ——
   * 会把该月最新一条**包含**进结果。月轴"跳到某月"应该用它。
   *
   * 与 firstCursor 是同一串游标值（游标本身不带包含语义，语义由请求参数决定），
   * 单独给一个字段名是为了让调用方一眼看出「这个要配 cursorInclusive=true」。
   */
  firstCursorInclusive: string | null;
}

export class AggregateService {
  constructor(private readonly store: Store) {}

  /**
   * 城市计数 + 省分组。
   * 不变量：sum(cityCounts.count) + uncityCount === total；
   *        sum(provinces.count) + uncityCount === total（未记不进 provinces）。
   */
  cities(userId: string): CitiesAggregateDto {
    const rows = this.store.listRecords(userId);
    const total = rows.length;

    const counts = new Map<string, number>();
    let uncityCount = 0;
    for (const r of rows) {
      const city = r.city ?? null;
      if (!city) {
        uncityCount += 1;
        continue;
      }
      counts.set(city, (counts.get(city) ?? 0) + 1);
    }

    // cityCounts：count DESC → 城市名**拼音序**（与前端 records.ts 的 countByCity 一致：localeCompare('zh-Hans-CN')）
    const cityCounts: CityCountDto[] = [...counts.entries()]
      .map(([city, count]) => ({ city, count }))
      .sort(byCountThen((x) => x.city, compareZh));

    // 省分组：表外城市（含带行政后缀如「厦门市」去后缀才命中）归「其他」；
    // provinceOf 与前端 provinceOf 逐字一致。省内城市码点序；省按 count DESC → 码点序（其他不单独置底）
    const groups = new Map<string, ProvinceGroupDto>();
    for (const { city, count } of cityCounts) {
      const province = provinceOf(city) ?? OTHER_PROVINCE;
      let g = groups.get(province);
      if (!g) {
        g = { province, count: 0, cities: [] };
        groups.set(province, g);
      }
      g.count += count;
      g.cities.push({ city, count });
    }
    const provinces = [...groups.values()];
    for (const g of provinces) g.cities.sort(byCountThen((x) => x.city, compareCodePoint));
    provinces.sort(byCountThen((x) => x.province, compareCodePoint));

    return { total, uncityCount, cityCounts, provinces, generatedAt: formatUtcIso(nowMs()) };
  }

  stats(userId: string, q: StatsQuery): StatsDto {
    const rows = this.store.listRecords(userId).filter((r) => matchRecord(r, toFilters(q)));
    const total = rows.length;

    let ratingSum = 0;
    let ratedSum = 0;
    let ratedCount = 0;
    let fiveCount = 0;
    const citySet = new Set<string>();
    const shopSet = new Set<string>();
    const dishSet = new Set<string>();
    const eatCounts = new Map<string, number>();

    for (const r of rows) {
      ratingSum += r.rating;
      if (r.rating > 0) {
        ratedSum += r.rating;
        ratedCount += 1;
      }
      if (r.rating === 5) fiveCount += 1;
      if (r.city) citySet.add(r.city);
      if (r.shop) shopSet.add(r.shop);
      dishSet.add(r.eat);
      eatCounts.set(r.eat, (eatCounts.get(r.eat) ?? 0) + 1);
    }

    // firstFiveEat：按时间倒序第一条 5 分（依赖排序，不能拿数组原序）
    const firstFive = sortedDesc(rows).find((r) => r.rating === 5);

    // repeated：≥2 次，次数降序 → 同数按 eat 拼音序；全量返回（前端 slice(0,3)）
    const repeated: RepeatedItemDto[] = [...eatCounts.entries()]
      .filter(([, count]) => count >= 2)
      .map(([eat, count]) => ({ eat, count }))
      .sort(byCountThen((x) => x.eat, compareZh));

    return {
      scope: {
        city: q.city ?? null,
        cityMissing: q.cityMissing ?? false,
        from: q.from ?? null,
        to: q.to ?? null,
      },
      total,
      fiveCount,
      firstFiveEat: firstFive?.eat ?? '',
      cities: citySet.size,
      shops: shopSet.size,
      dishCount: dishSet.size,
      avgRating: total === 0 ? 0 : round2(ratingSum / total),
      ratedCount,
      avgRatingRated: ratedCount === 0 ? 0 : round2(ratedSum / ratedCount),
      repeated,
      generatedAt: formatUtcIso(nowMs()),
    };
  }

  /** 月份列表：按 atLocal 的月份归桶，month DESC；firstCursor = 该月最新一条 */
  months(userId: string, q: MonthsQuery): { items: MonthItemDto[] } {
    const rows = sortedDesc(
      this.store.listRecords(userId).filter((r) => matchRecord(r, toFilters(q))),
    );

    const buckets = new Map<string, { count: number; first: (typeof rows)[number] }>();
    for (const r of rows) {
      const key = monthKeyOf(r.atLocal);
      const b = buckets.get(key);
      if (b) b.count += 1;
      else buckets.set(key, { count: 1, first: r }); // rows 已倒序 → 首次即该月最新
    }

    const items: MonthItemDto[] = [...buckets.entries()]
      .map(([month, b]) => {
        const c = cursorOf(b.first);
        return { month, count: b.count, firstCursor: c, firstCursorInclusive: c };
      })
      .sort((a, b) => (a.month < b.month ? 1 : a.month > b.month ? -1 : 0));

    return { items };
  }
}
