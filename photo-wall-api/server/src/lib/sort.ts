/**
 * 排序口径（契约 §6.3.1）：
 *   cityCounts    : count DESC → 城市名 zh-Hans-CN（拼音序，前端 localeCompare）
 *   provinces     : count DESC → 省名 **码点序**
 *   省内 cities   : count DESC → 城市名 **码点序**
 *   repeated      : count DESC → eat 的 zh-Hans-CN
 * 码点序刻意不用 ICU：与前端 groupCitiesByProvince 的 `a < b` 一致。
 */

const zhCollator = new Intl.Collator('zh-Hans-CN');

/** 拼音序（简体中文 collation） */
export const compareZh = (a: string, b: string): number => zhCollator.compare(a, b);

/** 码点序（不依赖 ICU，三端一致） */
export const compareCodePoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export interface Counted {
  count: number;
}

/** count 降序 + 名称比较器兜底 */
export function byCountThen<T extends Counted>(
  name: (x: T) => string,
  cmp: (a: string, b: string) => number = compareCodePoint,
) {
  return (a: T, b: T): number => b.count - a.count || cmp(name(a), name(b));
}
