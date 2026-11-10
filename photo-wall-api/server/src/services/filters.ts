/** 筛选口径：列表 / 随机 / 统计 / 月份 共用（契约要求"同一份记录 + 同一口径"） */
import { CITY_PROVINCE, OTHER_PROVINCE } from '../data/geo-cities.js';
import type { RecordRow } from '../store/types.js';

export interface Filters {
  city?: string;
  cityMissing?: boolean;
  province?: string;
  shopId?: string;
  q?: string;
  from?: string;
  to?: string;
}

/**
 * 城市 → 省（与前端 core/geo.ts 的 provinceOf **逐字一致**，P2 收口漂移坑）。
 * 关键：带行政后缀的写法（「厦门市」「闽侯县」）要先去后缀再查一次，
 * 否则后端会把「厦门市」误判为表外、归进「其他」，而前端归福建。
 */
const ADMIN_SUFFIX = /(特别行政区|自治区|自治州|地区|省|市|县|区)$/u;

export function provinceOf(city: string | null | undefined): string | null {
  const raw = (city ?? '').trim();
  if (!raw) return null;
  const direct = CITY_PROVINCE[raw];
  if (direct) return direct;
  const bare = raw.replace(ADMIN_SUFFIX, '');
  if (bare && bare !== raw) return CITY_PROVINCE[bare] ?? null;
  return null;
}

/** 省 → 城市集合；'其他' 表示字典外表外城市 */
export function provinceScope(province: string): { cities: Set<string> } | { other: true } {
  if (province === OTHER_PROVINCE) return { other: true };
  const cities = new Set<string>();
  for (const [city, p] of Object.entries(CITY_PROVINCE)) if (p === province) cities.add(city);
  return { cities };
}

export function matchRecord(row: RecordRow, f: Filters): boolean {
  const city = row.city ?? null;

  if (f.cityMissing && city) return false;
  if (f.city && city !== f.city) return false;

  if (f.province) {
    if (!city) return false;
    const scope = provinceScope(f.province);
    if ('other' in scope) {
      if (provinceOf(city)) return false; // 字典内（含去后缀命中）→ 不属于"其他"
    } else if (!scope.cities.has(city)) {
      return false;
    }
  }

  if (f.shopId && row.shopId !== f.shopId) return false;

  if (f.q) {
    if (!row.eat.toLowerCase().includes(f.q.toLowerCase())) return false;
  }

  const day = row.atLocal.slice(0, 10); // 按本地墙钟日期筛，不用 UTC
  if (f.from && day < f.from) return false;
  if (f.to && day > f.to) return false;

  return true;
}

/** 已知省份列表（下拉/校验用；'其他' 单独处理） */
export function knownProvinces(): string[] {
  return [...new Set(Object.values(CITY_PROVINCE))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
