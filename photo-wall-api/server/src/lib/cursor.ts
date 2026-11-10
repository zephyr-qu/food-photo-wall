/**
 * 游标分页（契约 §3.3 / §7.2）
 *   cursor = base64url({ v:1, at:'<eatenAtUtc>', id:'<id>' })
 *   keyset = (eaten_at_utc DESC, id DESC)，翻页条件为严格 (at,id) < cursor
 * 不重不漏：同分钟多条靠 id 兜底；翻页期间新增记录不会导致重复。
 */
import { err } from './errors.js';

export interface Cursor {
  /** eatenAtUtc，RFC3339 UTC */
  at: string;
  id: string;
}

const CURSOR_VERSION = 1;

export function encodeCursor(c: Cursor): string {
  const payload = JSON.stringify({ v: CURSOR_VERSION, at: c.at, id: c.id });
  return Buffer.from(payload, 'utf8').toString('base64url');
}

export function decodeCursor(raw: string): Cursor {
  let json: unknown;
  try {
    // 兼容标准 base64（+/）与 base64url（-_），便于手写 curl 调试
    const normalized = raw.replace(/-/g, '+').replace(/_/g, '/');
    json = JSON.parse(Buffer.from(normalized, 'base64').toString('utf8'));
  } catch {
    throw err.badRequest('cursor 无法解析');
  }
  if (!json || typeof json !== 'object') throw err.badRequest('cursor 无法解析');
  const o = json as Record<string, unknown>;
  if (typeof o.at !== 'string' || typeof o.id !== 'string') throw err.badRequest('cursor 结构不合法');
  if (Number.isNaN(Date.parse(o.at))) throw err.badRequest('cursor.at 不是合法时间');
  return { at: o.at, id: o.id };
}

/** 比较两条记录的排序键：返回 <0 表示 a 更新（排在前面） */
export function compareSortKey(
  a: { eatenAtUtc: string; id: string },
  b: { eatenAtUtc: string; id: string },
): number {
  const ta = Date.parse(a.eatenAtUtc);
  const tb = Date.parse(b.eatenAtUtc);
  if (ta !== tb) return tb - ta; // 时间倒序
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0; // id 倒序兜底
}

/** 判断 row 是否严格排在 cursor 之后（用于 keyset 翻页） */
export function isAfterCursor(row: { eatenAtUtc: string; id: string }, cursor: Cursor): boolean {
  return compareSortKey(row, { eatenAtUtc: cursor.at, id: cursor.id }) > 0;
}

/**
 * 判断 row 是否排在 cursor **之后或正好等于它**。
 *
 * 用于"从某条开始"的跳转（`cursorInclusive=true`）。典型场景是月轴：
 * `/records/months` 的 `firstCursorInclusive` 指向该月最新一条，调用方
 * 需要**包含**它，否则每次跳月都漏掉当月第一张 —— 这是 keyset 严格 `<`
 * 语义最容易踩的坑。
 */
export function isAtOrAfterCursor(
  row: { eatenAtUtc: string; id: string },
  cursor: Cursor,
): boolean {
  return compareSortKey(row, { eatenAtUtc: cursor.at, id: cursor.id }) >= 0;
}

export function sortedDesc<T extends { eatenAtUtc: string; id: string }>(rows: T[]): T[] {
  return [...rows].sort(compareSortKey);
}
