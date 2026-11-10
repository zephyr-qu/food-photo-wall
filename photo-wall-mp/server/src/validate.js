/* ================================================================
   归一化与字段校验（契约 §3.7 / AC-12~AC-15）

   三条容易踩的坑：
   1. 空串 `""` 必须归一成 `null` —— 前端把空串当"有值"，
      店铺去重、统计都会被脏数据带偏（§2.4 ③）。
   2. `rating = 0` 是"未评"，不是零分；不能当成缺省值丢掉。
   3. `eat` 是唯一必填项，trim 后 1–60；纯空白/换行都不算。
   ================================================================ */
import { validationFailed } from './errors.js';
import { AT_RE, DEFAULT_TZ, FUTURE_TOLERANCE_MS, atToUtcMs, fromRfc3339 } from './time.js';

export const LIMITS = {
  eat: 60,
  shop: 80,
  city: 40,
  district: 40,
  note: 200,
};

/** 空串 / 纯空白 → null；其余 trim 后返回 */
export function emptyToNull(v) {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string') return v;
  const t = v.trim();
  return t === '' ? null : t;
}

/**
 * 可选字符串字段：null/缺失 → null；空串 → null；超长 → fields[key]
 *
 * `preserveWhitespace` 用于 `note`：契约要求「保留换行」（§3.7 / N-05），
 * 所以只把「整体空白」归一为 null，不 trim 正文。
 * @returns {string|null}
 */
export function optionalText(value, key, max, fields, { preserveWhitespace = false } = {}) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    fields[key] = '必须是字符串';
    return null;
  }
  if (value.trim() === '') return null;
  const v = preserveWhitespace ? value : value.trim();
  if (v.length > max) {
    fields[key] = `最多 ${max} 个字符`;
    return null;
  }
  return v;
}

/** `eat` 必填：trim 后 1–60 */
export function requiredEat(value, fields) {
  const v = emptyToNull(value);
  if (v === null) {
    fields.eat = '不能为空';
    return null;
  }
  if (typeof v !== 'string') {
    fields.eat = '必须是字符串';
    return null;
  }
  if (v.length > LIMITS.eat) {
    fields.eat = `最多 ${LIMITS.eat} 个字符`;
    return null;
  }
  return v;
}

/** `rating` 整数 0–5；缺省 0。字符串数字、小数、越界都算错（AC-14 定死 422） */
export function parseRating(value, fields, { optional = false } = {}) {
  if (value === undefined) return optional ? undefined : 0;
  if (value === null) {
    if (optional) return undefined;
    fields.rating = '必须是 0-5 的整数';
    return 0;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 5) {
    fields.rating = '必须是 0-5 的整数';
    return 0;
  }
  return value;
}

/**
 * 解析 `at` + `tzOffset` / `eatenAt` 三者，返回 { at, tzOffset, eatenAtMs }。
 *
 * 优先级（§3.4）：`eatenAt`（RFC3339）> `at`（本地墙钟串）。
 * `at` 晚于服务器时间 5 分钟以上 → 422；早于 1970 → 422。
 */
export function parseWhen(input, fields, { optional = false } = {}) {
  const hasAt = input.at !== undefined && input.at !== null;
  const hasEatenAt = input.eatenAt !== undefined && input.eatenAt !== null;
  const tzRaw = input.tzOffset;
  let tzOffset = DEFAULT_TZ;
  if (tzRaw !== undefined && tzRaw !== null) {
    if (typeof tzRaw !== 'string' || !/^[+-]\d{2}:\d{2}$/.test(tzRaw)) {
      fields.tzOffset = '格式应为 ±HH:mm';
    } else {
      tzOffset = tzRaw;
    }
  }

  if (!hasAt && !hasEatenAt) {
    if (optional) return undefined;
    // 不传 = 服务端当前时间（对齐前端 stampNow()）
    const ms = Date.now();
    return { at: null, tzOffset, eatenAtMs: ms, useNow: true };
  }

  let eatenAtMs;
  let at;

  if (hasEatenAt) {
    eatenAtMs = fromRfc3339(input.eatenAt);
    if (eatenAtMs === null) {
      fields.at = 'eatenAt 不是合法的 RFC3339 时间';
      return null;
    }
    // 有 eatenAt 时 at 由服务端按 tzOffset 换算，保证两者自洽
    at = null;
  } else {
    if (typeof input.at !== 'string' || !AT_RE.test(input.at)) {
      fields.at = '格式应为 YYYY-MM-DDTHH:mm';
      return null;
    }
    eatenAtMs = atToUtcMs(input.at, tzOffset);
    if (eatenAtMs === null) {
      fields.at = '不是合法的日期时间';
      return null;
    }
    at = input.at;
  }

  if (eatenAtMs < 0) {
    fields.at = '时间不能早于 1970 年';
    return null;
  }
  if (eatenAtMs > Date.now() + FUTURE_TOLERANCE_MS) {
    fields.at = '时间不能晚于当前时间';
    return null;
  }

  return { at, tzOffset, eatenAtMs, useNow: false };
}

/** 统一的校验收口：有任何 fields 就抛 422 */
export function assertValid(fields, message = '字段校验失败') {
  if (Object.keys(fields).length) throw validationFailed(fields, message);
}
