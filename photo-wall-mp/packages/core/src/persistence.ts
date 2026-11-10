/* ================================================================
   持久化判定（纯函数）

   从 storage 读出来的东西是 `unknown`，是否可用、以及"空数组算不算有数据"
   是一个纯判断，抽出来是为了能单测 —— store 里那层 if 曾把 `[]` 当成
   "没有数据"，导致用户删光记录后冷启动又被预置数据填满（删除被撤销）。

   规则很简单但容易写错：**只要是数组就认**，长度 0 也是合法状态。
   ================================================================ */
import type { FoodRecord } from './types/domain';

/**
 * 决定冷启动时用哪份记录。
 *
 * @param raw    Taro.getStorageSync 的返回值（可能是 undefined / 字符串 / 数组）
 * @param preset 兜底用的预置记录
 * @returns 数组原样返回；其余情况返回 preset 的**逐条浅拷贝**
 *          （slice() 只复制数组外壳，元素仍是同一批对象，改副本的字段会污染常量）
 */
export function resolveInitialRecords(
  raw: unknown,
  preset: readonly FoodRecord[],
): FoodRecord[] {
  if (Array.isArray(raw)) return raw as FoodRecord[];
  return preset.map((r) => ({ ...r }));
}
