/**
 * 纯内存存储（零依赖，仅用于测试与本地零配置联调）。
 *
 * 为什么保留它：跑测试、前端本地联调时希望 `npm start` 就能起来、不依赖任何
 * 外部存储。但它**不持久** —— 进程退出数据即丢。生产请用 SqliteStore（单文件、
 * ACID、单机部署首选，见 sqlite.ts）或 Postgres。
 *
 * 数据结构与 §7.1 的 SQL 表一一对应，换持久化后端只需另写实现 Store 接口的类。
 */
import type {
  IdempotencyRow,
  PhotoRow,
  RecordRow,
  RefreshRow,
  ShopRow,
  UserRow,
} from './types.js';
import type { ListRecordsOptions, Store } from './store.js';
import { readPhotoIds, referencedPhotoIds } from './photo-ids.js';

const idemKey = (userId: string, key: string): string => `${userId}\u0000${key}`;

/**
 * 内存快照：一次导入/恢复所需的全部行。
 *
 * 为什么需要它：内存库没有磁盘，但**旧数据兼容**这件事必须在某处被钉死 ——
 * 旧快照里的记录只有单个 `photoId`，新代码只认 `photoIds`。把这份兼容逻辑
 * 放在 `hydrate()` 里（而不是散在读路径），才能保证"导进来的"和
 * "库里本来有的"走同一条归一化路径。
 */
export interface DbSnapshot {
  users?: UserRow[];
  /** 允许是旧形态（只有 photoId，没有 photoIds） */
  records?: Array<RecordRow | (Omit<RecordRow, 'photoIds'> & { photoIds?: string[]; photoId?: string | null })>;
  shops?: ShopRow[];
  photos?: PhotoRow[];
}

export class MemoryStore implements Store {
  readonly kind = 'memory' as const;

  private users = new Map<string, UserRow>();
  private usersByOpenid = new Map<string, string>();
  private usersByDevice = new Map<string, string>();
  private records = new Map<string, RecordRow>();
  private shops = new Map<string, ShopRow>();
  private photos = new Map<string, PhotoRow>();
  private refresh = new Map<string, RefreshRow>();
  private idem = new Map<string, IdempotencyRow>();

  private constructor() {}

  /** 创建纯内存存储（测试用） */
  static async open(): Promise<MemoryStore> {
    const store = new MemoryStore();
    store.gc();
    return store;
  }

  /** 清理过期数据（启动时一次） */
  gc(): void {
    const now = Date.now();
    for (const [k, v] of this.refresh) if (v.expiresAt <= now) this.refresh.delete(k);
    for (const [k, v] of this.idem) if (v.expiresAt <= now) this.idem.delete(k);
  }

  /**
   * 导入一份快照（内存库的唯一"落盘"入口）。
   *
   * 兼容旧数据：旧行只有 `photoId` 没有 `photoIds` → 折成 `[photoId]`。
   * 这条规则必须在这里生效，否则老快照导入后会变成"所有记录都没照片"，
   * 而且是**静默**的 —— 图还在库里，只是记录不再引用它。
   */
  hydrate(snapshot: DbSnapshot): void {
    for (const u of snapshot.users ?? []) this.insertUser(u);
    for (const s of snapshot.shops ?? []) this.insertShop(s);
    for (const p of snapshot.photos ?? []) this.insertPhoto(p);
    for (const r of snapshot.records ?? []) {
      const legacy = r as { photoIds?: string[]; photoId?: string | null };
      const row = { ...(r as RecordRow) } as RecordRow & { photoId?: string | null };
      row.photoIds = readPhotoIds(legacy);
      delete row.photoId; // 旧字段不再随行流转
      this.insertRecord(row);
    }
  }

  /** 导出当前全量数据（快照的另一半） */
  snapshot(): DbSnapshot {
    return {
      users: [...this.users.values()],
      records: [...this.records.values()],
      shops: [...this.shops.values()],
      photos: [...this.photos.values()],
    };
  }

  // 内存存储无落盘概念：flush 是 no-op（接口要求），close 直接返回。
  async flush(): Promise<void> {}
  async close(): Promise<void> {}

  // ---------------- users ----------------
  getUser(id: string): UserRow | undefined {
    return this.users.get(id);
  }
  findUserByOpenid(openid: string): UserRow | undefined {
    const id = this.usersByOpenid.get(openid);
    return id ? this.users.get(id) : undefined;
  }
  findUserByDevice(deviceId: string): UserRow | undefined {
    const id = this.usersByDevice.get(deviceId);
    return id ? this.users.get(id) : undefined;
  }
  insertUser(row: UserRow): void {
    this.users.set(row.id, row);
    if (row.wechatOpenid) this.usersByOpenid.set(row.wechatOpenid, row.id);
    if (row.deviceId) this.usersByDevice.set(row.deviceId, row.id);
  }
  updateUser(row: UserRow): void {
    this.insertUser(row);
  }

  // ---------------- records ----------------
  getRecord(id: string): RecordRow | undefined {
    return this.records.get(id);
  }
  insertRecord(row: RecordRow): void {
    this.records.set(row.id, this.normalizeRecord(row));
  }
  updateRecord(row: RecordRow): void {
    this.records.set(row.id, this.normalizeRecord(row));
  }
  /**
   * 行归一化：补齐 `photoIds`。
   *
   * 为什么写入路径也要兜一层：调用方可能拿着**旧形态**的行对象直接写回来
   * （测试、脚本、外部导入）。这时 `photoIds` 是 undefined，
   * 下游 `row.photoIds.includes(...)` 会直接抛 TypeError ——
   * 一个字段缺失不该让整个接口 500。
   */
  private normalizeRecord(row: RecordRow): RecordRow {
    if (Array.isArray(row.photoIds)) return row;
    const legacy = (row as { photoId?: string | null }).photoId;
    return { ...row, photoIds: legacy ? [legacy] : [] };
  }
  listRecords(userId: string, opts?: ListRecordsOptions): RecordRow[] {
    const out: RecordRow[] = [];
    for (const r of this.records.values()) {
      if (r.userId !== userId) continue;
      if (!opts?.includeDeleted && r.deletedAt !== null) continue;
      out.push(r);
    }
    return out;
  }
  /** 只数条数：内存库直接数 Map，不复制行 */
  countRecords(userId: string): number {
    let n = 0;
    for (const r of this.records.values()) {
      if (r.userId === userId && r.deletedAt === null) n += 1;
    }
    return n;
  }

  // ---------------- shops ----------------
  getShop(id: string): ShopRow | undefined {
    return this.shops.get(id);
  }
  insertShop(row: ShopRow): void {
    this.shops.set(row.id, row);
  }
  findShopByNameCity(userId: string, name: string, city: string | null): ShopRow | undefined {
    for (const s of this.shops.values()) {
      if (s.userId === userId && s.name === name && (s.city ?? null) === (city ?? null)) return s;
    }
    return undefined;
  }
  listShopsByName(userId: string, name: string): ShopRow[] {
    return [...this.shops.values()].filter((s) => s.userId === userId && s.name === name);
  }
  listShops(userId: string): ShopRow[] {
    return [...this.shops.values()].filter((s) => s.userId === userId);
  }

  // ---------------- photos ----------------
  getPhoto(id: string): PhotoRow | undefined {
    return this.photos.get(id);
  }
  /** 批量取：Map 直查，按传入顺序返回（缺失的跳过） */
  getPhotos(ids: string[]): PhotoRow[] {
    const out: PhotoRow[] = [];
    for (const id of new Set(ids.filter((x) => typeof x === 'string' && x !== ''))) {
      const hit = this.photos.get(id);
      if (hit) out.push(hit);
    }
    return out;
  }
  insertPhoto(row: PhotoRow): void {
    this.photos.set(row.id, row);
  }
  updatePhoto(row: PhotoRow): void {
    this.photos.set(row.id, row);
  }
  listPhotos(userId: string, opts?: { includeDeleted?: boolean }): PhotoRow[] {
    return [...this.photos.values()].filter(
      (p) => p.userId === userId && (opts?.includeDeleted || p.deletedAt === null),
    );
  }
  /** 全量照片（跨用户）：仅回收任务用 */
  listAllPhotos(opts?: { includeDeleted?: boolean }): PhotoRow[] {
    return [...this.photos.values()].filter(
      (p) => opts?.includeDeleted || p.deletedAt === null,
    );
  }

  // ---------------- refresh tokens ----------------
  insertRefresh(row: RefreshRow): void {
    this.refresh.set(row.token, row);
  }
  getRefresh(token: string): RefreshRow | undefined {
    const row = this.refresh.get(token);
    if (!row) return undefined;
    if (row.expiresAt <= Date.now()) {
      this.refresh.delete(token);
      return undefined;
    }
    return row;
  }
  deleteRefresh(token: string): void {
    this.refresh.delete(token);
  }

  // ---------------- idempotency ----------------
  getIdem(userId: string, key: string): IdempotencyRow | undefined {
    const row = this.idem.get(idemKey(userId, key));
    if (!row) return undefined;
    if (row.expiresAt <= Date.now()) {
      this.idem.delete(idemKey(userId, key));
      return undefined;
    }
    return row;
  }
  putIdem(row: IdempotencyRow): void {
    this.idem.set(idemKey(row.userId, row.key), row);
  }

  // ---------------- 回收 ----------------
  /**
   * 物理清理超过保留期的软删记录 + 不再被引用的软删照片。
   *
   * 实现要点：
   *   1. **先**删记录、**再**判断照片是否还被引用 —— 否则"刚被删掉的记录"
   *      会挡住它自己的照片回收；
   *   2. 照片回收条件：已软删 **且** 没有任何未删除记录引用它。
   *      （用户可能删了一条又贴了新记录复用同一张图，这种不能删）；
   *   3. 返回计数供日志/测试断言。
   *
   * ⚠ 本方法**不删磁盘文件**：MemoryStore 不知道文件路径（那是 PhotoService
   * 的事）。生产里应在调用本方法后，按返回的 photoId 去对象存储删对象。
   * 见 services/maintenance.ts 的说明。
   */
  purgeSoftDeleted(retentionDays: number): { records: number; photos: number } {
    const cutoff = Date.now() - retentionDays * 86_400_000;
    let records = 0;
    let photos = 0;

    /* 1) 过期的软删记录 */
    const expiredRecordIds = new Set<string>();
    for (const [id, r] of this.records) {
      if (r.deletedAt !== null && r.deletedAt <= cutoff) {
        this.records.delete(id);
        expiredRecordIds.add(id);
        records += 1;
      }
    }

    /* 2) 已软删、且不再被任何「未删除记录」引用的照片
          （引用判定：出现在任何未删除记录的 photoIds 里 —— 一条记录最多 5 张） */
    const referenced = referencedPhotoIds(
      [...this.records.values()].filter((r) => r.deletedAt === null),
    );
    for (const [id, p] of this.photos) {
      if (p.deletedAt !== null && !referenced.has(id)) {
        this.photos.delete(id);
        photos += 1;
      }
    }

    return { records, photos };
  }
}
