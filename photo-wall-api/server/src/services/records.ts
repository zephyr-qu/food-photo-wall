/**
 * 记录服务：列表 / 单条 / 新建 / 编辑 / 删除 / 撤销 / 随机。
 * 全部读路径只返回 userId 本人的记录；别人的记录一律 404（不泄露存在性）。
 */
import type { Config } from '../config.js';
import { err } from '../lib/errors.js';
import { newOpaqueToken } from '../lib/ids.js';
import type { PhotoRow, RecordRow } from '../store/types.js';
import type { Store } from '../store/store.js';
import { cursorOf, round2, toRecordDto, type PageDto, type RecordDto } from '../lib/dto.js';
import { decodeCursor, isAfterCursor, isAtOrAfterCursor, sortedDesc } from '../lib/cursor.js';
import { photosOfRecord } from '../store/photo-ids.js';
import {
  formatTzOffset,
  localToUtcMs,
  nowMs,
  parseAtLocal,
  parseRfc3339,
  parseTzOffset,
  rfc3339OffsetMinutes,
  utcMsToAtLocal,
} from '../lib/time.js';
import type { CreateRecordInput, ListQuery, PatchRecordInput, RandomQuery } from '../schemas.js';
import { matchRecord, type Filters } from './filters.js';
import { findOrCreateShop } from './shop-resolver.js';
import { newId } from '../lib/ids.js';

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const CLOCK_SKEW_MS = 5 * 60 * 1000;

export function toFilters(q: {
  city?: string;
  cityMissing?: boolean;
  province?: string;
  shopId?: string;
  q?: string;
  from?: string;
  to?: string;
}): Filters {
  return {
    city: q.city,
    cityMissing: q.cityMissing,
    province: q.province,
    shopId: q.shopId,
    q: q.q,
    from: q.from,
    to: q.to,
  };
}

interface Temporal {
  atLocal: string;
  tzOffset: string;
  eatenAtUtc: string;
}

export class RecordService {
  constructor(
    private readonly store: Store,
    private readonly cfg: Config,
  ) {}

  // ------------------------------------------------------------ 读

  list(userId: string, q: ListQuery): PageDto<RecordDto> {
    const rows = sortedDesc(this.store.listRecords(userId).filter((r) => matchRecord(r, toFilters(q))));
    // total = 命中筛选的总条数（不随翻页变化）
    const total = rows.length;

    let page = rows;
    if (q.cursor) {
      const cursor = decodeCursor(q.cursor);
      /* cursorInclusive=true → `<=`（从这条开始，用于月轴跳转）；
         默认 false → 严格 `<`（keyset 翻页，不重不漏） */
      page = rows.filter((r) =>
        q.cursorInclusive ? isAtOrAfterCursor(r, cursor) : isAfterCursor(r, cursor),
      );
    }

    const items = page.slice(0, q.limit);
    const hasMore = page.length > q.limit;
    const last = items[items.length - 1];
    return {
      items: items.map((r) => this.dto(r)),
      nextCursor: hasMore && last ? cursorOf(last) : null,
      hasMore,
      total,
    };
  }

  get(userId: string, id: string): RecordDto {
    return this.dto(this.mustFind(userId, id));
  }

  random(userId: string, q: RandomQuery): RecordDto {
    const rows = this.store.listRecords(userId).filter((r) => matchRecord(r, toFilters(q)));
    if (rows.length === 0) throw err.noRecord();
    let pool = rows;
    if (q.excludeId) {
      const alt = rows.filter((r) => r.id !== q.excludeId);
      // 排除后无候选但总共只有 1 条 → 允许重复返回那一条
      if (alt.length > 0) pool = alt;
    }
    const picked = pool[Math.floor(Math.random() * pool.length)];
    return this.dto(picked);
  }

  // ------------------------------------------------------------ 写

  create(
    userId: string,
    input: CreateRecordInput,
    opts: { idempotencyKey?: string; timezoneHeader?: string },
  ): { dto: RecordDto; replayed: boolean } {
    const key = opts.idempotencyKey ?? input.clientRequestId;
    if (key) {
      const hit = this.store.getIdem(userId, key);
      if (hit) return { dto: hit.body as RecordDto, replayed: true };
    }

    const temporal = this.resolveTemporal(input, opts.timezoneHeader);
    const rating = input.rating ?? 0;

    // 照片：photoIds 优先；未出现时兼容旧字段 photoId（等价 photoIds:[photoId]）
    const photos = this.resolvePhotoIds(input.photoIds, input.photoId);
    for (const id of photos.ids) this.assertPhotoUsable(userId, id, photos.field);

    // 店铺：shopId 优先；否则按 (name, city) find-or-create（§6.2.3 实现要点）
    let shopId: string | null = null;
    let shopName: string | null = input.shop ?? null;
    if (input.shopId) {
      const shop = this.store.getShop(input.shopId);
      if (!shop || shop.userId !== userId) throw err.validation({ shopId: '店铺不存在' });
      shopId = shop.id;
      shopName = shop.name;
    } else if (shopName) {
      const shop = findOrCreateShop(this.store, userId, shopName, input.city ?? null);
      shopId = shop.id;
      shopName = shop.name;
    }

    const now = nowMs();
    const row: RecordRow = {
      id: newId('rec'),
      userId,
      eat: input.eat,
      shop: shopName,
      shopId,
      city: input.city ?? null,
      district: input.district ?? null,
      rating,
      atLocal: temporal.atLocal,
      tzOffset: temporal.tzOffset,
      eatenAtUtc: temporal.eatenAtUtc,
      note: input.note ?? null,
      photoIds: photos.ids,
      version: 1,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      /* 新建记录默认不分享（契约 §11 #10：用户主动开启才生成令牌） */
      shareToken: null,
      sharedAt: null,
    };
    this.store.insertRecord(row);

    const dto = this.dto(row);
    if (key) {
      this.store.putIdem({
        userId,
        key,
        status: 201,
        body: dto,
        createdAt: now,
        expiresAt: now + IDEMPOTENCY_TTL_MS,
      });
    }
    return { dto, replayed: false };
  }

  patch(userId: string, id: string, input: PatchRecordInput, ifMatch?: string): RecordDto {
    const row = this.mustFind(userId, id);

    if (ifMatch !== undefined) {
      /* If-Match 三种写法都要认：
           · `1`      —— 契约 §6.2.4 的示例，也是前端 api/index.ts 实际发的；
           · `"1"`    —— HTTP 标准 ETag 形态（CDN / 代理可能改写）；
           · `W/"1"`  —— 弱 ETag。
         语义都是同一个版本号。以前只认裸数字，带引号就 400 ——
         「同一个版本号，换个客户端就报参数错误」，而 mock 后端又接受带引号，
         两边行为不一致（mock-parity.test.ts 抓到的就是这条）。 */
      const expected = Number(ifMatch.trim().replace(/^W\//i, '').replace(/"/g, ''));
      if (!Number.isInteger(expected)) {
        throw err.badRequest('If-Match 必须是版本号（如 `1` 或 `"1"`）');
      }
      if (expected !== row.version) throw err.conflict();
    }

    const has = <K extends keyof PatchRecordInput>(k: K): boolean => input[k] !== undefined;

    if (has('eat')) row.eat = input.eat as string;
    if (has('rating')) row.rating = input.rating as number;
    if (has('city')) row.city = normText(input.city as string | null);
    if (has('district')) row.district = normText(input.district as string | null);
    if (has('note')) row.note = normText(input.note as string | null);

    // 照片集合：photoIds 出现 = **整体替换**（不是追加）；未出现 = 照片不动。
    // 兼容旧字段 photoId：仅当 photoIds 未出现时生效（photoId: null = 清空全部）。
    if (input.photoIds !== undefined) {
      const next = input.photoIds ?? [];
      for (const id of next) this.assertPhotoUsable(userId, id, 'photoIds');
      row.photoIds = next;
    } else if (has('photoId')) {
      const next = input.photoId as string | null;
      if (next) this.assertPhotoUsable(userId, next, 'photoId');
      row.photoIds = next ? [next] : [];
    }

    // 店铺：shopId 优先；显式 null 清空关联
    if (has('shopId')) {
      const next = input.shopId as string | null;
      if (next) {
        const shop = this.store.getShop(next);
        if (!shop || shop.userId !== userId) throw err.validation({ shopId: '店铺不存在' });
        row.shopId = shop.id;
        row.shop = shop.name;
      } else {
        row.shopId = null;
        row.shop = has('shop') ? normText(input.shop as string | null) : null;
      }
    } else if (has('shop')) {
      const name = normText(input.shop as string | null);
      if (!name) {
        row.shop = null;
        row.shopId = null;
      } else {
        const shop = findOrCreateShop(this.store, userId, name, row.city);
        row.shop = shop.name;
        row.shopId = shop.id;
      }
    }

    // 时间：任一相关字段出现就整体重算，避免 at 与 eatenAtUtc 打架
    if (has('at') || has('eatenAt') || has('tzOffset')) {
      const temporal = this.resolveTemporal(
        {
          at: has('at') ? (input.at as string) : row.atLocal,
          tzOffset: has('tzOffset') ? (input.tzOffset as string) : row.tzOffset,
          eatenAt: has('eatenAt') ? (input.eatenAt as string) : undefined,
        },
        undefined,
      );
      row.atLocal = temporal.atLocal;
      row.tzOffset = temporal.tzOffset;
      row.eatenAtUtc = temporal.eatenAtUtc;
    }

    row.version += 1;
    row.updatedAt = nextTimestamp(row.updatedAt);
    this.store.updateRecord(row);
    return this.dto(row);
  }

  /** 删除：本人存在/已删 → 204；不存在或别人的 → 404（§3.5 定死） */
  remove(userId: string, id: string): void {
    const row = this.store.getRecord(id);
    if (!row || row.userId !== userId) throw err.notFound('这一条已经不在了');
    if (row.deletedAt !== null) return; // 幂等：重复删自己的记录

    const now = nowMs();
    row.deletedAt = now;
    /* 删除即断链：已分享出去的卡片立刻失效。
       语义上合理（用户删了就是不想再被人看到），也避免"删了但链接还能看"
       这种隐私意外。restore 时**不恢复** shareToken —— 恢复记录不等于
       用户的分享意愿还在，要分享得重新点一次。 */
    row.shareToken = null;
    row.sharedAt = null;
    row.updatedAt = nextTimestamp(row.updatedAt);
    this.store.updateRecord(row);

    // 级联：记录的**每一张**照片，若不再被任何"未删除记录"引用 → 标记待回收
    const stillUsed = this.photoIdsUsedElsewhere(userId, row.id, row.photoIds);
    for (const photoId of row.photoIds) {
      if (stillUsed.has(photoId)) continue;
      const photo = this.store.getPhoto(photoId);
      if (photo && photo.deletedAt === null) {
        photo.deletedAt = now;
        this.store.updatePhoto(photo);
      }
    }
  }

  restore(userId: string, id: string): RecordDto {
    const row = this.store.getRecord(id);
    if (!row || row.userId !== userId) throw err.notFound('这一条已经不在了');
    if (row.deletedAt === null) return this.dto(row); // 幂等
    if (nowMs() - row.deletedAt > this.cfg.restoreWindowDays * 86_400_000) throw err.gone();

    row.deletedAt = null;
    row.updatedAt = nextTimestamp(row.updatedAt);
    this.store.updateRecord(row);

    // 照片随记录一起恢复：记录的**每一张**照片，若处于软删态 → 恢复
    for (const photoId of row.photoIds) {
      const photo = this.store.getPhoto(photoId);
      if (photo && photo.deletedAt !== null) {
        photo.deletedAt = null;
        this.store.updatePhoto(photo);
      }
    }
    return this.dto(row);
  }

  // ------------------------------------------------------------ 分享（§11 #10）

  /**
   * 开启分享：生成（或复用）不可猜的 shareToken。
   *
   * 设计要点：
   *   · **幂等**：已经分享过就复用原 token，不每次点分享都换新链接
   *     （否则用户发出去的旧卡片会失效）；
   *   · 撤销后重新分享 → 生成新 token（旧链接仍然失效，这是期望行为）；
   *   · 令牌用 crypto 随机字节，不可由 id/时间推导。
   */
  share(userId: string, id: string): { shareToken: string; sharedAt: number } {
    const row = this.mustFind(userId, id);
    if (row.shareToken && row.sharedAt !== null) {
      return { shareToken: row.shareToken, sharedAt: row.sharedAt };
    }
    const token = newOpaqueToken('sh');
    const now = nowMs();
    row.shareToken = token;
    row.sharedAt = now;
    row.updatedAt = nextTimestamp(row.updatedAt);
    this.store.updateRecord(row);
    return { shareToken: token, sharedAt: now };
  }

  /** 撤销分享：清空 token，旧链接立即失效。幂等。 */
  unshare(userId: string, id: string): void {
    const row = this.store.getRecord(id);
    if (!row || row.userId !== userId) throw err.notFound('这一条已经不在了');
    if (row.shareToken === null) return; // 本来就没分享
    row.shareToken = null;
    row.sharedAt = null;
    row.updatedAt = nextTimestamp(row.updatedAt);
    this.store.updateRecord(row);
  }

  /**
   * **匿名**读一条分享记录（分享落地页用，不走鉴权）。
   *
   * 安全边界：
   *   · 必须同时给对 id 与 token，token 不匹配一律 404（不区分"记录不存在"
   *     与"token 错"，避免被用来探测记录是否存在）；
   *   · 已删除（软删）的记录立即不可分享 —— 删除就断链，符合直觉；
   *   · 只返回展示需要的字段（DTO 已经不含 userId 等敏感项）。
   */
  readShared(id: string, token: string): RecordDto {
    const row = this.store.getRecord(id);
    if (!row || row.deletedAt !== null) throw err.notFound('这一条已经不在了');
    if (!row.shareToken || row.shareToken !== token) throw err.notFound('这一条已经不在了');
    return this.dto(row);
  }

  // ------------------------------------------------------------ 内部

  private mustFind(userId: string, id: string): RecordRow {
    const row = this.store.getRecord(id);
    if (!row || row.userId !== userId || row.deletedAt !== null) throw err.notFound('这一条已经不在了');
    return row;
  }

  private dto(row: RecordRow): RecordDto {
    return toRecordDto(row, photosOfRecord(this.store, row));
  }

  /**
   * 解析"这次要写入哪些照片"，以及出错时该写哪个 `fields` 键。
   *
   * 优先级（契约 §2.2）：`photoIds` 出现就以它为准；**只有** `photoIds` 未出现时
   * 才兼容旧字段 `photoId`。两者同时出现 → photoIds 优先，photoId 直接忽略
   * （不报错 —— 老客户端升级过程中可能同时带上两个字段，报错会打断写入）。
   *
   * `fields` 键也跟着来源走：走 photoIds 就写 `photoIds`，走旧 photoId 就写
   * `photoId`（保持旧行为，老客户端的报错提示才不会被改写）。
   */
  private resolvePhotoIds(
    photoIds: string[] | null | undefined,
    legacyPhotoId: string | null | undefined,
  ): { ids: string[]; field: string } {
    if (photoIds !== undefined) return { ids: photoIds ?? [], field: 'photoIds' };
    if (legacyPhotoId) return { ids: [legacyPhotoId], field: 'photoId' };
    return { ids: [], field: 'photoIds' };
  }

  /**
   * 这些照片 id 里，哪些**还被别的未删除记录**引用。
   *
   * 为什么排除自己：级联删除时这条记录已经是软删态，但判定口径是
   * 「未删除记录」——被删的这条不算数，否则每张图都会被自己挡住、永不回收。
   */
  private photoIdsUsedElsewhere(userId: string, selfId: string, photoIds: string[]): Set<string> {
    const used = new Set<string>();
    if (photoIds.length === 0) return used;
    for (const r of this.store.listRecords(userId)) {
      if (r.id === selfId) continue;
      for (const id of r.photoIds) used.add(id);
    }
    return used;
  }

  /**
   * 校验照片可用：存在、属于本人、未软删、已通过审核。
   *
   * @param field 出错时写进 `fields` 的键名（`photoIds` 或旧字段 `photoId`）
   */
  private assertPhotoUsable(userId: string, photoId: string, field: string): void {
    const photo = this.store.getPhoto(photoId);
    if (!photo || photo.userId !== userId) throw err.validation({ [field]: '照片不存在' });
    if (photo.deletedAt !== null) throw err.validation({ [field]: '照片已删除' });
    if (photo.status !== 'approved') throw err.validation({ [field]: '照片未通过审核' });
  }

  /**
   * 时间解析（§3.4）：
   *   eatenAt（RFC3339）优先；否则 at（本地墙钟）+ tzOffset/请求头/默认 +08:00；
   *   都不传 → 服务端当前时间（对齐前端 stampNow()）。
   * 统一收敛到"整分钟"，保证 at 与 eatenAtUtc 严格互推。
   *
   * ⚠ 请求头 `X-Timezone-Offset` **非法时直接 400**，不静默回落。
   * 以前是 `parseTzOffset(header) ?? fallback`，客户端发个 `bogus` 会被
   * 当成 +08:00 照常写入 —— 结果记录的 at/eatenAtUtc 与客户端以为的时区
   * 差了好几个小时，且**没有任何信号**。时区错了会连锁影响排序、分月、
   * 统计口径，属于"静默错数据"，必须让它响亮地失败。
   *
   * 注意区分两类输入：
   *   · 请求头是**传输层元信息**，格式错 = 客户端有问题 → 400；
   *   · body 里的 `tzOffset` 有 zod 校验（schemas.ts），非法已在更早一层被 422 拦掉。
   */
  private resolveTemporal(
    input: { at?: string; tzOffset?: string; eatenAt?: string },
    timezoneHeader: string | undefined,
  ): Temporal {
    const now = nowMs();
    let headerOffset: number | null = null;
    if (timezoneHeader) {
      headerOffset = parseTzOffset(timezoneHeader);
      if (headerOffset === null) {
        throw err.badRequest(
          `请求头 X-Timezone-Offset 不合法：期望 ±HH:mm（如 +08:00），收到 "${timezoneHeader}"`,
        );
      }
    }
    const fallbackOffset = parseTzOffset(this.cfg.defaultTzOffset) ?? 480;

    if (input.eatenAt) {
      const ms = parseRfc3339(input.eatenAt);
      if (ms === null) throw err.validation({ at: 'eatenAt 不是合法时间' });
      const offset = rfc3339OffsetMinutes(input.eatenAt) ?? headerOffset ?? fallbackOffset;
      const atLocal = utcMsToAtLocal(ms, offset);
      const parts = parseAtLocal(atLocal);
      if (!parts) throw err.validation({ at: '时间不合法' });
      const eatenAtUtcMs = localToUtcMs(parts, offset);
      this.assertAtInRange(eatenAtUtcMs, now);
      return { atLocal, tzOffset: formatTzOffset(offset), eatenAtUtc: isoOf(eatenAtUtcMs) };
    }

    const offset =
      (input.tzOffset ? parseTzOffset(input.tzOffset) : null) ?? headerOffset ?? fallbackOffset;

    if (input.at) {
      const parts = parseAtLocal(input.at);
      if (!parts) throw err.validation({ at: '时间格式必须是 YYYY-MM-DDTHH:mm' });
      const ms = localToUtcMs(parts, offset);
      this.assertAtInRange(ms, now);
      return { atLocal: input.at, tzOffset: formatTzOffset(offset), eatenAtUtc: isoOf(ms) };
    }

    // 服务端当前时间：先转成该时区的本地串，再回推 UTC（保证整分钟一致）
    const atLocal = utcMsToAtLocal(now, offset);
    const parts = parseAtLocal(atLocal)!;
    return {
      atLocal,
      tzOffset: formatTzOffset(offset),
      eatenAtUtc: isoOf(localToUtcMs(parts, offset)),
    };
  }

  private assertAtInRange(utcMs: number, now: number): void {
    if (utcMs > now + CLOCK_SKEW_MS) throw err.validation({ at: '不能是未来时间' });
    if (utcMs < 0) throw err.validation({ at: '时间不能早于 1970 年' });
  }
}

const normText = (v: string | null): string | null => {
  if (v === null) return null;
  const t = v.trim();
  return t === '' ? null : t;
};

const isoOf = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

/**
 * 单调递增的 updatedAt：同一毫秒内连续写也要能看出变化（AC-17 断言 updatedAt 变化）。
 * 不依赖"睡 1 秒"这类测试技巧。
 */
const nextTimestamp = (prev: number): number => Math.max(Date.now(), prev + 1);

/** 供统计/店铺复用的均分工具 */
export const avg = (sum: number, n: number): number => (n === 0 ? 0 : round2(sum / n));
