/**
 * 店铺服务：GET /shops/{shopId} 与 GET /shops/by-name。
 * 口径差异（契约 §6.4）：店铺页 avgRating **只算已评**（rating>0），与墙统计相反。
 */
import type { Store } from '../store/store.js';
import { err } from '../lib/errors.js';
import { decodeCursor, isAfterCursor, sortedDesc } from '../lib/cursor.js';
import { cursorOf, round2, toRecordDto, toShopDto, type RecordDto, type ShopDto } from '../lib/dto.js';
import type { RecordRow, ShopRow } from '../store/types.js';
import { photosOfRecord } from '../store/photo-ids.js';

export interface ShopStatsDto {
  visitCount: number;
  dishCount: number;
  cityCount: number;
  avgRating: number;
  ratedCount: number;
  fiveCount: number;
  firstAt: string | null;
  lastAt: string | null;
}

export interface ShopDetailDto {
  shop: ShopDto | null;
  candidates?: ShopDto[];
  stats: ShopStatsDto;
  records: RecordDto[];
  nextCursor: string | null;
  hasMore: boolean;
}

interface PageQuery {
  limit: number;
  cursor?: string;
}

export class ShopService {
  constructor(private readonly store: Store) {}

  getById(userId: string, shopId: string, q: PageQuery): ShopDetailDto {
    const shop = this.store.getShop(shopId);
    if (!shop || shop.userId !== userId) throw err.notFound('店铺不存在');

    const rows = sortedDesc(this.store.listRecords(userId).filter((r) => r.shopId === shop.id));
    const cities = rows.map((r) => r.city).filter((c): c is string => !!c);
    return this.build(toShopDto(shop, cities), undefined, rows, q);
  }

  getByName(userId: string, name: string, city: string | undefined, q: PageQuery): ShopDetailDto {
    const shops = this.store.listShopsByName(userId, name).filter((s) => !city || s.city === city);

    // 与前端现状一致：按记录里的店名快照聚合（r.shop === name）。
    // 传 city 时用于消歧（同名跨城），记录也只取该城市的。
    const sameName = this.store.listRecords(userId).filter((r) => r.shop === name);
    const rows = sortedDesc(city ? sameName.filter((r) => r.city === city) : sameName);
    if (rows.length === 0 && shops.length === 0) throw err.notFound('没有这家店的记录');

    const cities = rows.map((r) => r.city).filter((c): c is string => !!c);

    // 同名跨城且无法唯一确定 → shop=null + candidates
    if (shops.length === 1) {
      return this.build(toShopDto(shops[0] as ShopRow, cities), undefined, rows, q);
    }
    if (shops.length === 0) {
      // 历史记录：有店名快照但无店铺实体
      return this.build(null, [], rows, q);
    }
    return this.build(
      null,
      shops.map((s) =>
        toShopDto(
          s,
          rows.filter((r) => r.shopId === s.id).map((r) => r.city).filter((c): c is string => !!c),
        ),
      ),
      rows,
      q,
    );
  }

  private build(
    shop: ShopDto | null,
    candidates: ShopDto[] | undefined,
    allRows: RecordRow[],
    q: PageQuery,
  ): ShopDetailDto {
    const stats = this.statsOf(allRows);

    let page = allRows;
    if (q.cursor) {
      const cursor = decodeCursor(q.cursor);
      page = allRows.filter((r) => isAfterCursor(r, cursor));
    }
    const slice = page.slice(0, q.limit);
    const hasMore = page.length > q.limit;
    const last = slice[slice.length - 1];

    const dto: ShopDetailDto = {
      shop,
      stats,
      records: slice.map((r) => toRecordDto(r, photosOfRecord(this.store, r))),
      nextCursor: hasMore && last ? cursorOf(last) : null,
      hasMore,
    };
    if (candidates) dto.candidates = candidates;
    return dto;
  }

  private statsOf(rows: RecordRow[]): ShopStatsDto {
    let ratedSum = 0;
    let ratedCount = 0;
    let fiveCount = 0;
    const dishes = new Set<string>();
    const cities = new Set<string>();

    for (const r of rows) {
      if (r.rating > 0) {
        ratedSum += r.rating;
        ratedCount += 1;
      }
      if (r.rating === 5) fiveCount += 1;
      dishes.add(r.eat);
      if (r.city) cities.add(r.city);
    }

    // 记录已按时间倒序：首条 = 最近，末条 = 最早
    return {
      visitCount: rows.length,
      dishCount: dishes.size,
      cityCount: cities.size,
      avgRating: ratedCount === 0 ? 0 : round2(ratedSum / ratedCount),
      ratedCount,
      fiveCount,
      firstAt: rows.length ? (rows[rows.length - 1] as RecordRow).atLocal : null,
      lastAt: rows.length ? (rows[0] as RecordRow).atLocal : null,
    };
  }
}
