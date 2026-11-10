import type {
  IdempotencyRow,
  PhotoRow,
  RecordRow,
  RefreshRow,
  ShopRow,
  UserRow,
} from './types.js';

export interface ListRecordsOptions {
  includeDeleted?: boolean;
}

/**
 * 存储接口。
 *   · MemoryStore  —— 纯内存，零依赖，仅测试/本地零配置联调（不持久）；
 *   · SqliteStore  —— 单文件 SQLite（better-sqlite3），ACID + 跨重启持久，
 *                     单机生产推荐，比 PostgreSQL 轻得多。
 * 两者都实现同一接口，服务层零改动。
 */
export interface Store {
  readonly kind: 'memory' | 'sqlite' | 'postgres';

  // ---- users ----
  getUser(id: string): UserRow | undefined;
  findUserByOpenid(openid: string): UserRow | undefined;
  findUserByDevice(deviceId: string): UserRow | undefined;
  insertUser(row: UserRow): void;
  updateUser(row: UserRow): void;

  // ---- records ----
  getRecord(id: string): RecordRow | undefined;
  insertRecord(row: RecordRow): void;
  updateRecord(row: RecordRow): void;
  listRecords(userId: string, opts?: ListRecordsOptions): RecordRow[];
  /**
   * 只数条数，不把行全读出来。
   *
   * 为什么单独开一个：登录接口要返回 `recordCount`（会话里带的用户信息）。
   * 以前用 `listRecords(userId).length` —— 那会把**这个用户的每一行记录
   * 都读进内存**（含 JSON 解析）只为拿一个数字。登录在每次 token 失效后
   * 都会被触发，客户端并发重登时就是好几次全表扫描。
   */
  countRecords(userId: string): number;

  // ---- shops ----
  getShop(id: string): ShopRow | undefined;
  insertShop(row: ShopRow): void;
  findShopByNameCity(userId: string, name: string, city: string | null): ShopRow | undefined;
  listShopsByName(userId: string, name: string): ShopRow[];
  listShops(userId: string): ShopRow[];

  // ---- photos ----
  getPhoto(id: string): PhotoRow | undefined;
  /**
   * 一次拿多条照片（按传入顺序返回，缺失的跳过）。
   *
   * 为什么需要：一条记录最多 5 张照片，列表一页 20 条 → 最多 100 次
   * 单行查询。SQLite 单行查询很快，但 100 次也是 100 次往返与语句准备。
   * 批量查把它压成 1 条 `WHERE id IN (...)`。
   */
  getPhotos(ids: string[]): PhotoRow[];
  insertPhoto(row: PhotoRow): void;
  updatePhoto(row: PhotoRow): void;
  listPhotos(userId: string, opts?: { includeDeleted?: boolean }): PhotoRow[];
  /** 全量照片（跨用户）：仅供回收任务使用，不要用在请求路径上 */
  listAllPhotos(opts?: { includeDeleted?: boolean }): PhotoRow[];

  // ---- refresh tokens ----
  insertRefresh(row: RefreshRow): void;
  getRefresh(token: string): RefreshRow | undefined;
  deleteRefresh(token: string): void;

  // ---- idempotency ----
  getIdem(userId: string, key: string): IdempotencyRow | undefined;
  putIdem(row: IdempotencyRow): void;

  // ---- lifecycle ----
  flush(): Promise<void>;
  close(): Promise<void>;

  // ---- 回收（软删过期清理） ----
  /**
   * 物理删除「超过保留期的软删记录」与「不再被引用且已软删的照片」。
   *
   * 为什么要它：软删只是打 `deletedAt` 标记，数据一直留在库里/磁盘上。
   * 不清理的话：
   *   · 记录表无限增长（用户删了 1000 条，库里还是 1000 条）；
   *   · `var/uploads` 里的照片永远不删（软删期间要留着以便 restore，
   *     但过了撤销窗口就该回收）。
   * 本方法由**定时任务**或**运维手动**调用，不在请求路径上。
   *
   * @param retentionDays 软删保留天数（通常 = restoreWindowDays）
   * @returns 被清理的记录数 / 照片数，便于日志与测试断言
   */
  purgeSoftDeleted(retentionDays: number): { records: number; photos: number };
}
