/* 由 scripts/gen-data.mjs 从 packages/core/src/records.ts 生成，请勿手改。
 * 单一真源 = 前端 core 的 FIELD_LIMITS / FIELD_LABELS / MAX_PHOTOS。
 * 后端 zod 校验与前端 <Input maxlength> 共用同一份数字，杜绝 §3.7 的 422 漂移。 */
export const FIELD_LIMITS = {"eat":60,"shop":80,"city":40,"district":40,"note":200} as const;

export type FieldName = keyof typeof FIELD_LIMITS;

/** 字段中文名（错误提示用，与前端文案口径一致） */
export const FIELD_LABELS: Record<FieldName, string> = {"eat":"这一口","shop":"哪一家","city":"在哪座城","district":"区/县","note":"想记两句"} as const;

/** 一条记录至多 5 张照片（与前端 MAX_PHOTOS 逐字一致） */
export const MAX_PHOTOS = 5;
