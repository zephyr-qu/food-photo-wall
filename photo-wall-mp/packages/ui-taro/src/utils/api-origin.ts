/* ================================================================
   运行时后端覆盖（H5 的 `?api=` / localStorage）白名单判定。

   为什么需要：这个开关本来是给 E2E / 联调用的，但以前没有任何校验 ——
   一条 `https://<h5-host>/?api=https://attacker.example` 链接就能把值
   写进 localStorage，此后该浏览器的所有请求（含 `Authorization: Bearer`
   与 refreshToken）都会发给攻击者主机（P1-6）。

   放行的三类地址都是外部链接利用不了的：
     · localhost / 127.0.0.1 / ::1（E2E、本机联调）
     · 私有网段 10/8、172.16/12、192.168/16（真机联调）
     · 与页面同源（H5 与后端部署在同一域名）
   正式环境请用构建期的 `TARO_APP_API_ORIGIN`。

   纯函数、不依赖 Taro，便于 node --test 直接跑（见 test/api-origin.test.ts）。
   ================================================================ */

/** 私有 IPv4 段：10/8、172.16/12、192.168/16 */
function isPrivateHost(host: string): boolean {
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  return false;
}

/**
 * @param origin     候选后端 origin（来自 `?api=` 或 localStorage）
 * @param pageOrigin 当前页面 origin（H5 传 `window.location.origin`）
 */
export function isAllowedRuntimeOrigin(origin: string, pageOrigin?: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  /* 带账号密码的 URL（http://user:pass@host）一律拒绝：纯属投毒/钓鱼形态 */
  if (url.username || url.password) return false;

  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]') {
    return true;
  }
  if (isPrivateHost(host)) return true;

  if (pageOrigin) {
    try {
      if (url.origin === pageOrigin) return true;
    } catch {
      /* ignore */
    }
  }
  return false;
}
