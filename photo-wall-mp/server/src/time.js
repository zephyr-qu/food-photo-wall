/* ================================================================
   时间：本地墙钟串 `at` ↔ UTC instant（eatenAtUtc）

   契约（§2.4 ① / §3.4）：
   - `at` 必须是 `YYYY-MM-DDTHH:mm`，定宽、零填充、**无秒、无时区**。
     前端用它做 localeCompare 排序、slice(0,7) 分月、parseAt 解析；
     多一个 Z 或 +08:00 就会排序错/解析崩（iOS 上尤其）。
   - 排序与游标用 `eatenAtUtc`（RFC3339 UTC，形如 2026-10-09T04:30:00Z），
     跨时区也正确。
   - 两者互转只差一个 tzOffset（缺省 +08:00）。
   ================================================================ */

export const AT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
export const TZ_RE = /^([+-])(\d{2}):(\d{2})$/;

const pad2 = (n) => String(n).padStart(2, '0');

/** `+08:00` → 480 分钟；非法 → null */
export function parseTzOffset(tz) {
  const m = TZ_RE.exec(String(tz ?? ''));
  if (!m) return null;
  const sign = m[1] === '-' ? -1 : 1;
  const hh = Number(m[2]);
  const mm = Number(m[3]);
  if (hh > 14 || mm > 59) return null;
  return sign * (hh * 60 + mm);
}

export const DEFAULT_TZ = '+08:00';

/** `2026-10-09T12:30` + `+08:00` → 2026-10-09T04:30:00Z 的毫秒数；非法 → null */
export function atToUtcMs(at, tzOffset = DEFAULT_TZ) {
  const m = AT_RE.exec(String(at ?? ''));
  if (!m) return null;
  const off = parseTzOffset(tzOffset);
  if (off === null) return null;
  const [, y, mo, d, h, mi] = m.map((x, i) => (i === 0 ? x : Number(x)));
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  const local = Date.UTC(y, mo - 1, d, h, mi, 0, 0);
  const ms = local - off * 60000;
  // 回写校验：抓掉 2026-02-30 这类被 Date.UTC 悄悄进位的日期
  return utcMsToAt(ms, tzOffset) === at ? ms : null;
}

/** 毫秒 → `YYYY-MM-DDTHH:mm`（该时区的墙钟时间） */
export function utcMsToAt(ms, tzOffset = DEFAULT_TZ) {
  const off = parseTzOffset(tzOffset);
  const shift = (off === null ? 480 : off) * 60000;
  const d = new Date(ms + shift);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}T${pad2(
    d.getUTCHours(),
  )}:${pad2(d.getUTCMinutes())}`;
}

/** 毫秒 → RFC3339 UTC，固定秒精度（去掉毫秒，对齐文档示例 2026-10-09T04:30:00Z） */
export function toUtcIso(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** RFC3339（可带偏移/毫秒）→ 毫秒；非法 → null */
export function fromRfc3339(s) {
  if (typeof s !== 'string' || !s) return null;
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * 单调的 updatedAt：同一秒内连续写两次时，`toUtcIso` 会给出相同字符串，
 * 客户端据此判断「有没有变」就会失灵（AC-17 明确要求 updatedAt 变化）。
 * 这里保证返回值严格大于 prevIso。
 */
export function toUtcIsoAfter(ms, prevIso) {
  const iso = toUtcIso(ms);
  if (!prevIso) return iso;
  if (iso > prevIso) return iso;
  const bumped = fromRfc3339(prevIso);
  return toUtcIso(bumped === null ? ms : bumped + 1000);
}

export const nowMs = () => Date.now();

/** 未来时间容忍 5 分钟（§3.4） */
export const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

/** 当前时刻的 `at`（按给定时区） */
export function nowAt(tzOffset = DEFAULT_TZ) {
  return utcMsToAt(Date.now(), tzOffset);
}

/** `at` 的月份键，用于 /records/months（必须按 at_local 归桶，见 AC-34） */
export function monthOf(at) {
  return String(at).slice(0, 7);
}
