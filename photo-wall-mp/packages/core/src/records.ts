/* ================================================================
   数据层：照片映射 + 纯函数工具
    真实示例记录与拟真生成已挪到 demo.ts（core 顶层仍导出，见 index.ts）。
   与原型保持逐字一致（BRIEF.md §1）

   TypeScript 版：所有对外函数的入参/出参都有类型，
   数据形状定义在 src/types/domain.ts。
   ================================================================ */
import type { FoodRecord, CityCount } from './types/domain';
import { provinceOf } from './geo.ts';

/** 菜名 → 照片文件。
 *
 *  ⚠ 必须是**以 / 开头的绝对路径**。
 *  小程序里 <Image src> 的相对路径是相对于**当前页面**解析的：
 *  在 pages/wall/ 下写 "static/img/x.jpg" 会去找
 *  pages/wall/static/img/x.jpg —— 那个文件不存在，图片全空。
 *  加前导斜杠后从包根解析：/static/img/x.jpg → dist/static/img/x.jpg。
 *
 *  H5 侧同样适用（publicPath 是 '/'，绝对路径正好指向站点根）。
 *  文件本身由 config/index.js 的 copy 配置拷进产物。 */
export const PHOTO_MAP: Record<string, string> = {
  '甜水面': '/static/img/tiantianmian.jpg',
  '冰粉': '/static/img/bingfen.jpg',
  '跷脚牛肉': '/static/img/qiaojiaoniurou.jpg',
  '钵钵鸡': '/static/img/boboboji.jpg',
  '北京烤鸭': '/static/img/kaoya.jpg',
  '番茄牛腩': '/static/img/fanqieniunan.jpg',
  '蛋烘糕': '/static/img/danhonggao.jpg',
  '生煎包': '/static/img/shengjianbao.jpg',
  '豆汁儿': '/static/img/douzhier.jpg',
  '热干面': '/static/img/reganmian.jpg',
  '糖油粑粑': '/static/img/tangyoubaba.jpg',
  '沙茶面': '/static/img/shachamian.jpg',
};

const PHOTO_KEYS: string[] = Object.keys(PHOTO_MAP);

/* ---------------- 纯函数工具 ---------------- */

export const pad = (n: number): string => String(n).padStart(2, '0');

/** 2026-10-09T12:30 → 10.09（随机一道浮窗的日期戳用） */
export const mmdd = (at: string): string => `${at.slice(5, 7)}.${at.slice(8, 10)}`;

/* 多段信息并排时不再插「·」这类分隔符：符号本身会和多段文字抢注意力。
   统一用两个不间断空格留出呼吸感（nbsp 不会被排版折叠），
   层次交给字号、字重和间距去表达。 */
export const SEP: string = '\u00a0\u00a0';

/** 若干非空片段拼成一句，没有片段时给 fallback */
export function joinBits(bits: Array<string | number | null | undefined>, fallback = ''): string {
  const list = bits.filter((b) => b !== null && b !== undefined && b !== '');
  return list.length ? list.map(String).join(SEP) : fallback;
}

export function dateOf(at: string): string {
  return at.slice(0, 10).replace(/-/g, '.');
}

/**
 * 地点副行：省 · 市 · 区/县（三级城市，区/县可空）。
 *
 * 直辖市（北京/上海/…）省==市，去重成「北京」而不是「北京·北京」；
 * 表外城市（香港/台北/曼谷…）provinceOf 返回 null，则退化为只显示城市。
 * 区/县为空（用户没选或该城市没有更细粒度）时退化为「省 · 市」或「市」。
 * 例如：成都·锦江区、北京·朝阳区、曼谷（无省无区）、自贡（无区）。
 * 既没省也没城时回退文案，避免墙上出现空段。
 *
 * 为什么要有区/县：同一座城里同名店很多（"四季民福"北京就有好几家），
 * 落到区/县才能把同城同名店区分开，所以表单允许用户进一步选「区/县」。
 */
export function placeOf(r: Pick<FoodRecord, 'city' | 'district'>): string {
  const city = r.city || '';
  const district = r.district || '';
  const province = provinceOf(city);
  const head = province && province !== city ? `${province} · ${city}` : city;
  if (head && district) return `${head} · ${district}`;
  if (head) return head;
  return '没有城市';
}

export function timeOf(at: string): string {
  return (at.split('T')[1] || '').slice(0, 5);
}

/** FNV-1a 哈希：稳定的字符串 → 数字，用于照片轮换和伪随机种子 */
export function hashOf(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32：可复现的伪随机 */
export function rngOf(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 菜名 → 照片路径；没有精确匹配就按哈希轮换，保证每块都有图
 *
 *  优先级：用户自己选的照片（绝对路径，如 wxfile:// 或 http）> 预置图。
 *  预置图是包内相对路径（static/img/xxx.jpg），用户图是绝对路径，
 *  两者都能直接给 <Image src>，不需要区分处理。
 */
export function photoOf(r: Pick<FoodRecord, 'eat' | 'photo'>): string {
  if (r.photo) return r.photo;
  if (PHOTO_MAP[r.eat]) return PHOTO_MAP[r.eat];
  return PHOTO_MAP[PHOTO_KEYS[hashOf(r.eat) % PHOTO_KEYS.length]];
}

/* ---------------- 字段长度上限 ---------------- */

/**
 * 一条记录各字段的**长度上限**（字符数）。
 *
 *  ⚠ 为什么必须有这份常量：
 *  前端要拿它设 `<Input maxlength>`，服务端要拿它做 zod 校验 —— 两边
 *  各写一份数字，迟早会漂移。漂移的表现是「用户能输入、能提交，
 *  然后被服务端 422 拒掉，但前端只显示一句『字段校验失败』」：
 *  用户白填一遍，还不知道自己错在哪（审计 R6 记的就是这个坑）。
 *
 *  与服务端 server/src/schemas.ts 的 nullableText(80/40/40/200) 与
 *  eat.max(60) 逐条对应，契约见 docs/api/photo-wall-api.md §3.7。
 *
 *  口径说明：**长度按 trim 后的字符数算**（与服务端 POST 一致），
 *  所以纯空白不算「占额度」。
 */
export const FIELD_LIMITS = {
  /** 菜名：必填，trim 后 1–60 */
  eat: 60,
  /** 店名：可空，trim 后 ≤80 */
  shop: 80,
  /** 城市：可空，trim 后 ≤40（后端不校验是否在字典内） */
  city: 40,
  /** 区/县：可空，trim 后 ≤40 */
  district: 40,
  /** 备注：可空，trim 后 ≤200（保留换行） */
  note: 200,
} as const;

export type FieldName = keyof typeof FIELD_LIMITS;

/** 字段的中文名（错误提示用，与服务端文案口径一致） */
export const FIELD_LABELS: Record<FieldName, string> = {
  eat: '这一口',
  shop: '哪一家',
  city: '在哪座城',
  district: '区/县',
  note: '想记两句',
};

/**
 * 某个字段是否超长。
 *
 *  ⚠ 为什么要单独抽一个纯函数：空串归一、trim 时机这些规则很容易在
 *  「前端判一次、后端判一次」时不一致。放在 core 里，前后端引用同一份，
 *  规则只写一遍。
 *
 * @param value 字段原始值（可能带首尾空白）
 * @returns 超长时返回超出的字符数，没超长返回 0
 */
export function overLength(field: FieldName, value: string | null | undefined): number {
  const max = FIELD_LIMITS[field];
  const len = (value ?? '').trim().length;
  return len > max ? len - max : 0;
}

/* ---------------- 多图（至多 5 张） ---------------- */

/**
 * 一条记录最多能带几张自定义照片。
 *
 *  与服务端 server/src/lib/constants.ts 的 MAX_PHOTOS 各定义一份（不跨包依赖），
 *  两边必须一致 —— 契约里写死了 5。 */
export const MAX_PHOTOS = 5;

/**
 * 一条记录的**全部**照片 URL（有序）。
 *
 *  为什么不让 photoOf 承担这件事：photoOf 是**封面**语义（单张），
 *  到处都在用它（分享卡片、列表缩略图），不能改。详情页要切图、
 *  编辑页要列出全部，才需要这个"多图"版本。
 *
 *  没有自定义照片时回落成 1 张预置图 —— 和今天 photoOf 的结果完全一致，
 *  这样调用方不用分支处理"零张"的情况。
 */
export function photosOf(r: Pick<FoodRecord, 'eat' | 'photo' | 'photos'>): string[] {
  const custom = (r.photos || []).filter(Boolean);
  if (custom.length) return custom.slice();
  return [photoOf(r)];
}

/**
 * 从多张照片里按种子**稳定**地挑一张作封面。
 *
 *  为什么要"稳定"而不是 Math.random()：墙上每一格要在整个会话里保持同一张，
 *  否则用户滑动时图片在变（看着像加载错乱）。用 hashOf(seed) 取模决定，
 *  同一个 seed + 同一组照片永远得到同一张 —— 换句话说它是"随机但可复现"。
 *
 *  @param seed 通常是「会话种子 + 记录 id」：不同记录各自稳定，同会话内不跳变。
 */
export function pickCover(photos: string[], seed: string): string | null {
  const list = photos.filter(Boolean);
  if (!list.length) return null;
  return list[hashOf(seed) % list.length];
}

/** 当前时间戳（贴一张的默认时间） */
export function stampNow(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/* ---------------- 补记：日期 / 时刻 ---------------- */

/**
 * `2026-10-09T12:30` → `'2026-10-09'`（给 `<Picker mode="date">` 用）。
 *
 * 为什么单独抽：Picker 的 value 格式是 'YYYY-MM-DD'，而记录的时间是
 * 'YYYY-MM-DDTHH:mm'。两处各写一次 slice，改格式时就会漏改一处。
 */
export function datePart(at: string): string {
  return at.slice(0, 10);
}

/**
 * `2026-10-09T12:30` → `'12:30'`（给 `<Picker mode="time">` 用）。
 */
export function timePart(at: string): string {
  return (at.split('T')[1] || '').slice(0, 5);
}

/**
 * 日期 + 时刻 → `2026-10-09T12:30`（契约要求的本地墙钟格式）。
 *
 * ⚠ **不做任何时区换算**：这里拼出来的是「用户在自己所在时区看到的
 * 那个时刻的墙上时间」，正是契约 §3.4 要的 `at`。
 * 服务端拿到它之后，会配合 `X-Timezone-Offset` 换算出 UTC instant
 * 用于排序 —— 换算是服务端的事，客户端不掺和。
 *
 * @param date 'YYYY-MM-DD'
 * @param time 'HH:mm'
 */
export function composeAt(date: string, time: string): string {
  return `${date}T${time}`;
}

/**
 * 设备当前时区偏移 → `'±HH:mm'`（契约 §3.4 的 `tzOffset`）。
 *
 * 为什么客户端要发它：服务端默认用 `+08:00`，但用户在纽约时
 * 「12:30 吃的」应该是 UTC-05:00 的墙钟。不发这个头，服务端就会
 * 把纽约的记录按东八区解释 —— 时间差 13 小时，排序全乱。
 *
 * `Date.getTimezoneOffset()` 返回的是「UTC 减本地」的分钟数（东八区
 * 是 -480），所以要取负号才是「本地相对 UTC」的偏移。
 */
export function tzOffsetNow(): string {
  const minutes = -new Date().getTimezoneOffset();
  const sign = minutes >= 0 ? '+' : '-';
  const abs = Math.abs(minutes);
  return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/**
 * 今天的日期（`'YYYY-MM-DD'`），设备本地。
 */
export function todayDate(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * 把 `2026-10-09T12:30` 解析成 Date。
 *
 * ⚠ 不能直接 `new Date(str)`：iOS（Safari / 微信 iOS 端）不认带连字符的
 * 日期字符串，会返回 Invalid Date，而 V8（开发者工具 / Android）能解析 ——
 * 典型的「模拟器好好的，iPhone 上炸」。统一先把 `-` 换成 `/`，
 * 并把 `T` 换成空格（iOS 对 `2026/10/09T12:30` 也不稳，空格两端都认）。
 */
export function parseAt(at: string): Date {
  const normalized = at.replace(/-/g, '/').replace('T', ' ');
  const d = new Date(normalized);
  /* 兜底：万一还是 Invalid Date，退回当前时间，别让墙直接崩 */
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

/** 城市 → 该城所有记录数（过滤条用） */
export function countByCity(records: FoodRecord[]): CityCount[] {
  const m = new Map<string, number>();
  records.forEach((r) => {
    const k = r.city || '';
    m.set(k, (m.get(k) || 0) + 1);
  });
  return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-Hans-CN'));
}

export function citiesInUse(records: FoodRecord[]): number {
  return new Set(records.map((r) => r.city).filter(Boolean)).size;
}
