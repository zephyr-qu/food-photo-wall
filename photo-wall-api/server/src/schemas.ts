/** 请求/响应 schema —— 与 docs/api/photo-wall-api.md §3.7 / §6 逐条对齐 */
import { z } from 'zod';
import { AT_LOCAL_RE, TZ_OFFSET_RE, nullableText, queryBool, queryInt, optionalQueryString } from './lib/validate.js';
import { isValidDateOnly, parseAtLocal, parseRfc3339, parseTzOffset } from './lib/time.js';
import { FIELD_LIMITS, FIELD_LABELS, MAX_PHOTOS } from './lib/constants.js';

// ---------------------------------------------------------------- 基础片段

const atLocal = z
  .string()
  .regex(AT_LOCAL_RE, '时间格式必须是 YYYY-MM-DDTHH:mm（无秒、无时区）')
  .refine((v) => parseAtLocal(v) !== null, '时间不是合法日期');

const tzOffset = z.string().regex(TZ_OFFSET_RE, '时区偏移格式必须是 ±HH:mm').refine(
  (v) => parseTzOffset(v) !== null,
  '时区偏移超出范围（±14:00 内）',
);

const rfc3339 = z.string().refine((v) => parseRfc3339(v) !== null, 'eatenAt 必须是 RFC3339 时间');

const rating = z
  .number({ invalid_type_error: '评分必须是数字（不要传字符串）' })
  .int('评分必须是整数')
  .min(0, '评分最小 0')
  .max(5, '评分最大 5');

const photoId = z.string().max(64, 'photoId 过长');
const shopId = z.string().max(64, 'shopId 过长');
const dateOnly = z.string().refine(isValidDateOnly, '日期格式必须是 YYYY-MM-DD');
const clientRequestId = z.string().max(64).optional();

/**
 * 照片 id 数组（至多 5 张，顺序即用户选择顺序）。
 *
 * 为什么在这里就卡住"数量"和"重复"：
 *   · 数量上限属于**契约**的一部分（422 + fields.photoIds），放服务层再判会漏掉
 *     PATCH 的等价路径；
 *   · 重复 id 必须拒绝而不是去重 —— 去重会让"用户以为选了 3 张、实际存了 2 张"
 *     变成静默的少图，而重复必然是客户端 bug，响亮地失败更好。
 *
 * 顺序**原样保留**：不去重、不排序（排序会打乱用户挑的封面顺序）。
 *
 * 为什么元素类型用 `z.unknown()` 再在 superRefine 里判，而不是 `z.array(z.string())`：
 *   元素级 zod 错误的 path 会带上**下标**（`photoIds.0`），前端拿到的
 *   `fields` 键就变成了 `photoIds.0` —— 契约要求键就是 `photoIds`。
 *   自己判类型才能把**所有** photoIds 的错误都收拢到同一个键上。
 *
 * `null` 也接受：前端 `ApiRecordInput.photoIds?: string[] | null`，
 * null 与 [] 同义（清空），别让客户端因为传了 null 就 422。
 */
const photoIdsField = z
  .array(z.unknown(), { invalid_type_error: 'photoIds 必须是字符串数组' })
  .nullable()
  .optional()
  .superRefine((v, ctx) => {
    if (!Array.isArray(v)) return;
    if (v.some((id) => typeof id !== 'string')) {
      ctx.addIssue({ code: 'custom', message: 'photoIds 必须是字符串数组' });
      return;
    }
    const ids = v as string[];
    if (ids.some((id) => id.length > 64)) {
      ctx.addIssue({ code: 'custom', message: 'photoId 过长' });
      return;
    }
    if (ids.length > MAX_PHOTOS) {
      ctx.addIssue({ code: 'custom', message: `最多 ${MAX_PHOTOS} 张照片` });
      return;
    }
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: 'custom', message: '照片不能重复' });
    }
  })
  /* superRefine 已经保证元素全是 string，这里把类型收窄回来。
     transform 只在校验通过后执行，所以这个断言是安全的。 */
  .transform((v): string[] | null | undefined => v as string[] | null | undefined);

// ---------------------------------------------------------------- 写记录

/** POST /records（§6.2.3）。未出现 = 用默认值；空串 → null */
export const createRecordSchema = z.object({
  eat: z
    .string({ required_error: '这一口不能空着' })
    .trim()
    .min(1, '这一口不能空着')
    .max(FIELD_LIMITS.eat, `${FIELD_LABELS.eat}最多 ${FIELD_LIMITS.eat} 个字`),
  shop: nullableText(FIELD_LIMITS.shop, FIELD_LABELS.shop),
  shopId: z.union([shopId, z.null()]).optional().transform((v) => (v === undefined ? null : v)),
  city: nullableText(FIELD_LIMITS.city, FIELD_LABELS.city),
  district: nullableText(FIELD_LIMITS.district, FIELD_LABELS.district),
  rating: rating.optional(),
  note: nullableText(FIELD_LIMITS.note, FIELD_LABELS.note),
  photoId: z.union([photoId, z.null()]).optional().transform((v) => (v === undefined ? null : v)),
  photoIds: photoIdsField,
  at: atLocal.optional(),
  tzOffset: tzOffset.optional(),
  eatenAt: rfc3339.optional(),
  clientRequestId,
});

export type CreateRecordInput = z.infer<typeof createRecordSchema>;

/**
 * PATCH 的可空文本字段。
 *
 * ⚠ 为什么不用 POST 那套 `nullableText`：
 * PATCH 必须区分「没传这个字段」（= 不改）和「显式传 null」（= 清空），
 * 所以这里不能用会吞掉 null 的 union。
 *
 * ⚠ 但**长度口径必须与 POST 一致**（都按 trim 后的字符数算）：
 * 以前 PATCH 用 `z.string().max(80)`，是在 trim **前**判的 ——
 * 于是「80 个字 + 两个尾随空格」在 POST 能过、在 PATCH 却 422，
 * 而服务端存进去的其实是 trim 后的 80 个字。同一份内容，改一次就报错。
 * 前端的 `overLength` 也是按 trim 后判的，两边必须对得上。
 *
 * @param max 上限字符数
 * @param label 字段中文名（错误文案用）
 */
const patchText = (max: number, label: string) =>
  z
    .string()
    .trim()
    .max(max, `${label}最多 ${max} 个字符`)
    .nullable();

/**
 * PATCH /records/{id}（§6.2.4）：仅更新出现的字段。
 * 注意这里**不做** undefined→null 的转换：要区分"没传"和"显式传 null"。
 */
export const patchRecordSchema = z.object({
  eat: z
    .string()
    .trim()
    .min(1, '这一口不能空着')
    .max(FIELD_LIMITS.eat, `${FIELD_LABELS.eat}最多 ${FIELD_LIMITS.eat} 个字`)
    .optional(),
  shop: patchText(FIELD_LIMITS.shop, FIELD_LABELS.shop).optional(),
  shopId: z.union([shopId, z.null()]).optional(),
  city: patchText(FIELD_LIMITS.city, FIELD_LABELS.city).optional(),
  district: patchText(FIELD_LIMITS.district, FIELD_LABELS.district).optional(),
  rating: rating.optional(),
  note: patchText(FIELD_LIMITS.note, FIELD_LABELS.note).optional(),
  photoId: z.union([photoId, z.null()]).optional(),
  photoIds: photoIdsField,
  at: atLocal.optional(),
  tzOffset: tzOffset.optional(),
  eatenAt: rfc3339.optional(),
});

export type PatchRecordInput = z.infer<typeof patchRecordSchema>;

// ---------------------------------------------------------------- 查询

/** 列表/统计共用筛选；city 与 cityMissing 互斥（→ 400） */
const filterShape = {
  city: optionalQueryString,
  cityMissing: queryBool,
  province: optionalQueryString,
  from: dateOnly.optional(),
  to: dateOnly.optional(),
};

const withFilterRules = <T extends z.ZodRawShape>(shape: T) =>
  z
    .object(shape)
    .superRefine((v: Record<string, unknown>, ctx) => {
      if (v.city && v.cityMissing) {
        ctx.addIssue({ code: 'custom', path: ['city'], message: 'city 与 cityMissing 不能同时传' });
      }
      const from = v.from as string | undefined;
      const to = v.to as string | undefined;
      if (from && to && from > to) {
        ctx.addIssue({ code: 'custom', path: ['from'], message: 'from 不能晚于 to' });
      }
    });

/** GET /records（§6.2.1）：limit 越界 → 400（无 fields） */
export const listQuerySchema = withFilterRules({
  ...filterShape,
  limit: queryInt(1, 50, 10),
  cursor: optionalQueryString,
  /**
   * cursor 的包含语义。默认 false = 严格 `< cursor`（keyset 翻页，不重不漏）。
   *
   * `true` 时用 `<=`，让「从某条开始」的跳转成为可能 —— 月轴跳月就是这种：
   * `/records/months` 给的 `firstCursorInclusive` 本身就是"该月第一条"，
   * 要把它**包含**进结果，否则每次跳月都会漏掉当月最新一张。
   *
   * 为什么不用新游标格式解决：游标是不透明字符串，改语义会让已发出的
   * 游标（客户端缓存、分享链接）行为漂移。加一个显式参数更可控，
   * 且默认值保持旧行为，不破坏既有调用方。
   */
  cursorInclusive: queryBool,
  shopId: optionalQueryString,
  q: optionalQueryString,
});

export type ListQuery = z.infer<typeof listQuerySchema>;

export const statsQuerySchema = withFilterRules({ ...filterShape });
export type StatsQuery = z.infer<typeof statsQuerySchema>;

export const monthsQuerySchema = withFilterRules({ ...filterShape });
export type MonthsQuery = z.infer<typeof monthsQuerySchema>;

export const randomQuerySchema = withFilterRules({
  city: optionalQueryString,
  cityMissing: queryBool,
  province: optionalQueryString,
  excludeId: optionalQueryString,
});
export type RandomQuery = z.infer<typeof randomQuerySchema>;

export const shopDetailQuerySchema = z.object({
  limit: queryInt(1, 200, 100),
  cursor: optionalQueryString,
});

export const shopByNameQuerySchema = z.object({
  name: z.string({ required_error: 'name 必填' }).trim().min(1, 'name 必填'),
  city: optionalQueryString,
  limit: queryInt(1, 200, 100),
  cursor: optionalQueryString,
});

// ---------------------------------------------------------------- 认证

export const wechatLoginSchema = z.object({
  code: z.string({ required_error: 'code 必填' }).trim().min(1, 'code 必填'),
  clientRequestId,
});

export const anonymousLoginSchema = z.object({
  deviceId: z.string({ required_error: 'deviceId 必填' }).trim().min(1, 'deviceId 必填').max(128, 'deviceId 过长'),
  clientRequestId,
});

export const refreshSchema = z.object({
  refreshToken: z.string({ required_error: 'refreshToken 必填' }).trim().min(1, 'refreshToken 必填'),
});
