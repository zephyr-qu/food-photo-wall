/* ================================================================
   墙 / 聚合的**唯一一份**运行时状态 + 分页簿记 + 订阅。

   为什么单独一层：小程序每个 Page 是独立 React 根，数据必须活在一个模块里
   才能跨页共享（这就是 store 模块级而不是 context 的原因）。拆文件的底线是
   **状态不能出现两份** —— 所以 wall / aggregate / cursor 这些可变的东西全部
   住在这里，其它模块 import 后只读（ESM live binding，重新赋值只发生在
   emitWall / emitAggregate 里）。

   分页游标和"新鲜度"以前是散在这个文件里的 let 标量。跨模块赋值必须经过
   对象字段（不能给 import 进来的绑定赋值），所以收成 paging / freshness 两个
   小对象 —— 形状固定、一眼能看出谁在动它。
   ================================================================ */
import type { FoodRecord } from '@photo-wall/core';

import { USE_REMOTE_DATA } from '../config';
import type { ApiCityCounts, ApiMonth, ApiStats } from '../api/types';

export type LoadStatus = 'idle' | 'loading' | 'ready' | 'error';

/* ---------------- 墙状态 ---------------- */

export interface WallState {
  records: FoodRecord[];
  status: LoadStatus;
  /** 错误文案（status==='error' 时给页面显示） */
  error: string | null;
  hasMore: boolean;
  /** 当前筛选下的总数（顶栏/空态文案用） */
  total: number;
  /** null = 全部；'' = 未记；城市名 = 精确 */
  filterCity: string | null;
  /** 是否处于本地兜底模式（顶栏可显示「离线」） */
  offline: boolean;
}

export let wall: WallState = {
  records: [],
  status: 'idle',
  error: null,
  hasMore: false,
  total: 0,
  filterCity: null,
  offline: !USE_REMOTE_DATA,
};

const wallListeners = new Set<(s: WallState) => void>();

export function emitWall(patch: Partial<WallState>): void {
  wall = { ...wall, ...patch };
  wallListeners.forEach((fn) => fn(wall));
}

/** 订阅墙状态变化（hook 用；返回退订函数） */
export function subscribeWall(fn: (s: WallState) => void): () => void {
  wallListeners.add(fn);
  return () => {
    wallListeners.delete(fn);
  };
}

/* ---------------- 聚合（城市计数 / 统计 / 月份） ---------------- */
export interface AggregateState {
  /** 城市计数（全量口径，不吃筛选） */
  cities: ApiCityCounts | null;
  /** 统计六行（全量口径） */
  stats: ApiStats | null;
  /** 月份桶（**跟随当前城市筛选**，月轴要跟墙一致；null=还没加载） */
  months: ApiMonth[] | null;
  status: LoadStatus;
}

export let aggregate: AggregateState = { cities: null, stats: null, months: null, status: 'idle' };
const aggListeners = new Set<(s: AggregateState) => void>();

export function emitAggregate(patch: Partial<AggregateState>): void {
  aggregate = { ...aggregate, ...patch };
  aggListeners.forEach((fn) => fn(aggregate));
}
/** 订阅聚合状态变化（hook 用；返回退订函数） */
export function subscribeAggregate(fn: (s: AggregateState) => void): () => void {
  aggListeners.add(fn);
  return () => {
    aggListeners.delete(fn);
  };
}

/* ---------------- 分页簿记（不进 state：页面不读它） ---------------- */

/** 分页游标（不进 state：页面不读它，只在这里当钥匙用） */
export const paging = {
  cursor: null as string | null,
  loadingMore: false,
  /** 请求序号：切换筛选/刷新时让在途的旧请求失效，避免慢响应覆盖新结果 */
  reqSeq: 0,
};

/** 最近一次**尝试**加载的时间（毫秒）：失败也要记，否则每次 onShow 都会重试。
 *
 * ⚠ P1-7 冷启动：模块加载时初始化为「现在」，而不是 0。
 * 以前 `= 0`，冷启后第一次 `useDidShow` → `refreshIfStale` 里
 * `Date.now() - 0 >= 30000` 永远成立 → 即便首屏 `loadFirstPage` 已经
 * 拉过一次，这里还要**再打一整轮 4 个并发请求**（一次启动两次请求）。
 * 初始化成当前时间，冷启那一轮由首屏 effect 负责，onShow 不再重复打。 */
export const freshness = {
  lastAttemptAt: Date.now(),
  /** 「数据被改动过、需要尽快对齐」的脏标记（P1-7b）。
   *  删除/乐观更新成功后置 true，让下一次 `refreshIfStale` 即使还在 30s 冷却期内
   *  也强制刷新一次 —— 否则删除后立刻切走再回来，会在 30s 窗口里看到「没删掉」的回墙快照。 */
  dirty: false,
};
