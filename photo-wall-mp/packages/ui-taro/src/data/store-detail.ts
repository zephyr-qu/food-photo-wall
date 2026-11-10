/* ================================================================
   单条 / 分享 / 随机一道 / 店铺档案 —— 一次只读一条的接口。

   详情页的关键取舍：**先给缓存、再后台刷新**。缓存命中时立刻返回（页面不白屏），
   同时发一次真请求；服务端说"没了"才 dropCachedRecord（否则缓存会变成幽灵），
   网络失败则静默保留（显示的旧数据仍然是对的，只是可能不是最新）。
   ================================================================ */
import { USE_REMOTE_DATA } from '../config';
import { ApiError, NetworkError } from '../api/client';
import { getRecord, getShopByName, randomRecord, readSharedRecord } from '../api';
import type { FoodRecord } from '@photo-wall/core';
import type { ShopView } from '../api/types';

import { wall } from './store-state.ts';
import { cacheRecord, dropCachedRecord, getCachedRecord, readOfflineSource } from './store-cache.ts';
import { cityQuery, localFilter } from './store-local.ts';
import { COVER_SEED } from './store-seed.ts';
import { toFoodRecord, toFoodRecords } from './adapters';

/** 按 id 取一条（详情页、编辑初始化）。远端 404 抛 ApiError('NOT_FOUND')。 */
export async function fetchRecord(id: string): Promise<FoodRecord> {
  if (wall.offline || !USE_REMOTE_DATA) {
    /* 离线兜底也必须走 readOfflineSource()：readStored() 在在线模式下会回落到
       12 条预置演示数据，让用户点进一条自己从未记录过的菜（P1-3）。 */
    const hit = readOfflineSource().find((r) => r.id === id);
    if (hit) return hit;
    /* 离线时内存里可能还有这条（详情缓存），比报「不在了」准确得多 */
    const cached = getCachedRecord(id);
    if (cached) return toFoodRecord(cached, 'full');
    /* 在线模式断网 + 无缓存：是"网络不通"，不是"记录没了"——
       抛 NetworkError 让详情页显示「重试」，而不是「这一条已经不在了」。 */
    if (wall.offline && USE_REMOTE_DATA) {
      throw new NetworkError('现在没有网络，等联网后再打开');
    }
    throw new ApiError(404, 'NOT_FOUND', '这一条已经不在了');
  }

  /* 命中缓存：**先给结果，后台再刷新**（stale-while-revalidate）。
   *
   * 为什么值得做：墙的列表接口 `/records` 已经把这条记录的**全部字段**返回了
   * （含 photo/photoThumb/photos 全部照片 URL，见 api/types.ts 的 ApiRecord）。
   * 也就是说，对「已经在墙上的记录」再打一次 `/records/{id}` 是**纯冗余** ——
   * 一个来回换来的信息和列表里的一模一样。
   *
   * 以前每次点进详情都要：等一个网络往返 → 才出内容。这一个往返就是
   * 「点开美食详情加载有点久」的主要来源（弱网下更是好几秒）。
   *
   * 现在：缓存里有 → **立刻**渲染（0 等待），同时后台静默拉最新并更新缓存。
   * 用户看到的是瞬间打开；数据最多晚一拍变新（编辑后返回墙会看到新值）。
   *
   * 缓存没命中（直接用链接打开详情、翻到了没加载过的页）→ 照旧走网络。 */
  const cached = getCachedRecord(id);
  if (cached) {
    void getRecord(id)
      .then((fresh) => {
        cacheRecord(id, fresh);
      })
      .catch((err) => {
        /* P1-5：区分「真的没了」和「网络抖了一下」。
           · 404 / NOT_FOUND：这条记录在服务端已被删（或被别人删），缓存是
             过期数据 —— 立刻清掉，否则详情页永远显示一条已删除的记录，
             且「重试」也永远拿到缓存里的旧值。
           · 其它错误（限流 / 断网 / 5xx）：缓存里的版本仍可用，保留它，
             下次网络恢复再刷新即可。 */
        if (err instanceof ApiError && err.code === 'NOT_FOUND') {
          dropCachedRecord(id);
        }
      });
    return toFoodRecord(cached, 'full');
  }

  const rec = await getRecord(id);
  cacheRecord(id, rec);
  return toFoodRecord(rec, 'full');
}

/* ---------------- 分享 ---------------- */

/**
 * 读一条**被分享**的记录（免登录，分享落地页用）。
 *
 * 与 `fetchRecord` 的区别：
 *   · 走 `/share/records/{id}?token=`，不需要登录态（`auth:false`）；
 *   · 要求 token 匹配 —— 否则 404（对方拿到的是"已失效"而不是"不存在"，
 *     文案上仍统一成"这一条已经不在了"，不泄露存在性）。
 *
 * 刻意不进 store 的 wall 状态：分享落地是**只读的单条视图**，
 * 不该污染自己的墙。
 */
export async function fetchSharedRecord(
  id: string,
  shareToken: string,
): Promise<FoodRecord> {
  const { record } = await readSharedRecord(id, shareToken);
  return toFoodRecord(record, 'full');
}

/** 随机一道：服务端抽（池子是全库，不是「已加载的几页」）。 */
export async function rollRandom(excludeId?: string | null): Promise<FoodRecord | null> {
  const filter = wall.filterCity;
  if (wall.offline || !USE_REMOTE_DATA) {
    /* 离线只用本机缓存（在线模式下恒为空），绝不回落到 REAL_RECORDS：
       以前这里会让「随机一道」抽到预置演示菜（P1-3）。 */
    const list = localFilter(readOfflineSource(), filter);
    if (!list.length) return null;
    const pool = list.length > 1 ? list.filter((r) => r.id !== excludeId) : list;
    return pool[Math.floor(Math.random() * pool.length)] || null;
  }
  try {
    const rec = await randomRecord({
      ...cityQuery(filter),
      excludeId: excludeId || undefined,
    });
    return toFoodRecord(rec, 'full');
  } catch (e) {
    /* 404 NO_RECORD = 这个筛选下没有记录（页面显示空态即可） */
    if (e instanceof ApiError && (e.code === 'NO_RECORD' || e.status === 404)) return null;
    throw e;
  }
}

/** 店铺查询参数：city 消歧；cursor/limit 翻页（A5/A6） */
export interface FetchShopOptions {
  city?: string | null;
  cursor?: string | null;
  limit?: number;
}

/**
 * 店铺档案（按店名，过渡形态；后端有 shopId 后可切 getShopById）。
 *
 * `city`：同名连锁店（海底捞·成都 / 重庆）按城市消歧 —— 以前只按店名聚合，
 * 两城的记录会被合并成一家店（A5）。
 * `cursor/limit`：翻页。以前丢弃 `nextCursor/hasMore`，超过 100 条静默截断（A6）。
 */
export async function fetchShop(
  name: string,
  opts: FetchShopOptions = {},
): Promise<ShopView | null> {
  const city = opts.city?.trim() || null;
  if (wall.offline || !USE_REMOTE_DATA) {
    /* 同上：离线只用本机缓存，不能把预置演示数据当店铺档案（P1-3）。 */
    const list = localFilter(readOfflineSource(), null)
      .filter((r) => r.shop === name)
      .filter((r) => !city || r.city === city);
    if (!list.length) {
      /* 在线模式断网且无缓存：是"网络不通"，不是"这家店没有记录" */
      if (wall.offline && USE_REMOTE_DATA) {
        throw new NetworkError('现在没有网络，等联网后再看');
      }
      return null;
    }
    const rated = list.map((r) => r.rating).filter(Boolean);
    return {
      name,
      cities: [...new Set(list.map((r) => r.city).filter(Boolean))] as string[],
      visitCount: list.length,
      dishCount: new Set(list.map((r) => r.eat)).size,
      avgRating: rated.length ? rated.reduce((s, n) => s + n, 0) / rated.length : 0,
      fiveCount: list.filter((r) => r.rating === 5).length,
      firstAt: list[list.length - 1].at,
      lastAt: list[0].at,
      items: list,
      candidates: [],
      hasMore: false,
      nextCursor: null,
    };
  }
  try {
    const res = await getShopByName(name, {
      city,
      limit: opts.limit,
      cursor: opts.cursor,
    });
    /* 接口把店铺与统计分成 shop / stats 两段；页面只关心「一行元信息 + 记录」，
       在这里拍平。by-name 未指定城市且命中多家同名店时 shop 为 null + candidates。 */
    return {
      name: res.shop?.name || name,
      cities: res.shop?.cities || [],
      visitCount: res.stats.visitCount,
      dishCount: res.stats.dishCount,
      avgRating: res.stats.avgRating,
      fiveCount: res.stats.fiveCount,
      firstAt: res.stats.firstAt,
      lastAt: res.stats.lastAt,
      items: toFoodRecords(res.records, 'thumb', COVER_SEED),
      candidates: res.candidates ?? [],
      hasMore: Boolean(res.hasMore),
      nextCursor: res.nextCursor ?? null,
    };
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  }
}
