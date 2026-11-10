/**
 * 时间口径（契约 §3.4 / §2.4 ①）：
 *   at         = 'YYYY-MM-DDTHH:mm' 本地墙钟、定宽、无时区、无秒 —— 硬契约，绝不下发 Z/偏移
 *   tzOffset   = '±HH:mm'
 *   eatenAtUtc = RFC3339 UTC，仅用于排序/游标/跨时区
 *   months 归桶用 atLocal.slice(0,7)，**不是** UTC（否则 +08:00 的 11-01 00:00 会掉到 10 月）
 */

const AT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const TZ_RE = /^([+-])(\d{2}):(\d{2})$/;
const RFC3339_RE =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2})$/;

export interface AtParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

/** 严格解析 atLocal；非法返回 null（含 2026-02-30 这类假日期） */
export function parseAtLocal(value: string): AtParts | null {
  const m = AT_RE.exec(value);
  if (!m) return null;
  const [year, month, day, hour, minute] = m.slice(1).map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;
  // 用 UTC 回环校验真实日期（如 2 月 30 日会进位）
  const d = new Date(Date.UTC(year, month - 1, day, hour, minute));
  if (
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() !== month - 1 ||
    d.getUTCDate() !== day ||
    d.getUTCHours() !== hour ||
    d.getUTCMinutes() !== minute
  ) {
    return null;
  }
  return { year, month, day, hour, minute };
}

/** '±HH:mm' → 分钟数；非法返回 null（小时 ≤ 14、分钟 < 60） */
export function parseTzOffset(value: string): number | null {
  const m = TZ_RE.exec(value);
  if (!m) return null;
  const sign = m[1] === '-' ? -1 : 1;
  const hh = Number(m[2]);
  const mm = Number(m[3]);
  if (hh > 14 || mm > 59) return null;
  if (hh === 14 && mm !== 0) return null;
  return sign * (hh * 60 + mm);
}

export function formatTzOffset(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `${sign}${hh}:${mm}`;
}

/** 本地墙钟 + 偏移 → UTC 毫秒 */
export function localToUtcMs(at: AtParts, tzOffsetMinutes: number): number {
  return Date.UTC(at.year, at.month - 1, at.day, at.hour, at.minute) - tzOffsetMinutes * 60_000;
}

/** UTC 毫秒 + 偏移 → 'YYYY-MM-DDTHH:mm'（写入 atLocal 用） */
export function utcMsToAtLocal(utcMs: number, tzOffsetMinutes: number): string {
  const d = new Date(utcMs + tzOffsetMinutes * 60_000);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getUTCFullYear(), 4)}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}:${p(d.getUTCMinutes())}`;
}

/** RFC3339（可带 Z / 偏移）→ 毫秒；非法返回 null */
export function parseRfc3339(value: string): number | null {
  const m = RFC3339_RE.exec(value);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, frac, tz] = m;
  const tzMin = tz === 'Z' ? 0 : parseTzOffset(tz);
  if (tzMin === null) return null;
  const ms = Math.floor(Number(`0.${(frac ?? '0').padEnd(3, '0').slice(0, 3)}`) * 1000);
  const utc = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s ?? 0), ms);
  return utc - tzMin * 60_000;
}

/** RFC3339 里的偏移（分钟）；'Z' → 0 */
export function rfc3339OffsetMinutes(value: string): number | null {
  const m = RFC3339_RE.exec(value);
  if (!m) return null;
  const tz = m[8];
  if (tz === 'Z') return 0;
  return parseTzOffset(tz);
}

/** UTC 毫秒 → '2026-10-09T04:30:00Z'（无毫秒，对齐文档示例） */
export function formatUtcIso(utcMs: number): string {
  return new Date(utcMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * UTC 毫秒 → '2026-10-09T04:31:02.123Z'（带毫秒）。
 * 用于 createdAt/updatedAt 等审计字段：同一秒内的连续编辑也要能看出变化（AC-17）。
 */
export function formatUtcIsoMs(utcMs: number): string {
  return new Date(utcMs).toISOString();
}

export const nowMs = (): number => Date.now();

export const addDays = (ms: number, days: number): number => ms + days * 86_400_000;

/** 'YYYY-MM-DD' 严格校验（用于 from/to） */
export function isValidDateOnly(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return (
    d.getUTCFullYear() === Number(m[1]) &&
    d.getUTCMonth() === Number(m[2]) - 1 &&
    d.getUTCDate() === Number(m[3])
  );
}

/** 月份桶键：atLocal.slice(0,7)（契约要求按本地墙钟，不按 UTC） */
export const monthKeyOf = (atLocal: string): string => atLocal.slice(0, 7);
