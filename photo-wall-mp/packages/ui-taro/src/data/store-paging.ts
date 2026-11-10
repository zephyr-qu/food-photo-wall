/* ================================================================
   墙的分页 / 筛选 / 跳月 / 过期刷新 —— "把数据铺到墙上"的那一半。

   两条铁律（每一条都对应一个线上故障）：
     1. **请求序号**（`paging.reqSeq`）：切城市、跳月会连发请求，先发的后到会把
        新数据覆盖掉。每次重铺都自增，回来时比对不上就丢弃。
     2. **失败不清已有墙**：断网时保留上一次的内容（F-3 离线可用），只在
        `records.length === 0` 时才把状态打成 error。
   ================================================================ */
import Taro from '@tarojs/taro';
import { FIRST_PAGE_SIZE, PAGE_SIZE, USE_REMOTE_DATA } from '../config';
import { listFromCursorInclusive, listRecords } from '../api';

import { aggregate, emitWall, freshness, paging, wall } from './store-state.ts';
import { cacheRecord, readOfflineSource, readStored } from './store-cache.ts';
import { errorText } from '../api/client';
import { cityQuery, localFilter } from './store-local.ts';
import { isOfflineError } from './store-errors.ts';
import { COVER_SEED } from './store-seed.ts';
import { toFoodRecords } from './adapters';
import { loadAggregates } from './store-aggregates.ts';

/* ---------------- 墙：首屏 / 分页 / 筛选 ---------------- */

/** 加载第一页（或切换筛选后重载）。force=true 时连状态也重置。 */
export async function loadFirstPage(options: { keepRecords?: boolean } = {}): Promise<void> {
  const seq = ++paging.reqSeq;
  const keep = options.keepRecords && wall.records.length > 0;
  /* 尝试就记时间（成功与否都记）：失败后进入冷却，避免 onShow 反复重试打爆限流 */
  freshness.lastAttemptAt = Date.now();
  emitWall({
    status: keep ? 'ready' : 'loading',
    error: null,
  });

  if (!USE_REMOTE_DATA) {
    const local = readStored();
    const list = localFilter(local, wall.filterCity);
    emitWall({
      records: list.slice(0, FIRST_PAGE_SIZE),
      total: list.length,
      hasMore: list.length > FIRST_PAGE_SIZE,
      status: 'ready',
      offline: true,
    });
    paging.cursor = null;
    return;
  }

  try {
    const page = await listRecords({
      limit: FIRST_PAGE_SIZE,
      ...cityQuery(wall.filterCity),
    });
    if (seq !== paging.reqSeq) return; // 有更新的请求在飞，丢弃这次结果
    paging.cursor = page.nextCursor;
    /* 顺手把列表里的记录塞进详情缓存：
       列表已经带了这条记录的全部字段，点进详情时就能**立刻**渲染，
       不必再等一个 `/records/{id}` 的往返（见 fetchRecord 的说明）。 */
    for (const item of page.items) cacheRecord(item.id, item);
    emitWall({
      records: toFoodRecords(page.items, 'thumb', COVER_SEED),
      total: page.total,
      hasMore: page.hasMore,
      status: 'ready',
      error: null,
      offline: false,
    });
  } catch (e) {
    if (seq !== paging.reqSeq) return;
    if (isOfflineError(e)) {
      /* 网络不通：**保留已经加载出来的墙**，不要用空缓存把它整体替换掉。
         在线模式从不 persistLocal，readOfflineSource() 恒为空；若直接拿它覆盖
         records，用户会看到「墙还是空的」，以为记录被清空（P1-2）。
         内存里有内容就留着，本机真有缓存时才用缓存；两者都没有才落空态。 */
      const keep = wall.records.length > 0;
      const local = localFilter(readOfflineSource(), wall.filterCity);
      emitWall({
        records: keep ? wall.records : local.slice(0, FIRST_PAGE_SIZE),
        total: keep ? wall.total : local.length,
        hasMore: keep ? wall.hasMore : local.length > FIRST_PAGE_SIZE,
        status: 'ready',
        offline: true,
        error: '网络不太好，显示的是上次加载的内容',
      });
      if (!keep) paging.cursor = null;
      return;
    }
    emitWall({ status: 'error', error: errorText(e) });
  }
}

/** 触底：取更早一页。返回是否真的加到了新记录。 */
export async function loadMore(): Promise<boolean> {
  if (paging.loadingMore || !wall.hasMore) return false;
  if (wall.offline) return loadMoreLocal();

  paging.loadingMore = true;
  const seq = paging.reqSeq;
  try {
    const page = await listRecords({
      limit: PAGE_SIZE,
      cursor: paging.cursor,
      ...cityQuery(wall.filterCity),
    });
    if (seq !== paging.reqSeq) return false;
    paging.cursor = page.nextCursor;
    emitWall({
      records: wall.records.concat(toFoodRecords(page.items, 'thumb', COVER_SEED)),
      hasMore: page.hasMore,
      total: page.total,
    });
    return page.items.length > 0;
  } catch (e) {
    /* 触底失败不清空已有内容，只提示（用户还能继续看已加载的） */
    Taro.showToast({ title: errorText(e), icon: 'none', duration: 2000 });
    return false;
  } finally {
    paging.loadingMore = false;
  }
}

/** 本地模式下的「翻页」：直接切下一段，不再伪造数据 */
async function loadMoreLocal(): Promise<boolean> {
  const local = localFilter(readOfflineSource(), wall.filterCity);
  const next = local.slice(0, wall.records.length + PAGE_SIZE);
  const grew = next.length > wall.records.length;
  /* 离线且没有本机缓存（在线模式的常态）时 local 为空：绝不能把空数组 emit 给墙，
     否则用户一触底，已加载的内容就被清空。直接结束分页即可。 */
  emitWall(
    grew
      ? { records: next, hasMore: next.length < local.length, total: local.length }
      : { hasMore: false },
  );
  return grew;
}

/** 切换城市筛选：重置游标、重拉第一页、同时刷新聚合（P1-2）。
 *
 * 月份桶是**跟随城市筛选**的（aggregate.months 注释写明），只重拉墙而不重拉
 * 聚合会让月轴停留在旧口径（全量或上一城市），点月轴即用错游标 → 数据错乱。
 * 这里用独立的聚合请求序号避免并发旧响应覆盖。 */
export async function setCityFilter(city: string | null): Promise<void> {
  if (wall.filterCity === city) return;
  paging.cursor = null;
  emitWall({ filterCity: city, records: [] });
  await Promise.all([loadFirstPage(), loadAggregates()]);
}

/** 手动重试（错误态 / 下拉刷新用） */
export async function reload(): Promise<void> {
  paging.cursor = null;
  await Promise.all([loadFirstPage(), loadAggregates()]);
}

/* ---------------- 月轴跳转 ---------------- */

/**
 * 跳到某月：把墙**重置为「该月第一条（含）」开始的列表**。
 *
 * 为什么不是"滚动到某个 y"：墙是分页的，未加载的月份根本不在 DOM/节点树里，
 * 没法靠滚动定位。所以语义是"从该月第一条开始重新铺墙"，用户看到的第一屏
 * 就是那个月 —— 这也正是原型月轴的目的（快速定位到某段时间）。
 *
 * 关键点：必须用 `cursorInclusive=true` + `firstCursorInclusive`。
 * 若只用 `cursor`（严格 `<`），当月最新那一张会稳定丢失（历史 B7 的坑）。
 *
 * @returns 是否真的完成了跳转。页面据此决定「滚回顶部」还是「提示失败」——
 *          以前无返回值，失败是**完全静默**的（用户以为月轴坏了，会连点）。
 */
export async function jumpToMonth(month: string): Promise<boolean> {
  const seq = ++paging.reqSeq;
  const entry = aggregate.months?.find((m) => m.month === month);

  if (USE_REMOTE_DATA && wall.offline) {
    /* 断网时没有全库游标可用；本地只有已加载的几页，按它跳会给出错误结果。
       宁可什么都不做（保留当前墙），提示交给页面（它知道更具体的文案）。 */
    return false;
  }

  if (!USE_REMOTE_DATA) {
    /* 本地模式：按月份过滤已缓存记录（没有游标概念，直接切数组） */
    const local = localFilter(readOfflineSource(), wall.filterCity).filter(
      (r) => r.at.slice(0, 7) === month,
    );
    emitWall({
      records: local.slice(0, FIRST_PAGE_SIZE),
      total: local.length,
      hasMore: local.length > FIRST_PAGE_SIZE,
      status: 'ready',
      error: null,
    });
    paging.cursor = null;
    return true;
  }

  if (!entry || !entry.firstCursorInclusive) return false; // 该月没数据（理论上不会点）

  emitWall({ status: 'loading', error: null });
  try {
    const page = await listFromCursorInclusive({
      cursor: entry.firstCursorInclusive,
      limit: FIRST_PAGE_SIZE,
      ...cityQuery(wall.filterCity),
    });
    if (seq !== paging.reqSeq) return false;
    paging.cursor = page.nextCursor;
    emitWall({
      /* 只保留该月起的记录？不需要：接口已按"从该游标之后"返回，
         更早的月份会自然排在后面对用户继续翻 —— 与"跳到该月"体验一致。 */
      records: toFoodRecords(page.items, 'thumb', COVER_SEED),
      total: page.total,
      hasMore: page.hasMore,
      status: 'ready',
      offline: false,
    });
    return true;
  } catch (e) {
    if (seq !== paging.reqSeq) return false;
    /* 已有内容时不要整页换成错误态（用户会失去当前墙）；保留旧墙，失败由页面 toast。 */
    if (wall.records.length === 0) {
      emitWall({ status: 'error', error: errorText(e) });
    }
    return false;
  }
}
