/**
 * 认证服务（契约 §6.1）：
 *   accessToken  = JWT（HS256，2h）
 *   refreshToken = 不透明随机串（30d，轮换：旧的一次性作废）
 *   数据一律按 userId 隔离；别人的资源返回 404 而不是 403。
 */
import { sign, verify } from 'hono/jwt';
import { JwtTokenExpired } from 'hono/utils/jwt/types';
import type { Config } from '../config.js';
import { err } from '../lib/errors.js';
import { newId, newOpaqueToken } from '../lib/ids.js';
import { formatTzOffset, formatUtcIso, localToUtcMs, nowMs, parseAtLocal, parseTzOffset } from '../lib/time.js';
import type { Store } from '../store/store.js';
import type { RecordRow, UserRow } from '../store/types.js';
import { SEED_RECORDS } from '../data/seed-records.js';
import { findOrCreateShop } from './shop-resolver.js';

export interface SessionDto {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  tokenType: 'Bearer';
  userId: string;
  isNewUser: boolean;
  user: { id: string; createdAt: string; recordCount: number };
}

interface AccessPayload {
  sub: string;
  typ: 'access';
  iat: number;
  exp: number;
  [key: string]: unknown;
}

export class AuthService {
  /** 已消费的微信 code（strictWechatCodes 开启时强制一次性） */
  private readonly consumedCodes = new Set<string>();

  constructor(
    private readonly store: Store,
    private readonly cfg: Config,
  ) {}

  // ---------------------------------------------------------- 登录

  async wechatLogin(code: string, tzOffset?: string): Promise<SessionDto> {
    if (this.cfg.strictWechatCodes) {
      if (this.consumedCodes.has(code)) throw err.wechatCodeInvalid();
      this.consumedCodes.add(code);
    }
    const openid = await this.resolveOpenid(code);
    let user = this.store.findUserByOpenid(openid);
    const isNewUser = !user;
    if (!user) user = this.createUser({ wechatOpenid: openid }, tzOffset);
    return this.session(user, isNewUser);
  }

  async anonymousLogin(deviceId: string, tzOffset?: string): Promise<SessionDto> {
    let user = this.store.findUserByDevice(deviceId);
    const isNewUser = !user;
    if (!user) user = this.createUser({ deviceId }, tzOffset);
    return this.session(user, isNewUser);
  }

  async refresh(refreshToken: string): Promise<Omit<SessionDto, 'userId' | 'isNewUser' | 'user'>> {
    const row = this.store.getRefresh(refreshToken);
    if (!row) throw err.tokenInvalid('refreshToken 无效或已过期');
    // 轮换：旧的立即失效，防止重放
    this.store.deleteRefresh(refreshToken);
    const pair = await this.issueTokens(row.userId);
    return {
      accessToken: pair.accessToken,
      refreshToken: pair.refreshToken,
      expiresIn: pair.expiresIn,
      tokenType: 'Bearer',
    };
  }

  /** 校验 accessToken，返回 userId（中间件用） */
  async verifyAccess(token: string): Promise<string> {
    let payload: unknown;
    try {
      payload = await verify(token, this.cfg.jwtSecret, 'HS256');
    } catch (e) {
      if (e instanceof JwtTokenExpired) throw err.tokenExpired();
      throw err.tokenInvalid();
    }
    const p = payload as Partial<AccessPayload> | null;
    if (!p || typeof p.sub !== 'string' || p.typ !== 'access') throw err.tokenInvalid();
    return p.sub;
  }

  // ---------------------------------------------------------- 内部

  private async issueTokens(
    userId: string,
  ): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
    const iat = Math.floor(nowMs() / 1000);
    const exp = iat + this.cfg.accessTtlSec;
    const payload: AccessPayload = { sub: userId, typ: 'access', iat, exp };
    const accessToken = await sign(payload, this.cfg.jwtSecret, 'HS256');

    const refreshToken = newOpaqueToken('rt');
    this.store.insertRefresh({
      token: refreshToken,
      userId,
      createdAt: nowMs(),
      expiresAt: nowMs() + this.cfg.refreshTtlSec * 1000,
    });
    return { accessToken, refreshToken, expiresIn: this.cfg.accessTtlSec };
  }

  private async session(user: UserRow, isNewUser: boolean): Promise<SessionDto> {
    const pair = await this.issueTokens(user.id);
    return {
      ...pair,
      tokenType: 'Bearer',
      userId: user.id,
      isNewUser,
      user: {
        id: user.id,
        createdAt: formatUtcIso(user.createdAt),
        /* 只数条数，不把用户的所有记录行读进内存（见 Store.countRecords） */
        recordCount: this.store.countRecords(user.id),
      },
    };
  }

  private createUser(ids: { wechatOpenid?: string; deviceId?: string }, tzOffset?: string): UserRow {
    const now = nowMs();
    const user: UserRow = {
      id: newId('usr'),
      wechatOpenid: ids.wechatOpenid ?? null,
      deviceId: ids.deviceId ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.store.insertUser(user);
    /* 种子数据要用**用户自己的**时区（登录请求头带过来的），
       否则非东八区的用户看到的月份归属是错的。头没带才回落服务端默认。 */
    if (this.cfg.seedDemoRecords) {
      const offset =
        (tzOffset ? parseTzOffset(tzOffset) : null) ?? parseTzOffset(this.cfg.defaultTzOffset) ?? 480;
      this.seedDemoRecords(user.id, formatTzOffset(offset));
    }
    return user;
  }

  /**
   * 新用户示例数据（§11 待确认 2，默认关；AC-01 要求新用户 recordCount=0）
   *
   * ⚠⚠ **时间必须相对 now 生成，不能用 SEED_RECORDS 里硬编码的日期。**
   *
   * 以前这里是 `atLocal: seed.at` —— 直接抄预置数据里那个
   * '2026-10-09T12:30'。后果是：用户今天注册，看到的是一条
   * 「刚创建却标着半年前」的记录；而随时间推移，这个硬编码日期会
   * 越来越不像真的。更糟的是它带着 `defaultTzOffset`（默认 +08:00），
   * 非东八区的用户看到的月份归属都是错的。
   *
   * 现在改成：
   *   · **日期**：保留种子之间的**相对间隔**（哪条隔了几天），但把整条
   *     时间线**平移到今天** —— 于是 12 条记录散落在最近两个多月，
   *     最新的那条就是「今天」，看起来像用户最近真的吃了这些；
   *   · **时刻**：保留种子原值（12:30 / 08:40…）—— 早上 8 点吃热干面、
   *     晚上 8 点吃钵钵鸡是有意义的搭配；
   *   · **时区**：用**用户自己的**偏移（登录请求头 `X-Timezone-Offset`），
   *     而不是服务端默认。
   */
  private seedDemoRecords(userId: string, tzOffset: string): void {
    const offset = parseTzOffset(tzOffset) ?? parseTzOffset(this.cfg.defaultTzOffset) ?? 480;
    const now = nowMs();

    /* 先算出每条种子相对「最新那条」差几天（相对间隔要保留） */
    const newest = newestSeedDay();

    for (const seed of SEED_RECORDS) {
      const parts = parseAtLocal(seed.at);
      if (!parts) continue;
      const shop = seed.shop ? findOrCreateShop(this.store, userId, seed.shop, seed.city) : null;

      const atLocal = this.shiftSeedDate(seed.at, newest, offset, now);

      const row: RecordRow = {
        id: newId('rec'),
        userId,
        eat: seed.eat,
        shop: shop?.name ?? null,
        shopId: shop?.id ?? null,
        city: seed.city,
        district: seed.district,
        rating: seed.rating,
        atLocal,
        tzOffset,
        eatenAtUtc: new Date(localToUtcMs(parseAtLocal(atLocal)!, offset))
          .toISOString()
          .replace(/\.\d{3}Z$/, 'Z'),
        note: seed.note,
        /* 预置数据不带照片：前端 photoOf() 会回落到包内预置配图，无需真实 CDN 图 */
        photoIds: [],
        version: 1,
        createdAt: nowMs(),
        updatedAt: nowMs(),
        deletedAt: null,
        /* 示例数据同样默认不分享（契约 §11 #10） */
        shareToken: null,
        sharedAt: null,
      };
      this.store.insertRecord(row);
    }
  }

  /**
   * 把种子记录的时间**平移**到「最近」。
   *
   * 做法：算出这条种子比「最新的那条种子」早几天，然后从**今天**往前推
   * 同样的天数。于是：
   *   · 相对间隔完全保留（还是「甜水面 → 冰粉 → 跷脚牛肉…」那个节奏）
   *   · 最新的那条落在今天（而不是 2026 年某个固定日子）
   *   · 整体散落在最近两个多月 —— 像一个真实用户两个多月的记录
   *
   * ⚠ 时刻保留种子原值，但如果「今天 + 那个时刻」已经过去了
   *   （比如现在 14:00，而种子的时刻是 20:15），这条就会落到**未来** ——
   *   服务端自己的 `assertAtInRange` 会拒（虽然种子不走那条路径，但
   *   列表/筛选口径会乱）。所以这种情况整体再退一天。
   *
   * @param seedAt 种子里的 'YYYY-MM-DDTHH:mm'
   * @param newest 最新那条种子的 'YYYY-MM-DD'
   * @param offset 该用户的时区偏移（分钟）
   * @param now 当前 epoch ms
   * @returns 平移后的 'YYYY-MM-DDTHH:mm'
   */
  private shiftSeedDate(seedAt: string, newest: string, offset: number, now: number): string {
    const parts = parseAtLocal(seedAt);
    if (!parts) return seedAt;

    /* 这条种子比最新那条早几天（daysBetween(a,b)=b−a，所以 a=本条、b=最新） */
    const daysBack = daysBetween(seedAt.slice(0, 10), newest);

    /* 用户所在时区的「今天」（服务端可能部署在别的时区） */
    const todayLocal = new Date(now + offset * 60_000);
    const todayY = todayLocal.getUTCFullYear();
    const todayM = todayLocal.getUTCMonth() + 1;
    const todayD = todayLocal.getUTCDate();

    /* 平移：今天 - daysBack */
    const shifted = shiftDays(todayY, todayM, todayD, -daysBack);

    const hh = String(parts.hour).padStart(2, '0');
    const mm = String(parts.minute).padStart(2, '0');
    let result = `${shifted.y}-${pad2(shifted.m)}-${pad2(shifted.d)}T${hh}:${mm}`;

    /* 结果不能是未来：整体再退一天 */
    const nowLocal = new Date(now + offset * 60_000);
    const nowLocalStr = `${nowLocal.getUTCFullYear()}-${pad2(nowLocal.getUTCMonth() + 1)}-${pad2(
      nowLocal.getUTCDate(),
    )}T${pad2(nowLocal.getUTCHours())}:${pad2(nowLocal.getUTCMinutes())}`;
    if (result > nowLocalStr) {
      const back = shiftDays(shifted.y, shifted.m, shifted.d, -1);
      result = `${back.y}-${pad2(back.m)}-${pad2(back.d)}T${hh}:${mm}`;
    }
    return result;
  }

  /** 微信 code → openid。未配置 appid/secret 时走开发模式（code 直接当 openid） */
  private async resolveOpenid(code: string): Promise<string> {
    const { appId, secret } = this.cfg.wechat;
    if (!appId || !secret) return `dev:${code}`;

    const url = new URL('https://api.weixin.qq.com/sns/jscode2session');
    url.searchParams.set('appid', appId);
    url.searchParams.set('secret', secret);
    url.searchParams.set('js_code', code);
    url.searchParams.set('grant_type', 'authorization_code');

    let res: Response;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    } catch {
      throw err.wechatCodeInvalid('微信登录服务不可用');
    }
    if (!res.ok) throw err.wechatCodeInvalid(`微信登录失败（HTTP ${res.status}）`);
    const data = (await res.json()) as {
      openid?: string;
      errcode?: number;
      errmsg?: string;
    };
    if (data.errcode) throw err.wechatCodeInvalid(data.errmsg ?? '微信 code 无效');
    if (!data.openid) throw err.wechatCodeInvalid();
    return data.openid;
  }
}

/** 两位补零。 */
function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * 最新那条种子的日期（'YYYY-MM-DD'）。
 *
 * 种子数据是按「最近 → 最早」排的，所以第一条就是最新的。
 * 它的日期被当作「锚点」：所有别的种子相对它差几天，平移时保持这个差。
 */
function newestSeedDay(): string {
  let newest = SEED_RECORDS[0]?.at.slice(0, 10) ?? '';
  for (const s of SEED_RECORDS) {
    const day = s.at.slice(0, 10);
    if (day > newest) newest = day;
  }
  return newest;
}

/**
 * 两个 'YYYY-MM-DD' 之间差几天（b - a）。
 *
 * ⚠ 用 UTC 算，不转本地时间戳 —— `new Date(y, m-1, d)` 在本地时区下
 * 按本地零点解析，跨时区时会差一天。
 */
function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  const ta = Date.UTC(ay, am - 1, ad);
  const tb = Date.UTC(by, bm - 1, bd);
  return Math.round((tb - ta) / 86_400_000);
}

/**
 * (y, m, d) 加减若干天，返回 { y, m, d }。
 *
 * ⚠ 同样用 UTC 算：`Date.UTC` 会自动处理跨月/跨年/闰年，
 * 不需要自己判断「这个月有几天」。
 */
function shiftDays(y: number, m: number, d: number, days: number): { y: number; m: number; d: number } {
  const t = Date.UTC(y, m - 1, d) + days * 86_400_000;
  const dt = new Date(t);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}
