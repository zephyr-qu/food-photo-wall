/* ================================================================
   服务端聚合：城市计数 / 统计 / 月份 / 店铺 / 随机

   为什么必须服务端算（§0）：前端一旦分页，手里只有已加载的几页；
   城市计数、统计、随机若还在客户端算，数字会越翻越小、
   随机只会抽到最新几屏。

   口径来源逐条对齐前端纯函数（packages/core/src/{records,geo,stats}.ts），
   这些函数在 core 里有单测，不能自己发明一套。
   ================================================================ */
import { CITY_PROVINCE, OTHER_PROVINCE, byName, provinceOf } from './data/geo.js';
import { encodeCursor, serializeRecord, sortRecords } from './records.js';

/** 前端 countByCity 的口径：count DESC，同数按城市名 zh-Hans-CN（拼音序） */
const zhCollator = new Intl.Collator('zh-Hans-CN');
const byCityName = (a, b) => zhCollator.compare(a, b);

/** 全量城市计数 + 省分组（§6.3.1） */
export function cityAggregate(records) {
  const total = records.length;
  const counts = new Map(); // city|null -> count
  for (const r of records) {
    const key = r.city ?? null;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const uncityCount = counts.get(null) || 0;

  // cityCounts：不含未记桶（未记单独由 uncityCount 承载）
  const cityCounts = [...counts.entries()]
    .filter(([city]) => city !== null)
    .map(([city, count]) => ({ city, count }))
    .sort((a, b) => b.count - a.count || byCityName(a.city, b.city));

  // provinces：表外城市归「其他」；未记不参与
  const groups = new Map();
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
  for (const g of provinces) g.cities.sort((a, b) => b.count - a.count || byName(a.city, b.city));
  provinces.sort((a, b) => b.count - a.count || byName(a.province, b.province));

  return {
    total,
    uncityCount,
    cityCounts,
    provinces,
    generatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };
}

/** 墙统计六行数字（§6.3.3） */
export function statsAggregate(records) {
  const sorted = sortRecords(records); // firstFiveEat 依赖 eatenAtUtc DESC
  const total = sorted.length;

  const fives = sorted.filter((r) => r.rating === 5);
  const fiveCount = fives.length;
  const firstFiveEat = fiveCount ? fives[0].eat : '';

  const citySet = new Set();
  const shopSet = new Set();
  const eatCounts = new Map();
  let ratingSum = 0;
  let ratedSum = 0;
  let ratedCount = 0;

  for (const r of sorted) {
    if (r.city) citySet.add(r.city);
    if (r.shop) shopSet.add(r.shop);
    eatCounts.set(r.eat, (eatCounts.get(r.eat) || 0) + 1);
    ratingSum += r.rating || 0; // rating=0 计入分母（前端既有口径）
    if (r.rating > 0) {
      ratedSum += r.rating;
      ratedCount += 1;
    }
  }

  const repeated = [...eatCounts.entries()]
    .filter(([, n]) => n >= 2)
    .map(([eat, count]) => ({ eat, count }))
    .sort((a, b) => b.count - a.count || byCityName(a.eat, b.eat)); // 不截断，前端 slice(0,3)

  return {
    total,
    fiveCount,
    firstFiveEat,
    cities: citySet.size,
    shops: shopSet.size,
    dishCount: eatCounts.size,
    // 保留两位小数，避免浮点噪声（AC-22 期望 3.5 / 4.67）
    avgRating: total ? round2(ratingSum / total) : 0,
    ratedCount,
    avgRatingRated: ratedCount ? round2(ratedSum / ratedCount) : 0,
    repeated,
    generatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };
}

/** 月份桶（§6.3.2）：必须按 `at` 归桶，不能按 UTC —— AC-34 */
export function monthsAggregate(records) {
  const sorted = sortRecords(records);
  const buckets = new Map(); // 'YYYY-MM' -> { month, count, first: record }
  for (const r of sorted) {
    const month = r.at.slice(0, 7);
    let b = buckets.get(month);
    if (!b) {
      b = { month, count: 0, first: r };
      buckets.set(month, b);
    }
    b.count += 1;
  }
  const items = [...buckets.values()]
    .sort((a, b) => (a.month < b.month ? 1 : a.month > b.month ? -1 : 0))
    .map((b) => ({ month: b.month, count: b.count, firstCursor: encodeCursor(b.first) }));
  return { items };
}

/**
 * 店铺聚合（§6.4）。
 * @param {object[]} records 已按店名（+城市）过滤的记录
 * @param {{shopId?:string|null}} [opts]
 */
export function shopAggregate(records, opts = {}) {
  const sorted = sortRecords(records);
  const cities = [...new Set(sorted.map((r) => r.city).filter(Boolean))].sort(byName);
  const dishes = new Set(sorted.map((r) => r.eat));
  const rated = sorted.filter((r) => r.rating > 0);
  const ratedSum = rated.reduce((s, r) => s + r.rating, 0);

  // firstAt/lastAt 用 `at` 串比较（定宽，字典序 = 时间序）
  const ats = sorted.map((r) => r.at).sort();
  const shopIds = [...new Set(sorted.map((r) => r.shopId).filter(Boolean))];

  return {
    stats: {
      visitCount: sorted.length,
      dishCount: dishes.size,
      cityCount: cities.length,
      // 店铺均分只算已评（与墙统计不同！pages/shop/index.tsx:31-33）
      avgRating: rated.length ? round2(ratedSum / rated.length) : 0,
      ratedCount: rated.length,
      fiveCount: sorted.filter((r) => r.rating === 5).length,
      firstAt: ats.length ? ats[0] : null,
      lastAt: ats.length ? ats[ats.length - 1] : null,
    },
    records: sorted.map(serializeRecord),
    cities,
    shopIds,
    ...opts,
  };
}

/** 随机：先按候选数决定是否排除 excludeId（§6.2.6） */
export function pickRandom(records, excludeId) {
  const candidates = records;
  if (!candidates.length) return null;
  let pool = candidates;
  // 候选 > 1 时必须排除上一条；只有 1 条时允许重复返回它
  if (excludeId && candidates.length > 1) {
    const without = candidates.filter((r) => r.id !== excludeId);
    if (without.length) pool = without;
  }
  return pool[Math.floor(Math.random() * pool.length)];
}

/** 省 → 城市集合（province 参数展开用；表外归「其他」） */
export function citiesOfProvince(province) {
  const set = new Set();
  if (province === OTHER_PROVINCE) {
    for (const city of Object.keys(CITY_PROVINCE)) {
      if (!CITY_PROVINCE[city]) set.add(city);
    }
    return set;
  }
  for (const [city, prov] of Object.entries(CITY_PROVINCE)) {
    if (prov === province) set.add(city);
  }
  return set;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}
