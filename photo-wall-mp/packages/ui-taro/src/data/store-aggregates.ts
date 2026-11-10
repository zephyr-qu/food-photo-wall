/* ================================================================
   聚合：城市计数 / 墙统计 / 月份列表（三个接口一起拉，一个状态槽）。

   独立请求序号 `aggReqSeq`：聚合和墙是两条独立的请求流，切城市时两边都会
   重发，但两边返回顺序互不相干 —— 共用一个序号会互相把对方判成"过期"。
   ================================================================ */
import { USE_REMOTE_DATA } from '../config';
import { getStats, listCityCounts, listMonths } from '../api';

import { emitAggregate, wall } from './store-state.ts';
import { readOfflineSource, readStored } from './store-cache.ts';
import { cityQuery, localCityCounts, localMonths, localStats } from './store-local.ts';
import { isOfflineError } from './store-errors.ts';

/** 聚合请求序号（只在本模块用） */
let aggReqSeq = 0;

export async function loadAggregates(): Promise<void> {
  emitAggregate({ status: 'loading' });
  const seq = ++aggReqSeq; // P1-2：并发聚合请求用独立序号，后到的旧响应不覆盖新响应
  if (!USE_REMOTE_DATA) {
    const local = readStored();
    emitAggregate({
      cities: localCityCounts(local),
      stats: localStats(local),
      months: localMonths(local, wall.filterCity),
      status: 'ready',
    });
    return;
  }
  try {
    /* 月份桶跟随城市筛选（月轴要和墙上看到的一致）；
       城市计数与统计是全量口径（契约规定，不吃筛选）。 */
    const [cities, stats, months] = await Promise.all([
      listCityCounts(),
      getStats(),
      listMonths(cityQuery(wall.filterCity)),
    ]);
    if (seq !== aggReqSeq) return;
    emitAggregate({ cities, stats, months: months.items, status: 'ready' });
  } catch (e) {
    if (seq !== aggReqSeq) return;
    if (isOfflineError(e)) {
      const local = readOfflineSource();
      emitAggregate({
        cities: localCityCounts(local),
        stats: localStats(local),
        months: localMonths(local, wall.filterCity),
        status: 'ready',
      });
      return;
    }
    emitAggregate({ status: 'error' });
  }
}
