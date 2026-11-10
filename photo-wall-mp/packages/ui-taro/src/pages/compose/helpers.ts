/* ================================================================
   贴一张页的**纯逻辑**：长度校验、日期文案、日期加减、时间比较、照片回填。

   这些函数以前和 900 行的组件混在同一个文件里，只能用模拟器点一遍才敢说
   没坏。它们恰好都是"错了不会报错"的那类：
     · `shiftDate` 用本地时间算，某些时区减一天会跨月；
     · `isFutureMinute` 若用本地时区解析，跨时区会放过未来时间（服务端 422）；
     · `collectTooLong` 的文案字段名对不上，红字指着错误的位置；
     · `pickedFromRecord` 取错 id，编辑老记录一保存就把原照片清空。
   抽出来之后 `test/compose-helpers.test.ts` 钉住这些。

   约束：本文件**不 import React、不 import Taro**，只吃参数。
   ================================================================ */
import {
  FIELD_LABELS,
  FIELD_LIMITS,
  composeAt,
  datePart,
  overLength,
  stampNow,
  timePart,
  todayDate,
} from '@photo-wall/core';
import type { FieldName, FoodRecord } from '@photo-wall/core';

/** 一张照片的状态
 *
 *  · path —— 给 `<Image src>` 用的地址（本机路径 or 服务端 URL）
 *  · id   —— 服务端 photoId；没上传过（还没提交）是 null
 *  · key  —— React 的 key。用 path 当 key 不安全（同一张图可能被选两次），
 *            所以用「路径 + 序号」凑一个稳定且唯一的串。
 */
export interface PickedPhoto {
  key: string;
  path: string;
  id: string | null;
}

/** 每次进页从 1 开始的新鲜序号：只是 React key 的一部分，不进任何持久化 */
let photoSeq = 0;

/** 造一个稳定且唯一的 React key（同一路径选两次也不会撞） */
export function nextKey(path: string): string {
  photoSeq += 1;
  return `${path}#${photoSeq}`;
}

/**
 * 把刚选中的本机路径追加成照片槽位（按上限截断）。
 *
 *  ⚠ 必须按 `max - prev.length` 截断，而不是「全部追加」：
 *  `pickPhotos` 已经按剩余槽位限制了 chooseMedia 的 count，但用户可以在
 *  第一次选图还没回填时再点一次「贴上照片」，两个请求之间的槽位差会对不上。
 *  多出来的路径不追进来就没人回收，所以页面那边只在截断后的范围内登记
 *  ownedPhotos（否则会留下没人引用的临时文件）。
 *
 *  @returns 新的槽位数组；没有可加的位置时**原样返回 prev**（避免无谓重渲染）
 */
export function appendPicked(prev: PickedPhoto[], paths: string[], max: number): PickedPhoto[] {
  const room = max - prev.length;
  if (room <= 0 || paths.length === 0) return prev;
  return [...prev, ...paths.slice(0, room).map((path) => ({ key: nextKey(path), path, id: null }))];
}

/** 按 key 删一张；不存在时原样返回 prev（同理，别制造重渲染） */
export function removeByKey(prev: PickedPhoto[], key: string): PickedPhoto[] {
  const next = prev.filter((p) => p.key !== key);
  return next.length === prev.length ? prev : next;
}

/** 收集超长的字段 → 每个字段一句给用户看的话。
 *
 *  为什么单独抽出来：提交前的校验（一次性给出全部问题）和输入时的
 *  即时提示（只管当前这个字段）要用同一套判定，写两遍就会漂移。
 *
 *  参数是 Partial：`FIELD_LIMITS` 里有 district（契约支持区/县），但本页没有
 *  区县输入框（选城市时一起带），所以传进来的对象里没有它 —— 用 Partial
 *  而不是把类型写成"恰好这四个字段"，否则一旦哪天补上区县输入就得改两处。
 *
 *  @returns 字段名 → 提示文案；没有超长字段时返回空对象
 */
export function collectTooLong(
  values: Partial<Record<FieldName, string>>,
): Partial<Record<FieldName, string>> {
  const out: Partial<Record<FieldName, string>> = {};
  (Object.keys(FIELD_LIMITS) as FieldName[]).forEach((field) => {
    const over = overLength(field, values[field]);
    if (over > 0) {
      out[field] = `${FIELD_LABELS[field]}最多 ${FIELD_LIMITS[field]} 个字（超了 ${over} 个）`;
    }
  });
  return out;
}

/** 一句能放进 toast 的短提示：只报第一个出问题的字段。
 *
 *  为什么只报一个：toast 放不下多行，报「吃了什么和店名都超长了」反而
 *  更难懂。行内提示（每个字段下方那行红字）会把全部问题都列出来，
 *  toast 只是把用户引到第一个问题上。
 */
export function firstTooLongText(bad: Partial<Record<FieldName, string>>): string {
  const keys = Object.keys(bad) as FieldName[];
  return keys.length > 0 ? bad[keys[0]] || '内容太长了' : '内容太长了';
}

/** 'YYYY-MM-DD' 前移/后移若干天。
 *
 *  ⚠ 用 UTC 算（`Date.UTC`），不用本地时间：本地时区下
 *  `new Date('2026-03-01')` 会按本地零点解析，UTC 时区则是 UTC 零点，
 *  减一天在某些时区会跨月。UTC 算完只取日期部分，跨月跨年都稳。
 */
export function shiftDate(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d) + days * 86_400_000;
  const dt = new Date(t);
  const pad2 = (n: number): string => String(n).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

/** 'YYYY-MM-DD' → 给用户看的日期文案。
 *
 *  今天 / 昨天 用中文（更省脑），其余用 'M 月 D 日'。
 *  跨年时补上年份 —— 「12 月 28 日」放在 1 月的墙上会指代不明。
 *
 *  @param today 测试注入用（默认取本机今天）
 */
export function formatDateForDisplay(date: string, today: string = todayDate()): string {
  if (date === today) return '今天';
  if (date === shiftDate(today, -1)) return '昨天';
  const parts = date.split('-');
  const year = parts[0];
  const month = Number(parts[1]);
  const day = Number(parts[2]);
  const thisYear = today.slice(0, 4);
  return year === thisYear
    ? `${month} 月 ${day} 日`
    : `${year} 年 ${month} 月 ${day} 日`;
}

/** 这一刻是不是「就是现在」（同一分钟）。
 *
 *  用来在表单上标一句「现在」—— 让用户知道不改就是此刻，
 *  不用对着控件犹豫要不要点开。
 *
 *  @param now 测试注入用（默认取此刻，形如 'YYYY-MM-DDTHH:mm'）
 */
export function isNowMinute(at: { date: string; time: string }, now: string = stampNow()): boolean {
  return at.date === datePart(now) && at.time === timePart(now);
}

/** 这一刻是不是在未来（严格大于当前这一分钟）。
 *
 *  服务端会拒（`422 fields.at`「不能是未来时间」），所以在表单上
 *  先拦一道并给出提示，省得用户提交后才看到错误。
 *
 *  @param now 测试注入用
 */
export function isFutureMinute(
  at: { date: string; time: string },
  now: string = stampNow(),
): boolean {
  /* 定宽格式（'YYYY-MM-DDTHH:mm'）的字典序 = 时间序，直接比字符串 */
  return composeAt(at.date, at.time) > composeAt(datePart(now), timePart(now));
}

/** 记录 → 照片状态列表（编辑态初始化）。
 *
 *  为什么要兼容老服务端：它没有 `photos` 字段，只有单张 `photo`/`photoId`。
 *  这时用 [rec.photo] 造一条，id 取 rec.photoId —— 没换图时原样带回去，
 *  PATCH 就不会把老照片清掉。
 */
export function pickedFromRecord(rec: FoodRecord): PickedPhoto[] {
  const list = (rec.photos || []).filter(Boolean);
  const ids = rec.photoIds || [];
  if (list.length) {
    return list.map((path, i) => ({
      key: nextKey(path),
      path,
      id: ids[i] ?? null,
    }));
  }
  /* 老服务端：单张 photo（id 走 photoIds[0]）。
     ⚠ 不是 rec.photoId —— FoodRecord 上没有单数字段，适配层已把它
     折进 photoIds[0]。读 rec.photoId 永远是 undefined，那样编辑老记录
     保存时会丢原照片 id，PATCH 整体替换 = 老照片被清空。 */
  if (rec.photo) {
    return [{ key: nextKey(rec.photo), path: rec.photo, id: ids[0] ?? null }];
  }
  return [];
}

/** 表单快照（判断"有没有改过"用） */
export interface ComposeForm {
  eat: string;
  shop: string;
  city: string;
  note: string;
  rating: number;
  at: { date: string; time: string };
  paths: string[];
}

/** 当前表单相对初始快照是否被改过。
 *
 *  两条容易写错的规则，都钉在测试里：
 *   · **编辑态还没回填（init=null）不算改过** —— 否则一进页就弹"还没保存"，
 *     用户什么都没做就被拦；
 *   · **新建态按"有没有填过"判** —— 空表单不算改过，选了一张图才算。
 */
export function isFormDirty(editing: boolean, form: ComposeForm, init: ComposeForm | null): boolean {
  if (editing) {
    if (!init) return false;
    return (
      form.eat !== init.eat ||
      form.shop !== init.shop ||
      form.city !== init.city ||
      form.note !== init.note ||
      form.rating !== init.rating ||
      form.at.date !== init.at.date ||
      form.at.time !== init.at.time ||
      form.paths.join('|') !== init.paths.join('|')
    );
  }
  return Boolean(
    form.eat.trim() ||
      form.shop.trim() ||
      form.city.trim() ||
      form.note.trim() ||
      form.rating ||
      form.paths.length,
  );
}
