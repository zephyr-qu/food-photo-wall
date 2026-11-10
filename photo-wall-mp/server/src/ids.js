/* ================================================================
   ID 生成：ULID（Crockford Base32，26 字符，按时间单调）

   契约要求 id 形如 `rec_01J9Z8ZK3M4N5P6Q7R8S9T0V`，
   并且**禁止** `g<数字>_<数字>` 形态 —— 前端会把那种 id 当本地伪造数据、
   不落盘（packages/ui-taro/src/data/store.ts:57-62）。

   ULID 自带时间前缀，字符串序 ≈ 时间序，正好用来做
   `(eatenAtUtc DESC, id DESC)` 的二级排序兜底。
   ================================================================ */
import { randomBytes } from 'node:crypto';

const ENC = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford Base32
const TIME_LEN = 10;
const RAND_LEN = 16;

function encodeTime(ms) {
  let n = Math.floor(ms);
  let out = '';
  for (let i = 0; i < TIME_LEN; i++) {
    out = ENC[n % 32] + out;
    n = Math.floor(n / 32);
  }
  return out;
}

function encodeBytes(bytes) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ENC[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ENC[(value << (5 - bits)) & 31];
  return out.slice(0, RAND_LEN);
}

/** 同毫秒内单调递增：把随机段当大整数 +1，保证后生成的 id 更大 */
let lastMs = -1;
let lastBytes = null;

function monotonicBytes(ms) {
  if (ms > lastMs || !lastBytes) {
    lastMs = ms;
    lastBytes = randomBytes(10);
    return lastBytes;
  }
  // 同毫秒：从低位进位
  const next = Uint8Array.from(lastBytes);
  for (let i = next.length - 1; i >= 0; i--) {
    if (next[i] === 0xff) {
      next[i] = 0;
    } else {
      next[i] += 1;
      break;
    }
  }
  lastBytes = next;
  return next;
}

/** 运行时生成：`rec_01J...` */
export function ulid(ms = Date.now()) {
  return encodeTime(ms) + encodeBytes(monotonicBytes(ms));
}

/** 确定性生成：同样的 (ms, seed) 永远得到同一个 id。
 *  种子数据用它，保证重启/重置后 id 稳定（前端缓存、测试断言都能对上）。 */
export function ulidFrom(ms, seed) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  const bytes = new Uint8Array(10);
  for (let i = 0; i < 10; i++) {
    h = Math.imul(h ^ (h >>> 13), 2654435761) >>> 0;
    bytes[i] = h & 0xff;
  }
  return encodeTime(ms) + encodeBytes(bytes);
}

/** 资源前缀：rec_ / pho_ / shp_ / usr_ / req_ */
export function newId(prefix, ms = Date.now()) {
  return `${prefix}_${ulid(ms)}`;
}

export function deterministicId(prefix, ms, seed) {
  return `${prefix}_${ulidFrom(ms, seed)}`;
}
