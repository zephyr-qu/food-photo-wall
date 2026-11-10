/**
 * 统一错误模型。响应体固定为：
 *   { "error": { "code", "message", "requestId", "fields"?, "candidates"? } }
 * 码表严格对齐 docs/api/photo-wall-api.md §3.3。
 */
export type ErrorCode =
  | 'BAD_REQUEST'
  | 'VALIDATION_FAILED'
  | 'TOKEN_MISSING'
  | 'TOKEN_INVALID'
  | 'TOKEN_EXPIRED'
  | 'WECHAT_CODE_INVALID'
  | 'NOT_FOUND'
  | 'NO_RECORD'
  | 'CONFLICT'
  | 'PHOTO_IN_USE'
  | 'GONE'
  | 'FILE_TOO_LARGE'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'IMAGE_REJECTED'
  | 'RATE_LIMITED'
  | 'INTERNAL_ERROR';

export interface ErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    requestId?: string;
    fields?: Record<string, string>;
    candidates?: unknown;
  };
}

export class AppError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly fields?: Record<string, string>;
  readonly headers?: Record<string, string>;

  constructor(
    status: number,
    code: ErrorCode,
    message: string,
    extra?: { fields?: Record<string, string>; headers?: Record<string, string> },
  ) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.fields = extra?.fields;
    this.headers = extra?.headers;
  }
}

export const err = {
  badRequest: (message = '请求参数不合法') => new AppError(400, 'BAD_REQUEST', message),

  validation: (fields: Record<string, string>, message = '字段校验失败') =>
    new AppError(422, 'VALIDATION_FAILED', message, { fields }),

  tokenMissing: () => new AppError(401, 'TOKEN_MISSING', '缺少 Authorization 头'),
  tokenInvalid: (m = '令牌无效') => new AppError(401, 'TOKEN_INVALID', m),
  tokenExpired: () => new AppError(401, 'TOKEN_EXPIRED', 'accessToken 已过期'),

  wechatCodeInvalid: (m = '微信 code 无效或已使用') => new AppError(401, 'WECHAT_CODE_INVALID', m),

  /** 记录/店铺/照片不存在，或不属于当前用户 —— 统一 404，绝不 403 */
  notFound: (message = '资源不存在') => new AppError(404, 'NOT_FOUND', message),
  noRecord: (message = '这个范围里还没有照片') => new AppError(404, 'NO_RECORD', message),

  conflict: (message = '版本冲突，请拉取最新数据后重试') => new AppError(409, 'CONFLICT', message),
  photoInUse: (message = '照片仍被记录引用，先删记录') => new AppError(409, 'PHOTO_IN_USE', message),

  gone: (message = '已超过撤销窗口') => new AppError(410, 'GONE', message),

  fileTooLarge: (message = '照片超过 10 MiB') => new AppError(413, 'FILE_TOO_LARGE', message),
  unsupportedMedia: (message = '仅支持 jpeg / png / webp') =>
    new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', message),
  imageRejected: (message = '图片未通过内容安全校验') => new AppError(422, 'IMAGE_REJECTED', message),

  rateLimited: (retryAfterSec: number) =>
    new AppError(429, 'RATE_LIMITED', '触发限流，请稍后重试', {
      headers: { 'Retry-After': String(Math.max(1, Math.ceil(retryAfterSec))) },
    }),

  internal: (message = '服务内部错误') => new AppError(500, 'INTERNAL_ERROR', message),
};
