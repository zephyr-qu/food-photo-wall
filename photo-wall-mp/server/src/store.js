/* ================================================================
   内存 store（唯一数据源）

   为什么是内存：这是 mock 后端，目标是「前端一次拿一页、带 hasMore、
   带 nextCursor 就能直接用」，不是持久化。进程退出即清空，
   所以联调/测试都用「重置」而不是「清理」。

   一致性要求（§7.4）：列表、城市计数、统计、店铺聚合、随机
   **必须来自同一份记录、同一删除口径**。因此这里只暴露一个
   `records` 数组 + `allOf(userId)`，聚合层不得自己缓存。

   软删：`deletedAt` 非空即不可见（列表/聚合/详情全部过滤），
   这样 DELETE 幂等（重复删 204）与未来 restore 都留了口子。
   ================================================================ */
/* global process */
import { REAL_RECORDS } from './data/records.js';
import { DEMO_RECORDS } from './data/demo-records.js';
import { deterministicId, newId } from './ids.js';
import { DEFAULT_TZ, atToUtcMs, toUtcIso } from './time.js';

/** 种子用户的固定 id：联调用现成 token，不必每次先登录 */
export const SEED_USER_ID = deterministicId('usr', Date.UTC(2026, 9, 1), 'seed-user');

/** 种子数据的「写入时刻」：固定值，保证重启后 createdAt 稳定 */
const SEED_CREATED_MS = Date.UTC(2026, 9, 10, 0, 0, 0);

/** 联调用的固定 token：启动即可直接 curl，不必先走登录换 token。
 *  仅 mock 环境存在，重置后依然可用。 */
export const DEV_ACCESS_TOKEN = 'dev-access-token';

/**
 * 新用户是否自动灌入 12 条示例记录（默认开启）。
 *
 * 为什么默认开：契约 §8.2 明确建议「预置 12 条改由服务端为新用户初始化」。
 * 不开的话，小程序 wx.login 拿到的是新账号 → GET /records 返回 0 条 →
 * 墙是空的，既没法联调也没法演示。
 *
 * 关掉的方式（测试 D-01 空数据态、或想验证真空用户）：
 *   - 环境变量 `SEED_NEW_USERS=0`
 *   - 代码里 `setSeedNewUsers(false)` 或 `resetStore({ seedNewUsers: false })`
 */
let seedNewUsers = process.env.SEED_NEW_USERS !== '0';

/** 环境变量给出的默认值：`SEED_NEW_USERS=0` 关闭。
 *  无参 resetStore() 回到这里，避免「一个用例关掉后污染后面所有用例」。 */
const SEED_NEW_USERS_DEFAULT = seedNewUsers;

/** 运行时开关（测试用；不传则读回当前值） */
export function setSeedNewUsers(on) {
  if (on === undefined) return seedNewUsers;
  seedNewUsers = !!on;
  return seedNewUsers;
}

/**
 * 种子是否附带演示数据（12 条契约数据之外的 89 条）。默认开。
 *
 * - 开：种子用户/新用户拿到 101 条 → 分页、月份分组、统计、随机、
 *   店铺聚合都有数据可测可演示；
 * - 关：回到「只有契约 12 条」的最小状态，供逐字断言的用例校验
 *   （也可用环境变量 `DEMO_SEED=0` 关掉整机演示数据）。
 */
let demoSeeds = process.env.DEMO_SEED !== '0';
const DEMO_SEED_DEFAULT = demoSeeds;

/** 运行时开关（测试用；不传则读回当前值） */
export function setDemoSeeds(on) {
  if (on === undefined) return demoSeeds;
  demoSeeds = !!on;
  return demoSeeds;
}

/** 契约 12 条（REAL_RECORDS）与演示数据的条数 —— 测试用，别在断言里硬编码 */
export const SEED_REAL_COUNT = REAL_RECORDS.length;
export const SEED_DEMO_COUNT = DEMO_RECORDS.length;

/** 当前配置下种子用户会被灌入的记录数（受 demo 开关影响） */
export function seedRecordCount() {
  return demoSeeds ? SEED_REAL_COUNT + SEED_DEMO_COUNT : SEED_REAL_COUNT;
}

let state = createEmptyState();

function createEmptyState() {
  return {
    users: new Map(), // userId -> user
    records: new Map(), // recordId -> record
    photos: new Map(), // photoId -> photo（含二进制字节）
    shops: new Map(), // shopId -> shop
    tokens: new Map(), // accessToken -> { userId, expiresAt }
    refreshTokens: new Map(), // refreshToken -> { userId, expiresAt }
    idempotency: new Map(), // `${userId}:${key}` -> { recordId, createdAt }
    wechatCodes: new Set(), // 已消费的 code（AC-02：同一 code 只能用一次）
    seq: 0, // 同毫秒写入的单调序号
  };
}

/** 重置为种子态。测试之间调它即可隔离（也可直接重新起进程）。
 *
 *  `seedNewUsers` 可覆盖「新用户自动灌示例数据」的开关，
 *  例如 `resetStore({ seedNewUsers: false })` 验证 D-01 空数据态。
 *  不传则**恢复成环境变量给的默认值** —— 否则一个用例关掉后，
 *  后面的用例会莫名其妙拿到空数据。
 *
 *  `demo: false` 让种子用户只灌 12 条契约数据（不灌演示数据）。
 *  需要「精确 12 条」断言的用例用它，比如校验与 core 逐字一致的用例。
 */
export function resetStore({
  seed = true,
  seedNewUsers: seedNewUsersOverride,
  demo = DEMO_SEED_DEFAULT,
} = {}) {
  state = createEmptyState();
  seedNewUsers = seedNewUsersOverride === undefined ? SEED_NEW_USERS_DEFAULT : !!seedNewUsersOverride;
  demoSeeds = demo;
  if (!seed) return;
  seedUser();
  seedRecordsFor(SEED_USER_ID, { deterministic: true, demo });
}

/** 只清空数据、保留结构（resetStore({seed:false}) 的别名，语义更清楚） */
export function clearStore() {
  resetStore({ seed: false });
}

function seedUser() {
  const user = {
    id: SEED_USER_ID,
    wechatOpenid: null,
    deviceId: null,
    createdAt: toUtcIso(SEED_CREATED_MS),
    isSample: true,
  };
  state.users.set(user.id, user);
  // 固定联调 token：有效期给足，联调期间不会突然 401
  state.tokens.set(DEV_ACCESS_TOKEN, {
    userId: user.id,
    expiresAt: Date.now() + 365 * 86400 * 1000,
  });
}

/**
 * 给某个用户灌入示例记录：12 条契约数据（REAL_RECORDS）+ 一批演示数据
 * （DEMO_RECORDS）。photo 一律 null（= 用包内预置图，契约 §2.4 ③）。
 *
 * 为什么要分两份：
 * · REAL_RECORDS 是**契约数据** —— core 单测、验收用例、docs/api 都逐字
 *   断言这 12 条，不能改；
 * · 但 12 条撑不起真实场景（只有一页、3 个月、7 个城市、「反复吃」永远空），
 *   所以额外造 DEMO_RECORDS 铺满 12 个月 / 33 城 / 89 条，让分页、月份分组、
 *   统计、随机、店铺都有东西可测。演示数据只在 mock 后端，不影响 core。
 *
 * id 的生成有两种模式：
 * - `deterministic: true`（种子用户）：`(eatenAtMs, 菜名)` 哈希，
 *   重启后 id 完全不变，联调/缓存/测试断言都能对上。
 * - `deterministic: false`（新注册用户）：运行时 ULID，**每个用户各不相同**，
 *   绝不能跨用户共享 id —— 否则 A 用户拿到 B 的 id，详情页会串号。
 *
 * @param {string} userId
 * @param {{deterministic?: boolean, demo?: boolean}} options
 *        `demo: false` 只灌 12 条契约数据（给断言「只有 12 条」的用例用）
 * @returns {number} 写入条数
 */
function seedRecordsFor(userId, { deterministic = false, demo = true } = {}) {
  let count = 0;
  const sources = demo
    ? [...REAL_RECORDS, ...DEMO_RECORDS]
    : [...REAL_RECORDS];

  for (const src of sources) {
    const eatenAtMs = atToUtcMs(src.at, DEFAULT_TZ);
    if (eatenAtMs === null) throw new Error(`种子数据 at 非法: ${src.at}`);
    /* 契约数据带 src.id（r1…r12），演示数据没有 —— 用菜名兜底。
       种子键里带上 at，避免「同名菜同一分钟」被哈希成同一个 id。 */
    const seedKey = `${src.id ?? 'demo'}:${src.eat}:${src.at}`;
    const id = deterministic
      ? deterministicId('rec', eatenAtMs, seedKey)
      : newId('rec');
    const shop = src.shop ?? null;
    const city = src.city ?? null;
    const shopId = shop ? ensureShop(userId, shop, city) : null;
    state.records.set(id, {
      id,
      userId,
      eat: src.eat,
      shop,
      shopId,
      city,
      district: src.district ?? null,
      rating: src.rating ?? 0,
      at: src.at,
      tzOffset: DEFAULT_TZ,
      eatenAtUtc: toUtcIso(eatenAtMs),
      eatenAtMs,
      note: src.note ?? null,
      photoId: null,
      photo: null,
      photoThumb: null,
      version: 1,
      createdAt: toUtcIso(SEED_CREATED_MS),
      updatedAt: toUtcIso(SEED_CREATED_MS),
      deletedAt: null,
      isSample: true,
      seq: nextSeq(),
    });
    count += 1;
  }
  return count;
}

/* ---------------- 用户 ---------------- */

export function findUser(userId) {
  return state.users.get(userId) || null;
}

export function upsertWechatUser(code) {
  // mock：任意 code 都成功；同一 openid 复用同一账号（openid 由 code 派生，便于重复登录）
  const openid = `mock_openid_${hashString(code)}`;
  for (const u of state.users.values()) {
    if (u.wechatOpenid === openid) return { user: u, isNew: false };
  }
  const user = {
    id: newId('usr'),
    wechatOpenid: openid,
    deviceId: null,
    createdAt: toUtcIso(Date.now()),
    isSample: false,
  };
  state.users.set(user.id, user);
  // 新用户初始化示例数据（§8.2）；已存在的用户不重复灌，否则删光后冷启动又会冒出来
  if (seedNewUsers) seedRecordsFor(user.id, { demo: demoSeeds });
  return { user, isNew: true };
}

export function upsertDeviceUser(deviceId) {
  for (const u of state.users.values()) {
    if (u.deviceId === deviceId) return { user: u, isNew: false };
  }
  const user = {
    id: newId('usr'),
    wechatOpenid: null,
    deviceId,
    createdAt: toUtcIso(Date.now()),
    isSample: false,
  };
  state.users.set(user.id, user);
  if (seedNewUsers) seedRecordsFor(user.id, { demo: demoSeeds });
  return { user, isNew: true };
}

/** AC-02：微信 code 一次性，重复消费 → 401 WECHAT_CODE_INVALID */
export function consumeWechatCode(code) {
  if (state.wechatCodes.has(code)) return false;
  state.wechatCodes.add(code);
  return true;
}

/* ---------------- token ---------------- */

export function issueTokens(userId, { accessTtlMs = 2 * 3600 * 1000, refreshTtlMs = 30 * 86400 * 1000 } = {}) {
  const accessToken = newId('at').toLowerCase() + Math.random().toString(36).slice(2, 10);
  const refreshToken = newId('rt') + Math.random().toString(36).slice(2, 10);
  state.tokens.set(accessToken, { userId, expiresAt: Date.now() + accessTtlMs });
  state.refreshTokens.set(refreshToken, { userId, expiresAt: Date.now() + refreshTtlMs });
  return { accessToken, refreshToken, expiresIn: Math.floor(accessTtlMs / 1000) };
}

export function findAccessToken(token) {
  return state.tokens.get(token) || null;
}

export function findRefreshToken(token) {
  return state.refreshTokens.get(token) || null;
}

export function revokeRefreshToken(token) {
  state.refreshTokens.delete(token);
}

/** 测试用：让指定 accessToken 立即过期（AC-03 / D-18） */
export function expireAccessToken(token) {
  const t = state.tokens.get(token);
  if (t) t.expiresAt = 0;
}

/* ---------------- 记录 ---------------- */

/** 当前用户的全部**未删除**记录（唯一读取入口） */
export function allOf(userId) {
  const out = [];
  for (const r of state.records.values()) {
    if (r.userId === userId && r.deletedAt === null) out.push(r);
  }
  return out;
}

/** 含已删除（restore / 幂等删除判定用） */
export function rawOf(userId, id) {
  const r = state.records.get(id);
  if (!r || r.userId !== userId) return null;
  return r;
}

/** 单条（未删除才返回）—— 不存在/别人的/已删统一 null → 404 */
export function findRecord(userId, id) {
  const r = rawOf(userId, id);
  return r && r.deletedAt === null ? r : null;
}

export function insertRecord(record) {
  state.records.set(record.id, record);
  return record;
}

/** 下一个写入序号：同毫秒多条时给 id 兜底一个稳定次序 */
export function nextSeq() {
  return ++state.seq;
}

/* ---------------- 照片 ---------------- */

export function insertPhoto(photo) {
  state.photos.set(photo.id, photo);
  return photo;
}

export function findPhoto(userId, photoId) {
  const p = state.photos.get(photoId);
  if (!p || p.userId !== userId || p.deletedAt) return null;
  return p;
}

export function photoBytes(photoId) {
  const p = state.photos.get(photoId);
  return p && !p.deletedAt ? p : null;
}

/** 该照片是否还被任何未删除记录引用（删除级联用） */
export function photoInUse(photoId) {
  for (const r of state.records.values()) {
    if (r.deletedAt === null && r.photoId === photoId) return true;
  }
  return false;
}

/* ---------------- 店铺 ---------------- */

/** (userId, name, city) 唯一；同一店名跨城市视为两家店（§4.1） */
export function ensureShop(userId, name, city) {
  for (const s of state.shops.values()) {
    if (s.userId === userId && s.name === name && s.city === city) return s.id;
  }
  const shop = {
    id: newId('shp'),
    userId,
    name,
    city,
    createdAt: toUtcIso(Date.now()),
  };
  state.shops.set(shop.id, shop);
  return shop.id;
}

export function findShop(userId, shopId) {
  const s = state.shops.get(shopId);
  if (!s || s.userId !== userId) return null;
  return s;
}

export function shopsOf(userId) {
  return [...state.shops.values()].filter((s) => s.userId === userId);
}

/* ---------------- 幂等键 ---------------- */

const IDEMPOTENCY_TTL_MS = 24 * 3600 * 1000;

export function getIdempotent(userId, key) {
  if (!key) return null;
  const hit = state.idempotency.get(`${userId}:${key}`);
  if (!hit) return null;
  if (Date.now() - hit.createdAt > IDEMPOTENCY_TTL_MS) {
    state.idempotency.delete(`${userId}:${key}`);
    return null;
  }
  return hit;
}

export function setIdempotent(userId, key, recordId) {
  if (!key) return;
  state.idempotency.set(`${userId}:${key}`, { recordId, createdAt: Date.now() });
}

/* ---------------- 内部工具 ---------------- */

function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(36);
}

resetStore();
