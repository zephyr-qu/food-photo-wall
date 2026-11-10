/* ================================================================
   墙 store —— **对外门面**。

   这里曾经是一个 1065 行的文件：storage 兜底、分页、聚合、写操作、详情、
   店铺、hooks 全挤在一起。现在按"改它的理由"拆成 11 个模块，这个文件只负责
   把同样的名字导出去，所以 `../../../data/store` 的调用方一行都不用改。

   ---------- 为什么拆 ----------
   · 一次改动的**理由**是单一的：改分页不会碰到写操作，改离线错误文案不用
     读分页游标；
   · 纯函数（筛选/计数/统计/月份分桶）从状态里拿出来后可以直接单测
     （`test/store-local.test.ts`），以前它们只能靠整机点一遍；
   · 排查问题时能一眼看出状态住在哪 —— 全部在 `store-state.ts`，
     其它模块只读（ESM live binding）。

   ---------- 拆分的硬约束（改的时候别破坏） ----------
   1. **状态只有一份**：wall / aggregate / cursor 等可变值只在 `store-state.ts`
      里定义与赋值。其它模块 import 后只读，写必须经过 emitWall / emitAggregate
      或 `paging` / `freshness` 对象字段。
   2. **依赖方向单向**：state ← 所有；paging → aggregates；refresh → paging +
      aggregates；writes → refresh + paging + aggregates；detail、hooks 不反向。
      出现环就让 Taro/webpack 的循环依赖告警重新回来。
   3. 对外导出面保持稳定（4 个页面 + 分享落地页都从 `data/store` 进）。
   ================================================================ */

export type { LoadStatus } from './store-state.ts';

export { COVER_SEED } from './store-seed.ts';

/* 墙：首屏 / 分页 / 筛选 / 跳月 / 过期刷新 */
export {
  loadFirstPage,
  loadMore,
  setCityFilter,
  reload,
  jumpToMonth,
} from './store-paging.ts';

/* 聚合：城市计数 + 统计 + 月份 */
export { loadAggregates } from './store-aggregates.ts';

/* 整体刷新（下拉 / 切页回来发现脏了） */
export { refreshAll, refreshIfStale } from './store-refresh.ts';

/* 写操作：新建 / 编辑 / 删除 / 撤销删除 */
export { addRecord, updateRecord, deleteRecord, undoDelete } from './store-writes.ts';

/* 单条 / 分享 / 随机一道 / 店铺档案 */
export { fetchRecord, fetchSharedRecord, rollRandom, fetchShop } from './store-detail.ts';
export type { FetchShopOptions } from './store-detail.ts';

/* 错误文案（离线写有专属说法，别直接抛给 errorText） */
export { OfflineWriteError, writeErrorText } from './store-errors.ts';

/* React 绑定 */
export { useWall, useAggregates, useRecord } from './store-hooks.ts';
