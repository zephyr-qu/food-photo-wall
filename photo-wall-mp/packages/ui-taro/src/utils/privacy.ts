/* ================================================================
   隐私授权（微信「用户隐私保护指引」）

   背景：app.config.ts 开了 `__usePrivacyCheck__`。从基础库 2.32.3 起，
   调用 chooseMedia 这类涉及隐私的接口时：
     · 用户还没同意过隐私协议 → 触发 onNeedPrivacyAuthorization；
     · **如果没人监听**，接口直接失败（真机上就是"点了选图没反应"）；
     · 有人监听 → 接口挂起，等我们弹窗让用户同意/拒绝后调 resolve 继续。

   所以这里做三件事：
   1. 注册唯一的监听（幂等；页面重进不重复注册）；
   2. 用一个极小的订阅式 store 把「要不要弹窗」交给 UI（PrivacyGate）；
   3. 同意/拒绝后带着按钮 id 调 resolve，让挂起的 chooseMedia 继续或失败。

   只在 weapp 生效：H5 没有隐私协议概念，全部 no-op。

   注意：同意按钮必须是 <Button open-type="agreePrivacyAuthorization" id="...">，
   基础库会校验那个按钮确实被点过，所以 resolve 必须带 buttonId。
   ================================================================ */
import Taro from '@tarojs/taro';

const IS_WEAPP = process.env.TARO_ENV === 'weapp';
/** 隐私协议名从 getPrivacySetting 拿；拿不到就用通称 */
const FALLBACK_CONTRACT = '用户隐私保护指引';

type ResolveOption = {
  event: 'agree' | 'disagree' | 'exposureAuthorization';
  buttonId?: string;
};
type Resolve = (option: ResolveOption) => void;

let pendingResolve: Resolve | null = null;
let visible = false;
let contractName = FALLBACK_CONTRACT;
let registered = false;

const listeners = new Set<() => void>();
function emit(): void {
  listeners.forEach((fn) => fn());
}

/** 订阅「隐私弹窗是否要显示」；返回取消函数。 */
export function subscribePrivacyGate(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function isPrivacyGateOpen(): boolean {
  return visible;
}

export function privacyContractName(): string {
  return contractName;
}

/**
 * 注册隐私监听。幂等：多次调用只注册一次。
 * 只应该在会触发隐私接口的页面调用（当前是 compose）。
 */
export function registerPrivacyGate(): void {
  if (!IS_WEAPP || registered) return;
  if (typeof Taro.onNeedPrivacyAuthorization !== 'function') {
    /* 基础库过旧：没有这个 API，保持旧行为（chooseMedia 自己会失败并 toast） */
    return;
  }
  registered = true;

  Taro.onNeedPrivacyAuthorization((resolve) => {
    pendingResolve = resolve as Resolve;
    visible = true;
    /* 协议名来自小程序后台「用户隐私保护指引」的标题；
       拿不到就回落通称，不阻塞弹窗 */
    if (typeof Taro.getPrivacySetting === 'function') {
      Taro.getPrivacySetting({
        success: (res) => {
          if (res?.privacyContractName) contractName = res.privacyContractName;
          emit();
        },
        fail: () => undefined,
      });
    }
    emit();
  });
}

/** 用户点了「同意并继续」：buttonId 必须是同意按钮的 id（基础库会校验）。 */
export function agreePrivacy(buttonId: string): void {
  const resolve = pendingResolve;
  pendingResolve = null;
  visible = false;
  emit();
  resolve?.({ event: 'agree', buttonId });
}

/** 用户点了「暂不使用」：挂起的隐私接口会以 privacy 错误失败。 */
export function disagreePrivacy(): void {
  const resolve = pendingResolve;
  pendingResolve = null;
  visible = false;
  emit();
  resolve?.({ event: 'disagree' });
}

/** 打开《用户隐私保护指引》原文（小程序后台维护）。 */
export function openPrivacyContract(): void {
  if (!IS_WEAPP || typeof Taro.openPrivacyContract !== 'function') return;
  Taro.openPrivacyContract({
    fail: (e) => {
      /* 后台没配隐私指引时这里会失败；提示用户去看协议即可，不弹错误 */
      console.warn('[privacy] openPrivacyContract 失败', e);
    },
  });
}

/** 仅用于开发时预览弹窗样式（模拟器没有隐私拦截时也能看到 UI）。 */

