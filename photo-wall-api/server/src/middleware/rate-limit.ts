/**
 * 限流（契约 §3.5）：滑动窗口。
 *
 * ---------- 为什么 key 的选择是安全关键 ----------
 * 限流的效果**完全取决于 key 是否可被客户端控制**。
 * 曾经的实现是：
 *   `userId ?? X-Forwarded-For 第一段 ?? X-Real-IP ?? 'anonymous'`
 * 问题在于，直连部署时 `X-Forwarded-For` 是**客户端自己发的请求头** ——
 * 攻击者每次换一个假 IP 就能无限绕过（实测：换着 IP 打 30 次、全部通过）。
 * 这比"没有限流"更糟：它看起来有限流，日志里却一切正常。
 *
 * 现在的策略：
 *   1. **已登录** → 用 userId（最可靠，攻击者要绕过就得不断注册新账号，
 *      而注册本身也受限流）；
 *   2. **未登录** → 用 IP。IP 必须来自**不可伪造的来源**：
 *      - `trustProxy=false`（默认，直连）→ TCP 对端地址（`getConnInfo`）；
 *      - `trustProxy=true`（在自家反代后）→ `X-Forwarded-For` 的**最右一跳**。
 *
 * ---------- 为什么取"最右"而不是"最左" ----------
 * `X-Forwarded-For: <客户端可伪造>, <客户端可伪造>, ..., <我的代理追加>`
 * 每一跳代理都在**右边追加**真实来源。最左边的值完全由客户端控制（随便写），
 * 只有最右边那一跳是离我们最近的、由可信代理写入的地址。
 * 常见错误是取 `split(',')[0]`（最左），那正好取到了客户端伪造的值。
 *
 * ---------- 内存实现 vs Redis ----------
 * 本文件是**单进程内存**实现：多实例部署时每个实例各算各的，实际额度是
 * `max × 实例数`；进程重启后计数清零。接口形状（`rateLimit({max, windowMs})`）
 * 与存储无关，将来换 Redis（INCR + EXPIRE）只需替换 `HitStore`，
 * 中间件与路由代码不用动。
 */
import { getConnInfo } from '@hono/node-server/conninfo';
import { createMiddleware } from 'hono/factory';
import { err } from '../lib/errors.js';
import type { AppEnv } from '../types.js';

/** 计数器存储。换 Redis 时实现这个接口即可。 */
export interface HitStore {
  /** 记录一次命中；返回当前窗口内的命中序列（升序时间戳） */
  hit(key: string, now: number, windowMs: number): number[];
}

/**
 * 内存滑动窗口。
 *
 * 每个 key 存时间戳数组；读取时顺手把窗口外的丢掉。
 * 另外用低频 sweep 回收"已经完全过期但再也不会被访问"的 key，
 * 否则被扫描/爬虫打过的 key 会一直留在 Map 里（内存泄漏）。
 */
class MemoryHitStore implements HitStore {
  private readonly hits = new Map<string, number[]>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly sweepIntervalMs = 60_000) {}

  hit(key: string, now: number, windowMs: number): number[] {
    this.ensureSweep(windowMs);
    const cutoff = now - windowMs;
    const prev = this.hits.get(key) ?? [];
    /* 只保留窗口内的（数组天然升序，找到第一个 > cutoff 即可） */
    let from = 0;
    while (from < prev.length && (prev[from] as number) <= cutoff) from += 1;
    const kept = from === 0 ? prev : prev.slice(from);
    kept.push(now);
    this.hits.set(key, kept);
    return kept;
  }

  /** 定期清理所有 key 的过期时间戳，删掉空数组 */
  private ensureSweep(windowMs: number): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => {
      const cutoff = Date.now() - windowMs;
      for (const [k, list] of this.hits) {
        const last = list[list.length - 1];
        /* 整个数组都早于窗口 → 直接删 key（这是最省事的回收判据） */
        if (last === undefined || last <= cutoff) {
          this.hits.delete(k);
          continue;
        }
        let from = 0;
        while (from < list.length && (list[from] as number) <= cutoff) from += 1;
        if (from > 0) this.hits.set(k, list.slice(from));
      }
    }, this.sweepIntervalMs);
    this.sweepTimer.unref?.();
  }

  /** 测试用：当前 key 数量（验证回收是否生效） */
  size(): number {
    return this.hits.size;
  }

  /** 测试用：停止 sweep 定时器 */
  stop(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }
}

export interface RateLimitOptions {
  max: number;
  windowMs?: number;
  /** 是否信任反代头（来自 Config.trustProxy） */
  trustProxy?: boolean;
  /** 自定义 key（一般不用；默认按"已登录 userId / 未登录 IP"） */
  keyOf?: (c: {
    get: (k: 'userId') => string | undefined;
    req: { header: (n: string) => string | undefined };
  }) => string;
  /** 注入存储（测试或换 Redis 用） */
  store?: HitStore;
}

/**
 * 从请求里取**不可伪造的**客户端 IP。
 *
 * @returns IP 字符串；拿不到时返回 `'unknown'`（所有 unknown 共享一个桶，
 *          宁可误伤也不放行 —— 但正常部署下 getConnInfo 一定拿得到）
 */
export function clientIp(
  c: { env: unknown; req: { header: (n: string) => string | undefined } },
  trustProxy: boolean,
): string {
  if (trustProxy) {
    /* 最右一跳：由最近的可信代理追加，客户端无法伪造到那个位置 */
    const xff = c.req.header('X-Forwarded-For');
    if (xff) {
      const hops = xff.split(',').map((s) => s.trim()).filter(Boolean);
      const rightmost = hops[hops.length - 1];
      if (rightmost) return rightmost;
    }
    const realIp = c.req.header('X-Real-IP')?.trim();
    if (realIp) return realIp;
  }

  /* 直连：用 TCP 对端地址，客户端无法伪造 */
  try {
    const info = getConnInfo(c as never);
    const addr = info.remote.address;
    if (addr) return addr;
  } catch {
    /* 非 node-server 运行时（如测试直接 app.request()）拿不到 socket */
  }
  return 'unknown';
}

export function rateLimit(opts: RateLimitOptions) {
  const windowMs = opts.windowMs ?? 60_000;
  const trustProxy = opts.trustProxy ?? false;
  const store = opts.store ?? new MemoryHitStore();

  return createMiddleware<AppEnv>(async (c, next) => {
    const key =
      opts.keyOf?.(c as never) ??
      c.get('userId') ??
      clientIp(c as never, trustProxy);

    const now = Date.now();
    const list = store.hit(key, now, windowMs);

    /* 命中数超过上限：list 里已经包含本次，所以判断 >= max+1 才对；
       但语义上"第 max+1 次请求被拒"，等价于 list.length > max。 */
    if (list.length > opts.max) {
      const oldest = list[0] as number;
      const retryAfterSec = (oldest + windowMs - now) / 1000;
      throw err.rateLimited(retryAfterSec);
    }
    await next();
  });
}

/** 测试/运维用：内存存储的构造器（可注入自定义 sweep 间隔） */
export function createMemoryHitStore(sweepIntervalMs?: number): MemoryHitStore {
  return new MemoryHitStore(sweepIntervalMs);
}
