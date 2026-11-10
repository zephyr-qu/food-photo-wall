/* ================================================================
   全局配置

   1) 后端地址：小程序必须在微信后台把域名加进 request/uploadFile 合法域名；
      本地联调时在开发者工具勾「不校验合法域名」（project.config.json 的
      urlCheck: false 已经关掉了）。
   2) 本地模式（USE_REMOTE_DATA）：不连后端，沿用 storage + 预置数据。
      保留它是为了「后端挂了/演示没网」时仍能开；也是灰度开关。
   3) 真机预览：手机访问不到电脑的 127.0.0.1，所以这里支持按「运行环境」
      自动选 baseURL —— 模拟器/浏览器用 localhost，真机用局域网 IP。
      LAN_HOST 留空时自动探测（H5 用 location.hostname），探测不到再回落
      localhost。改完重新 build 即可，不用改代码。

   ---------- 配置从哪来（改了这里就不用改代码） ----------
   走 Taro 内置的 .env 机制（@tarojs/helper 的 dotenvParse + DefinePlugin），
   构建时把 `TARO_APP_*` 内联进产物。变量写在本包的 `.env`（从 `.env.example`
   复制，**不入库**）或 `.env.local`（个人覆盖，同样已 gitignore），后者优先级更高。

     TARO_APP_API_PORT    后端端口。默认 8787 —— 这是契约里的默认端口，
                          也是 `server/` 的默认 PORT。
     TARO_APP_API_ORIGIN  完整 origin（如 https://api.example.com）。填了它
                          就完全接管，端口/局域网逻辑全部让位 —— 正式环境用这个。
     TARO_APP_LAN_HOST    真机联调的局域网 IP；留空则 H5 自动探测。

   ⚠ 为什么默认是 8787 而不是别的：`docs/api/photo-wall-api.md` 与
     `server/src/config.ts` 的默认 PORT 都是 8787。以前这里同时存在一个
     零依赖 mock（`photo-wall-mp/server`）也监听 8787，导致「界面看着对、
     其实是 mock 的演示数据」。现在 mock 只做离线演示用，起它之前请先看
     它 README 的端口说明，别和真后端抢同一个端口。
   ================================================================ */
import Taro from '@tarojs/taro';

import { isAllowedRuntimeOrigin } from './utils/api-origin.ts';

/** 构建期注入的原始值（Taro DefinePlugin 做的是**字面替换**，
    所以必须写 `process.env.TARO_APP_XXX` 全名，不能 `process.env[key]`）。 */
const RAW_PORT = process.env.TARO_APP_API_PORT;
const RAW_ORIGIN = process.env.TARO_APP_API_ORIGIN;
const RAW_LAN_HOST = process.env.TARO_APP_LAN_HOST;

const pick = (raw: string | undefined, fallback: string): string => {
  const v = (raw || '').trim();
  return v || fallback;
};

/** 后端端口（契约默认 8787；团队 .env 里可覆写） */
const API_PORT = Number(pick(RAW_PORT, '8787')) || 8787;

/**
 * 真机联调用的局域网地址（手机和电脑同一个 Wi-Fi）。
 * 留空 = 自动：H5 取 location.hostname；小程序取 devtools 的 systemInfo 猜不出来，
 * 只能显式填。例如 '192.168.1.17'。
 */
const LAN_HOST = pick(RAW_LAN_HOST, '');

/** 显式覆盖（正式环境直接填 https 域名，例如 'https://api.xshifu.example.com'）。 */
const API_ORIGIN_OVERRIDE: string = pick(RAW_ORIGIN, '');

function isLocalhost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

/** 生产包缺后端地址只警告一次（getter 每次请求都会走 resolveOrigin） */
let warnedNoOrigin = false;

/** 选 origin：显式覆盖 > 真机局域网 > 本机 */
function resolveOrigin(): string {
  /* H5 运行时覆盖：`?api=http://host:port` 或 localStorage 里的键。
     为什么需要：H5 产物是**构建期**决定后端的，而部署/测试现场经常要临时
     指向另一个后端（E2E 用关限流的实例、演示用 mock、灰度用新环境）。
     重新构建一次要几十秒，运行时覆盖让这件事变成改个 URL。
     weapp 不适用（小程序没有 location，也不该让用户改后端）。
     ⚠ 只接受本机/局域网/同源地址，且拒绝时清掉已落盘的坏值 —— 见
     isAllowedRuntimeOrigin 的说明。 */
  if (process.env.TARO_ENV === 'h5' && typeof window !== 'undefined') {
    try {
      const fromQuery = new URLSearchParams(window.location.search).get('api');
      const fromStorage = window.localStorage.getItem('photo-wall:api-origin');
      const runtime = (fromQuery || fromStorage || '').trim().replace(/\/$/, '');
      if (runtime) {
        if (isAllowedRuntimeOrigin(runtime, window.location.origin)) {
          /* 存下来：刷新/路由跳转会丢 query，但 localStorage 不会 */
          if (fromQuery) window.localStorage.setItem('photo-wall:api-origin', runtime);
          return runtime;
        }
        /* 不在允许范围：清掉可能已落盘的坏值，绝不把令牌发过去 */
        console.warn('[config] 已拒绝非本机/局域网的运行时后端覆盖：', runtime);
        try {
          window.localStorage.removeItem('photo-wall:api-origin');
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* localStorage 被禁（隐私模式）/ URL 解析失败 → 走构建期配置 */
    }
  }

  if (API_ORIGIN_OVERRIDE) return API_ORIGIN_OVERRIDE.replace(/\/$/, '');

  /* H5：直接跟页面同 host（页面本身就是从局域网 IP 打开的） */
  if (process.env.TARO_ENV === 'h5' && typeof window !== 'undefined') {
    const host = window.location.hostname;
    if (host) return `${window.location.protocol}//${host}:${API_PORT}`;
  }

  /* 小程序：开发者工具里走 localhost；真机必须用局域网 IP（127.0.0.1 是手机自己） */
  if (process.env.TARO_ENV === 'weapp') {
    try {
      const info =
        typeof Taro.getDeviceInfo === 'function'
          ? Taro.getDeviceInfo()
          : Taro.getSystemInfoSync();
      /* devtools 的 platform 是 'devtools'；真机是 'ios' / 'android' */
      const platform = (info as { platform?: string }).platform || '';
      if (platform === 'devtools' || !platform) {
        return `http://localhost:${API_PORT}`;
      }
    } catch {
      /* 取不到就当模拟器 */
      return `http://localhost:${API_PORT}`;
    }
    /* 真机：用 LAN_HOST；没填就退回 localhost（会失败，但至少日志能看出原因）。
       生产包走到这里 = 既没有 TARO_APP_API_ORIGIN 也没有 LAN_HOST，
       基本等于"发出去的包全站连不上"，必须显式报出来（构建期守卫见
       config/index.js 的 RELEASE=1 分支）。 */
    if (process.env.NODE_ENV === 'production' && !LAN_HOST && !warnedNoOrigin) {
      warnedNoOrigin = true;
      console.error(
        '[config] 生产包未配置 TARO_APP_API_ORIGIN / TARO_APP_LAN_HOST，真机将回落到 localhost 并连接失败',
      );
    }
    return `http://${LAN_HOST || 'localhost'}:${API_PORT}`;
  }

  return `http://${LAN_HOST || 'localhost'}:${API_PORT}`;
}

/**
 * 后端 baseURL（含 /v1）。
 *
 * ⚠ 用 getter 而不是模块级常量：`resolveOrigin()` 会读 localStorage 里的
 * 运行时覆盖（`?api=` 写入的那个），而模块常量只在**首次加载**时求值一次。
 * 曾经写成 `export const API_BASE_URL = ...`，导致"先打开页面、再写
 * localStorage 覆盖"的顺序下，本次会话仍打旧地址（要刷新才生效）——
 * E2E 里表现为"数据造好了但墙是空的"，排查成本很高。
 *
 * 改成 getter 后，每次请求都会重新解析：性能上只是读一次 localStorage，
 * 相对一次网络请求可忽略。
 */
export function getApiBaseUrl(): string {
  return `${resolveOrigin()}/v1`;
}

/** 兼容旧引用：仍导出常量形式（首次求值），但新代码请用 getApiBaseUrl()。 */
export const API_BASE_URL = `${resolveOrigin()}/v1`;

/** 当前解析出的 origin（调试用，页面可在 console 里打；同样是 getter 语义） */
export function getApiOrigin(): string {
  return resolveOrigin();
}

/** 兼容旧引用 */
export const API_ORIGIN = resolveOrigin();

/** 请求超时（毫秒）。弱网下 8s 足够，别让用户对着空白等太久。 */
export const API_TIMEOUT = 8000;

/**
 * 是否使用「远程数据」。
 * true  = 走后端（正常形态）；失败时数据层回落到本地缓存并提示。
 * false = 纯本地模式（旧的 storage 形态，演示/离线用）。
 */
export const USE_REMOTE_DATA = true;

/** 列表每页条数（与后端默认一致）。 */
export const PAGE_SIZE = 10;

/** 首屏请求条数：墙要一屏铺满，比翻页大一些（§6.2.1 建议 20）。 */
export const FIRST_PAGE_SIZE = 20;

/** 上传前压缩质量（WeChat compressImage 的 quality，1-100）。 */
export const PHOTO_COMPRESS_QUALITY = 72;

/** uploadFile 的 multipart 字段名（与后端约定）。 */
export const PHOTO_UPLOAD_FIELD = 'file';

/** 是否本机地址（数据层据此提示「真机需要局域网 IP」） */
export function isLocalhostOrigin(): boolean {
  /* 不用 new URL()：小程序运行时不一定有，字符串判断更稳 */
  const host = API_ORIGIN.replace(/^https?:\/\//, '').split(':')[0];
  return isLocalhost(host);
}
