/**
 * ULID 风格 id：48bit 时间 + 80bit 随机，Crockford Base32，26 字符。
 * 契约要求：不透明、≤64、**禁止** `^g.*_` 形态（前端把它当本地伪造数据）。
 * 前缀按资源区分：rec_ / usr_ / shp_ / pho_ / rt_ / req_
 */
import { randomBytes } from 'node:crypto';

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32
const TIME_LEN = 10;
const RANDOM_LEN = 16;

function encodeTime(now: number, len: number): string {
  let out = '';
  let t = now;
  for (let i = len - 1; i >= 0; i--) {
    out = ENCODING[t % 32] + out;
    t = Math.floor(t / 32);
  }
  return out;
}

function encodeRandom(len: number): string {
  const bytes = randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += ENCODING[bytes[i] % 32];
  return out;
}

export function ulid(): string {
  return encodeTime(Date.now(), TIME_LEN) + encodeRandom(RANDOM_LEN);
}

export type IdPrefix = 'rec' | 'usr' | 'shp' | 'pho' | 'rt' | 'req' | 'idm';

export function newId(prefix: IdPrefix): string {
  return `${prefix}_${ulid()}`;
}

/** 令牌用高熵随机串（非 ULID，避免被猜时间） */
export function newOpaqueToken(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString('hex')}`;
}
