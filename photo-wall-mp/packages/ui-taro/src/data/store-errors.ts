/* ================================================================
   错误与写入工具：把"这次失败到底是什么"翻译成用户能懂的一句话。

   为什么单独一层：`client.ts` 的 `errorText` 只认识网络/业务错误，不认识
   「离线写被拒」（那是 store 的判断）。顺序很重要 —— 先判 OfflineWriteError，
   再委托给 errorText，否则离线写会退化成没用的"出了点问题"。
   ================================================================ */
import { NetworkError, errorText } from '../api/client';

/** 是否属于「后端不可用」这类错误（决定要不要切本地兜底） */
export function isOfflineError(e: unknown): boolean {
  return e instanceof NetworkError;
}
/** 离线写被拒（页面据此给「等网络恢复再试」的文案，而不是"操作失败"） */
export class OfflineWriteError extends Error {
  constructor() {
    super('现在没有网络，先别贴');
    this.name = 'OfflineWriteError';
  }
}
/** 把写操作异常转成给用户看的一句话（页面 toast 用）。
 *
 *  为什么不直接用 client 的 errorText：那是网络/业务错误的映射，不认识
 *  这里新加的 OfflineWriteError（会退化成"出了点问题"）。分层上 store
 *  更清楚"这次失败是不是因为离线"，所以由它先判，再委托给 errorText。 */
export function writeErrorText(e: unknown): string {
  if (e instanceof OfflineWriteError) {
    return '现在没有网络，照片和你写的内容先留着，联网后再点一次';
  }
  return errorText(e);
}
/* ---------------- 小工具 ---------------- */

/** 幂等键：弱网重试不会产生两条记录（§3.5） */
export function idempotencyKey(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 本地模式下的时间戳（与 core.stampNow 同格式，避免本地/远程两种形状） */
export function stampNowLocal(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
