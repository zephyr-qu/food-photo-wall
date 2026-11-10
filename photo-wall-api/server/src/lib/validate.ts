/** 入参校验：zod → 契约要求的 422 `{ error: { code:'VALIDATION_FAILED', fields } }` */
import type { Context } from 'hono';
import { z } from 'zod';
import { err } from './errors.js';

/** 契约 §3.4：at 必须是 'YYYY-MM-DDTHH:mm'（定宽、零填充、无秒、无时区） */
export const AT_LOCAL_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
export const TZ_OFFSET_RE = /^[+-]\d{2}:\d{2}$/;

function toFields(error: z.ZodError): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.length ? issue.path.join('.') : '_';
    if (!fields[key]) fields[key] = issue.message;
  }
  return fields;
}

/** 解析 JSON body；失败 → 422 + fields（eat 为空时前端「吃了什么是必填」） */
export async function parseBody<S extends z.ZodTypeAny>(c: Context, schema: S): Promise<z.infer<S>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw err.badRequest('请求体不是合法 JSON');
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw err.validation(toFields(parsed.error));
  return parsed.data;
}

/** 解析 query；结构错误按 400 处理（契约：limit/cursor 越界是 400，无 fields） */
export function parseQuery<S extends z.ZodTypeAny>(c: Context, schema: S): z.infer<S> {
  const parsed = schema.safeParse(c.req.query());
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const key = first?.path.join('.') || 'query';
    throw err.badRequest(`参数 ${key} 不合法${first?.message ? `：${first.message}` : ''}`);
  }
  return parsed.data;
}

/** 可空文本：trim；'' / null → null（契约：空串归一 null，不能让前端拿到 ""） */
export const nullableText = (max: number, label: string) =>
  z
    .union([z.string(), z.null()])
    .optional()
    .transform((v) => {
      if (v === undefined || v === null) return null;
      const t = v.trim();
      return t === '' ? null : t;
    })
    .refine((v) => v === null || v.length <= max, { message: `${label}最多 ${max} 个字符` });

/** query 里的 boolean：接受 true/false/1/0 */
export const queryBool = z
  .union([z.enum(['true', 'false', '1', '0', '']), z.boolean()])
  .optional()
  .transform((v) => v === true || v === 'true' || v === '1');

/** query 里的 limit：字符串数字 → int；越界由调用方转 400（无 fields） */
export const queryInt = (min: number, max: number, def: number) =>
  z
    .union([z.string(), z.number()])
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v === '') return def;
      const n = typeof v === 'number' ? v : Number(v);
      if (!Number.isInteger(n)) {
        ctx.addIssue({ code: 'custom', message: '必须是整数' });
        return z.NEVER;
      }
      if (n < min || n > max) {
        ctx.addIssue({ code: 'custom', message: `必须在 ${min}–${max} 之间` });
        return z.NEVER;
      }
      return n;
    });

/** 空 query 值视为"未传" */
export const optionalQueryString = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v === '' ? undefined : v));
