/* ================================================================
   整体刷新：墙 + 聚合一起（"下拉"和"切页回来发现脏了"都走这里）。
   ================================================================ */
import { freshness } from './store-state.ts';
import { loadAggregates } from './store-aggregates.ts';
import { loadFirstPage } from './store-paging.ts';

/** 写操作后统一刷新：墙 + 计数 + 统计，保证三者同源 */
export async function refreshAll(): Promise<void> {
  freshness.dirty = false; // P1-7b：刷新开始即清脏标记，避免无限重试
  await Promise.all([loadFirstPage({ keepRecords: true }), loadAggregates()]);
}

/**
 * 数据过期才刷新。
 *
 * 为什么需要：小程序页面 reLaunch / 切后台再回来时，模块级 store 还活着，
 * status 仍是 'ready'，首屏 effect 不会重跑 —— 用户看到的是上次的数据。
 * 别的设备改过记录时，这就成了「看到旧数据却不知道」。
 * 30s 窗口是折中：太短会在页面来回切时反复打接口。
 *
 * ⚠ 关键：这里比的是「**上次尝试**」而不是「上次成功」。
 *
 * 以前 `lastLoadedAt` 只在加载成功时更新（`loadFirstPage` 的 try 里）。
 * 于是**一旦加载失败**（比如撞了限流 429），`lastLoadedAt` 永远是 0，
 * `Date.now() - 0 >= 30000` 永远成立 → 每次 `useDidShow`
 * （进详情页返回、切后台再回来）都会再打**一整轮 4 个并发请求**。
 * 而这一轮又很可能再失败、再打满限流 —— 于是变成
 * 「点详情 → 返回 → 点详情 → 返回」的乒乓，越点越卡。
 *
 * 所以：**尝试过就记时间**，失败后进入一段冷却期，不要立刻重试。
 */
export async function refreshIfStale(maxAgeMs = 30000): Promise<void> {
  /* P1-7b：删除/改动后置的脏标记，即使在冷却期内也强制对齐一次，
    保证「删完切走再回来」不会看到残留的旧回墙快照。 */
  if (!freshness.dirty && Date.now() - freshness.lastAttemptAt < maxAgeMs) return;
  await refreshAll();
}
