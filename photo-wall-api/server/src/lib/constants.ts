/**
 * 全局常量。
 *
 * ⚠ 历史坑：FIELD_LIMITS / MAX_PHOTOS 曾经前后端各手抄一份，漂移的后果是
 * 「用户能输入、能提交，然后被服务端 422 拒掉，还不知道错在哪」（契约 §3.7 / 审计 R6）。
 *
 * 现在这些数字只在前端 core 定义一份（packages/core/src/records.ts），由
 * scripts/gen-data.mjs 生成本文件引用的 shared-limits.ts。后端**不再手抄**，
 * 改上限只改前端，重跑 `npm run gen-data` 即同步。
 * 新增的全局常量若与前端无关（如纯服务端开关）才写在这个文件里。
 */
export { FIELD_LIMITS, FIELD_LABELS, MAX_PHOTOS } from '../data/shared-limits.js';
export type { FieldName } from '../data/shared-limits.js';
