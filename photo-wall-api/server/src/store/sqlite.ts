/**
 * 单文件 SQLite 存储（better-sqlite3）。
 *
 * 为什么是它：比 PostgreSQL 轻得多（一个文件、零服务进程、同步 API），
 * 又补齐了纯内存存储的两块短板 —— ACID 落盘（掉电不丢在途写）与
 * 「可多副本共享登录态」（refreshToken / idempotency 落库，配合单写者
 * 即可消除纯内存模式的多实例数据分叉）。非常适合单机生产。
 *
 * 字段口径与 store/types.ts 完全一致：时间一律 epoch ms 整数，
 * 字符串时间（atLocal / eatenAtUtc / tzOffset / shareToken）直接 TEXT 存。
 *
 * 并发安全：better-sqlite3 是同步、单连接、串行化执行的，天然无竞态；
 * 幂等键用 `(userId, key)` 唯一约束做 INSERT OR IGNORE，保证同一 key
 * 在并发下只落一条（不再依赖进程内 Map 的串行性）。
 */
import Database from 'better-sqlite3';
import type {
  IdempotencyRow,
  PhotoRow,
  RecordRow,
  RefreshRow,
  ShopRow,
  UserRow,
} from './types.js';
import type { ListRecordsOptions, Store } from './store.js';
import { parsePhotoIds, readPhotoIdsColumn, serializePhotoIds } from './photo-ids.js';

const DAY_MS = 86_400_000;

interface Row {
  [k: string]: unknown;
}

function asRecord<T>(row: unknown): T | undefined {
  return row === undefined || row === null ? undefined : (row as unknown as T);
}

/** 表里的原始行：photoIds 是 JSON 串，photoId 是旧列 */
interface RawRecordRow {
  [k: string]: unknown;
  photoIds?: string | null;
  photoId?: string | null;
}

/** 原始行 → 行模型：photoIds 列优先，空/NULL 才回落旧列（老库兼容） */
function toRecordRow(raw: RawRecordRow): RecordRow {
  const row = { ...raw } as unknown as RecordRow & { photoId?: string | null };
  row.photoIds = readPhotoIdsColumn(raw.photoIds, raw.photoId);
  delete row.photoId;
  return row;
}

export class SqliteStore implements Store {
  readonly kind = 'sqlite' as const;
  private readonly db: Database.Database;
  private opened = false;

  private constructor(private readonly dbFile: string | null) {
    this.db = new Database(dbFile ?? ':memory:');
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
  }

  /** 打开一个 SQLite 存储；dbFile 为 null 时纯内存库（测试） */
  static async open(dbFile: string | null): Promise<SqliteStore> {
    const store = new SqliteStore(dbFile);
    store.migrate();
    store.gc();
    store.opened = true;
    return store;
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id            TEXT PRIMARY KEY,
        wechatOpenid  TEXT UNIQUE,
        deviceId      TEXT UNIQUE,
        createdAt     INTEGER NOT NULL,
        updatedAt     INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS records (
        id          TEXT PRIMARY KEY,
        userId      TEXT NOT NULL REFERENCES users(id),
        eat         TEXT NOT NULL,
        shop        TEXT,
        shopId      TEXT,
        city        TEXT,
        district    TEXT,
        rating      INTEGER NOT NULL,
        atLocal     TEXT NOT NULL,
        tzOffset    TEXT NOT NULL,
        eatenAtUtc  TEXT NOT NULL,
        note        TEXT,
        photoId     TEXT,
        photoIds    TEXT,
        version     INTEGER NOT NULL,
        createdAt   INTEGER NOT NULL,
        updatedAt   INTEGER NOT NULL,
        deletedAt   INTEGER,
        shareToken  TEXT,
        sharedAt    INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_records_user ON records(userId);
      CREATE INDEX IF NOT EXISTS idx_records_deleted ON records(deletedAt);
      CREATE INDEX IF NOT EXISTS idx_records_photo ON records(photoId);

      CREATE TABLE IF NOT EXISTS shops (
        id        TEXT PRIMARY KEY,
        userId    TEXT NOT NULL REFERENCES users(id),
        name      TEXT NOT NULL,
        city      TEXT,
        createdAt INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_shops_user_name ON shops(userId, name);

      CREATE TABLE IF NOT EXISTS photos (
        id        TEXT PRIMARY KEY,
        userId    TEXT NOT NULL REFERENCES users(id),
        url       TEXT NOT NULL,
        photoUrl  TEXT NOT NULL,
        thumbUrl  TEXT NOT NULL,
        width     INTEGER NOT NULL,
        height    INTEGER NOT NULL,
        size      INTEGER NOT NULL,
        mime      TEXT NOT NULL,
        status    TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        deletedAt INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_photos_user ON photos(userId);
      CREATE INDEX IF NOT EXISTS idx_photos_deleted ON photos(deletedAt);

      CREATE TABLE IF NOT EXISTS refresh_tokens (
        token     TEXT PRIMARY KEY,
        userId    TEXT NOT NULL REFERENCES users(id),
        createdAt INTEGER NOT NULL,
        expiresAt INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_refresh_user ON refresh_tokens(userId);
      CREATE INDEX IF NOT EXISTS idx_refresh_exp ON refresh_tokens(expiresAt);

      CREATE TABLE IF NOT EXISTS idempotency (
        userId    TEXT NOT NULL,
        key       TEXT NOT NULL,
        status    INTEGER NOT NULL,
        body      TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        expiresAt INTEGER NOT NULL,
        PRIMARY KEY (userId, key)
      );
      CREATE INDEX IF NOT EXISTS idx_idem_exp ON idempotency(expiresAt);
    `);

    this.migratePhotoIds();
  }

  /**
   * 迁移 `records.photoIds`（JSON 数组串）。
   *
   * 为什么要写迁移而不是只改 CREATE TABLE：CREATE TABLE IF NOT EXISTS 对
   * **已存在的表**是空操作 —— 老库（只有 photoId 列）打开后根本没有 photoIds
   * 列，写入就会报 "no such column"。所以每次启动都要检查一次列是否存在。
   *
   * 迁移分两步：
   *   1. 没有 photoIds 列 → ALTER TABLE ADD COLUMN；
   *   2. 老行（photoIds 仍是 NULL）→ 回填成 '["<id>"]'。
   *
   * ⚠ 回填条件**只能是 `photoIds IS NULL`**，绝不能包含 `photoIds = '[]'`。
   *
   *   这是一个会真实咬人的坑：用户在新版本里"清空照片"（PATCH photoIds: []）
   *   后，photoIds 列是 `'[]'`；但旧 photoId 列里还留着当初的值（我们不再写它，
   *   也不删它）。如果回填条件把 `'[]'` 也算成"空"，迁移会在**下次重启时**
   *   把旧 photoId 折回数组 —— 用户明明删掉的图**复活了**，
   *   而且是静默的（HTTP 200，页面照常显示）。
   *
   *   所以语义必须是：**NULL = 还没迁移过（老数据）；'[]' = 迁移过了且用户清空过**。
   *   两者不能混。
   *
   * 旧 photoId 列**保留但不再写入** —— 删列会丢数据（万一有别的工具在读），
   * 留着当只读的历史痕迹，代价只是一点空间。
   */
  private migratePhotoIds(): void {
    const cols = this.db.prepare('PRAGMA table_info(records)').all() as { name: string }[];
    if (!cols.some((c) => c.name === 'photoIds')) {
      this.db.exec('ALTER TABLE records ADD COLUMN photoIds TEXT');
    }
    /* 老行回填：只处理 photoIds 仍是 NULL 的行（见上面的警告）。 */
    this.db
      .prepare(
        `UPDATE records
            SET photoIds = '["' || photoId || '"]'
          WHERE photoId IS NOT NULL
            AND photoId <> ''
            AND photoIds IS NULL`,
      )
      .run();
  }

  /** 清掉过期 refresh / idempotency（启动一次 + 可定时） */
  gc(): void {
    const now = Date.now();
    this.db
      .prepare('DELETE FROM refresh_tokens WHERE expiresAt <= ?')
      .run(now);
    this.db
      .prepare('DELETE FROM idempotency WHERE expiresAt <= ?')
      .run(now);
  }

  // MemoryStore 是防抖落盘；SQLite 是 WAL 即时持久，flush 已是 no-op，
  // 仍保留接口签名一致。
  async flush(): Promise<void> {
    if (this.dbFile) this.db.pragma('wal_checkpoint(TRUNCATE)');
  }

  async close(): Promise<void> {
    if (!this.opened) return;
    this.opened = false;
    this.db.pragma('optimize');
    this.db.close();
  }

  // ---------------- users ----------------
  getUser(id: string): UserRow | undefined {
    return asRecord<UserRow>(this.db.prepare('SELECT * FROM users WHERE id = ?').get(id));
  }
  findUserByOpenid(openid: string): UserRow | undefined {
    return asRecord<UserRow>(
      this.db.prepare('SELECT * FROM users WHERE wechatOpenid = ?').get(openid),
    );
  }
  findUserByDevice(deviceId: string): UserRow | undefined {
    return asRecord<UserRow>(
      this.db.prepare('SELECT * FROM users WHERE deviceId = ?').get(deviceId),
    );
  }
  insertUser(row: UserRow): void {
    this.db
      .prepare(
        `INSERT INTO users (id, wechatOpenid, deviceId, createdAt, updatedAt)
         VALUES (@id, @wechatOpenid, @deviceId, @createdAt, @updatedAt)
         ON CONFLICT(id) DO UPDATE SET
           wechatOpenid = excluded.wechatOpenid,
           deviceId    = excluded.deviceId,
           updatedAt   = excluded.updatedAt`,
      )
      .run(row);
  }
  updateUser(row: UserRow): void {
    this.insertUser(row);
  }

  // ---------------- records ----------------
  getRecord(id: string): RecordRow | undefined {
    const raw = this.db.prepare('SELECT * FROM records WHERE id = ?').get(id) as
      | RawRecordRow
      | undefined;
    return raw ? toRecordRow(raw) : undefined;
  }
  insertRecord(row: RecordRow): void {
    this.upsertRecord(row);
  }
  updateRecord(row: RecordRow): void {
    this.upsertRecord(row);
  }
  private upsertRecord(row: RecordRow): void {
    /* 兜底：调用方可能拿着旧形态的行对象写回来（photoIds 缺失）。
       直接 JSON.stringify(undefined) 会得到 undefined（不是串），
       better-sqlite3 会当成 NULL 写进去 —— 那会被读成"老数据"，
       于是旧 photoId 列的残留值又把它复活。必须显式归一成 '[]'。 */
    const ids = Array.isArray(row.photoIds)
      ? row.photoIds
      : (row as { photoId?: string | null }).photoId
        ? [(row as { photoId?: string | null }).photoId as string]
        : [];

    this.db
      .prepare(
        `INSERT INTO records (id, userId, eat, shop, shopId, city, district, rating,
           atLocal, tzOffset, eatenAtUtc, note, photoIds, version, createdAt, updatedAt,
           deletedAt, shareToken, sharedAt)
         VALUES (@id, @userId, @eat, @shop, @shopId, @city, @district, @rating,
           @atLocal, @tzOffset, @eatenAtUtc, @note, @photoIds, @version, @createdAt, @updatedAt,
           @deletedAt, @shareToken, @sharedAt)
         ON CONFLICT(id) DO UPDATE SET
           userId=excluded.userId, eat=excluded.eat, shop=excluded.shop, shopId=excluded.shopId,
           city=excluded.city, district=excluded.district, rating=excluded.rating,
           atLocal=excluded.atLocal, tzOffset=excluded.tzOffset, eatenAtUtc=excluded.eatenAtUtc,
           note=excluded.note, photoIds=excluded.photoIds, version=excluded.version,
           createdAt=excluded.createdAt, updatedAt=excluded.updatedAt,
           deletedAt=excluded.deletedAt, shareToken=excluded.shareToken, sharedAt=excluded.sharedAt`,
      )
      // photoIds 存 JSON 数组串；旧 photoId 列不再写入
      .run({ ...row, photoIds: serializePhotoIds(ids) });
  }
  listRecords(userId: string, opts?: ListRecordsOptions): RecordRow[] {
    const sql = opts?.includeDeleted
      ? 'SELECT * FROM records WHERE userId = ?'
      : 'SELECT * FROM records WHERE userId = ? AND deletedAt IS NULL';
    return (this.db.prepare(sql).all(userId) as RawRecordRow[]).map(toRecordRow);
  }

  /** 只数条数：COUNT(*) 由 SQLite 算，不把行读进内存 */
  countRecords(userId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM records WHERE userId = ? AND deletedAt IS NULL')
      .get(userId) as { n: number } | undefined;
    return row?.n ?? 0;
  }

  // ---------------- shops ----------------
  getShop(id: string): ShopRow | undefined {
    return asRecord<ShopRow>(this.db.prepare('SELECT * FROM shops WHERE id = ?').get(id));
  }
  insertShop(row: ShopRow): void {
    this.db
      .prepare(
        `INSERT INTO shops (id, userId, name, city, createdAt)
         VALUES (@id, @userId, @name, @city, @createdAt)
         ON CONFLICT(id) DO UPDATE SET
           userId=excluded.userId, name=excluded.name, city=excluded.city`,
      )
      .run(row);
  }
  findShopByNameCity(userId: string, name: string, city: string | null): ShopRow | undefined {
    return asRecord<ShopRow>(
      this.db
        .prepare('SELECT * FROM shops WHERE userId = ? AND name = ? AND (city IS ? OR city = ?)')
        .get(userId, name, city, city),
    );
  }
  listShopsByName(userId: string, name: string): ShopRow[] {
    return this.db
      .prepare('SELECT * FROM shops WHERE userId = ? AND name = ?')
      .all(userId, name) as ShopRow[];
  }
  listShops(userId: string): ShopRow[] {
    return this.db.prepare('SELECT * FROM shops WHERE userId = ?').all(userId) as ShopRow[];
  }

  // ---------------- photos ----------------
  getPhoto(id: string): PhotoRow | undefined {
    return asRecord<PhotoRow>(this.db.prepare('SELECT * FROM photos WHERE id = ?').get(id));
  }
  /** 批量取：一条 `IN (...)` 代替 N 次单行查询 */
  getPhotos(ids: string[]): PhotoRow[] {
    const uniq = [...new Set(ids.filter((id) => typeof id === 'string' && id !== ''))];
    if (!uniq.length) return [];
    const placeholders = uniq.map(() => '?').join(',');
    const rows = this.db
      .prepare(`SELECT * FROM photos WHERE id IN (${placeholders})`)
      .all(...uniq) as PhotoRow[];
    /* 按传入顺序返回（缺失的跳过）：调用方靠顺序决定封面/左右切换 */
    const byId = new Map(rows.map((r) => [r.id, r]));
    const out: PhotoRow[] = [];
    for (const id of uniq) {
      const hit = byId.get(id);
      if (hit) out.push(hit);
    }
    return out;
  }
  insertPhoto(row: PhotoRow): void {
    this.upsertPhoto(row);
  }
  updatePhoto(row: PhotoRow): void {
    this.upsertPhoto(row);
  }
  private upsertPhoto(row: PhotoRow): void {
    this.db
      .prepare(
        `INSERT INTO photos (id, userId, url, photoUrl, thumbUrl, width, height, size, mime, status, createdAt, deletedAt)
         VALUES (@id, @userId, @url, @photoUrl, @thumbUrl, @width, @height, @size, @mime, @status, @createdAt, @deletedAt)
         ON CONFLICT(id) DO UPDATE SET
           userId=excluded.userId, url=excluded.url, photoUrl=excluded.photoUrl, thumbUrl=excluded.thumbUrl,
           width=excluded.width, height=excluded.height, size=excluded.size, mime=excluded.mime,
           status=excluded.status, createdAt=excluded.createdAt, deletedAt=excluded.deletedAt`,
      )
      .run(row);
  }
  listPhotos(userId: string, opts?: { includeDeleted?: boolean }): PhotoRow[] {
    const sql = opts?.includeDeleted
      ? 'SELECT * FROM photos WHERE userId = ?'
      : 'SELECT * FROM photos WHERE userId = ? AND deletedAt IS NULL';
    return this.db.prepare(sql).all(userId) as PhotoRow[];
  }
  listAllPhotos(opts?: { includeDeleted?: boolean }): PhotoRow[] {
    const sql = opts?.includeDeleted
      ? 'SELECT * FROM photos'
      : 'SELECT * FROM photos WHERE deletedAt IS NULL';
    return this.db.prepare(sql).all() as PhotoRow[];
  }

  // ---------------- refresh tokens ----------------
  insertRefresh(row: RefreshRow): void {
    this.db
      .prepare(
        `INSERT INTO refresh_tokens (token, userId, createdAt, expiresAt)
         VALUES (@token, @userId, @createdAt, @expiresAt)
         ON CONFLICT(token) DO UPDATE SET userId=excluded.userId, createdAt=excluded.createdAt, expiresAt=excluded.expiresAt`,
      )
      .run(row);
  }
  getRefresh(token: string): RefreshRow | undefined {
    const row = asRecord<RefreshRow>(
      this.db.prepare('SELECT * FROM refresh_tokens WHERE token = ?').get(token),
    );
    if (!row) return undefined;
    if (row.expiresAt <= Date.now()) {
      this.deleteRefresh(token);
      return undefined;
    }
    return row;
  }
  deleteRefresh(token: string): void {
    this.db.prepare('DELETE FROM refresh_tokens WHERE token = ?').run(token);
  }

  // ---------------- idempotency ----------------
  getIdem(userId: string, key: string): IdempotencyRow | undefined {
    const row = this.db
      .prepare('SELECT * FROM idempotency WHERE userId = ? AND key = ?')
      .get(userId, key) as
      | { userId: string; key: string; status: number; body: string; createdAt: number; expiresAt: number }
      | undefined;
    if (!row) return undefined;
    if (row.expiresAt <= Date.now()) {
      this.db.prepare('DELETE FROM idempotency WHERE userId = ? AND key = ?').run(userId, key);
      return undefined;
    }
    return { ...row, body: JSON.parse(row.body) };
  }
  /**
   * 幂等落库：利用 (userId, key) 主键 + INSERT OR IGNORE，
   * 并发同 key 只进一条；返回是否「已存在（即本次是重放）」。
   */
  putIdem(row: IdempotencyRow): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO idempotency (userId, key, status, body, createdAt, expiresAt)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(row.userId, row.key, row.status, JSON.stringify(row.body), row.createdAt, row.expiresAt);
  }

  // ---------------- 回收 ----------------
  purgeSoftDeleted(retentionDays: number): { records: number; photos: number } {
    const cutoff = Date.now() - retentionDays * DAY_MS;

    const delRecords = this.db.prepare(
      'DELETE FROM records WHERE deletedAt IS NOT NULL AND deletedAt <= ?',
    );
    const records = delRecords.run(cutoff).changes;

    // 还被「未删除记录」引用的照片不算孤儿。
    // 引用判定：出现在任何未删除记录的 photoIds 里（一条记录最多 5 张）。
    const referenced = new Set<string>();
    const liveRows = this.db
      .prepare('SELECT photoIds FROM records WHERE deletedAt IS NULL')
      .all() as { photoIds: string | null }[];
    for (const r of liveRows) {
      for (const id of parsePhotoIds(r.photoIds)) referenced.add(id);
    }
    const orphanPhotos = this.db
      .prepare('SELECT id FROM photos WHERE deletedAt IS NOT NULL')
      .all() as { id: string }[];
    const stale = orphanPhotos.filter((p) => !referenced.has(p.id));
    let photos = 0;
    const delPhoto = this.db.prepare('DELETE FROM photos WHERE id = ?');
    for (const p of stale) {
      photos += delPhoto.run(p.id).changes;
    }
    return { records, photos };
  }
}
