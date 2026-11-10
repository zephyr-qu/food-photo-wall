/* ================================================================
   统一错误体（契约 §3.3）

   { "error": { "code", "message", "requestId", "fields"? } }

   约定：
   - 「资源不存在 / 不属于当前用户」一律 404 NOT_FOUND，**绝不 403**
     —— 不泄露 id 是否存在（§3.2）。
   - 422 带 `fields`（字段级标红）；400 只有 message，没有 fields。
   ================================================================ */

/** 错误码 → HTTP 状态码（与 §3.3 的表逐条对齐） */
export const STATUS_OF = {
  BAD_REQUEST: 400,
  TOKEN_MISSING: 401,
  TOKEN_INVALID: 401,
  TOKEN_EXPIRED: 401,
  WECHAT_CODE_INVALID: 401,
  NOT_FOUND: 404,
  NO_RECORD: 404,
  CONFLICT: 409,
  PHOTO_IN_USE: 409,
  GONE: 410,
  FILE_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  VALIDATION_FAILED: 422,
  IMAGE_REJECTED: 422,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
  SERVICE_UNAVAILABLE: 503,
};

export class ApiError extends Error {
  /**
   * @param {string} code 机器可读错误码
   * @param {string} [message] 人类可读文案（前端可直接 toast）
   * @param {{status?:number, fields?:Record<string,string>, headers?:Record<string,string>}} [extra]
   */
  constructor(code, message, extra = {}) {
    super(message || code);
    this.name = 'ApiError';
    this.code = code;
    this.status = extra.status ?? STATUS_OF[code] ?? 500;
    this.fields = extra.fields;
    this.headers = extra.headers;
  }
}

export const badRequest = (message) => new ApiError('BAD_REQUEST', message);
export const notFound = (message = '记录不存在') => new ApiError('NOT_FOUND', message);
export const validationFailed = (fields, message = '字段校验失败') =>
  new ApiError('VALIDATION_FAILED', message, { fields });
export const unauthorized = (code = 'TOKEN_MISSING', message = '请先登录') =>
  new ApiError(code, message);

/** 把 ApiError 序列化成响应体 */
export function errorBody(err, requestId) {
  const body = {
    error: {
      code: err.code,
      message: err.message,
      requestId,
    },
  };
  if (err.fields && Object.keys(err.fields).length) body.error.fields = err.fields;
  return body;
}
