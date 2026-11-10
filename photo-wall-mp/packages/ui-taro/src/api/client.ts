/* ================================================================
   HTTP 客户端

   职责只有四件：
   1. 拼 baseURL / query，统一带 Authorization 与 X-Timezone-Offset；
   2. 会话：token 存 storage，冷启动 wx.login 静默换 token（无弹窗）；
   3. 401 TOKEN_EXPIRED 时刷新并**只重放一次**（避免死循环）；
   4. 把服务端错误体 `{error:{code,message,fields}}` 变成带 code 的异常，
      页面按 code 决定文案（例如 404 显示「这一条已经不在了」）。

   不做重试/降级：那是数据层的事（store 决定失败后回落到本地缓存）。
   ================================================================ */
import Taro from '@tarojs/taro';

import { getApiBaseUrl, API_TIMEOUT, PHOTO_UPLOAD_FIELD } from '../config.ts';

const TOKEN_KEY = 'photo-wall:tokens:v1';
const DEVICE_KEY = 'photo-wall:device-id:v1';

const IS_WEAPP = process.env.TARO_ENV === 'weapp';

export interface Tokens {
  accessToken: string;
  refreshToken: string;
  /** epoch ms */
  expiresAt: number;
}

/** 服务端错误（带机器可读 code，页面按它分支） */
export class ApiError extends Error {
  code: string;
  status: number;
  fields?: Record<string, string>;
  /** 429 时服务端给的「多少秒后再试」（Retry-After 头） */
  retryAfter?: number;

  constructor(
    status: number,
    code: string,
    message: string,
    fields?: Record<string, string>,
    retryAfter?: number,
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.fields = fields;
    this.retryAfter = retryAfter;
  }
}

/** 网络层失败（断网、超时、域名没配）—— 与业务错误分开，文案不同 */
export class NetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NetworkError';
  }
}

/* ---------------- token ---------------- */

let tokens: Tokens | null = null;
let tokensLoaded = false;

function loadTokens(): Tokens | null {
  if (tokensLoaded) return tokens;
  tokensLoaded = true;
  try {
    const raw = Taro.getStorageSync(TOKEN_KEY) as Tokens | '';
    tokens = raw && raw.accessToken ? raw : null;
  } catch {
    tokens = null;
  }
  return tokens;
}

function saveTokens(next: Tokens | null): void {
  tokens = next;
  tokensLoaded = true;
  try {
    if (next) Taro.setStorageSync(TOKEN_KEY, next);
    else Taro.removeStorageSync(TOKEN_KEY);
  } catch (e) {
    console.warn('[api] 保存 token 失败', e);
  }
}

/** 是否有可用会话（给「要不要先登录」的判断用） */
export function hasSession(): boolean {
  return Boolean(loadTokens()?.accessToken);
}

/** 退出登录（调试用；正式版没有入口） */
export function clearSession(): void {
  saveTokens(null);
}

/**
 * 从当前 access token 解析 userId（JWT payload 的 sub）。
 *
 * 仅用于客户端缓存 / storage 的**按用户隔离**（见 store 的 P1-4/P1-5），
 * 不做签名校验 —— 防篡改由后端负责，这里只要一个稳定的身份键。
 * 拿不到（未登录 / token 不可解析）时返回 null。
 */
export function currentUserId(): string | null {
  const token = loadTokens()?.accessToken;
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(decodeBase64Url(parts[1])) as { sub?: string };
    return payload.sub || null;
  } catch {
    return null;
  }
}

/** base64url → UTF-8 字符串。weapp / H5 都走 Taro 的 ArrayBuffer 桥，避免依赖 atob。 */
function decodeBase64Url(s: string): string {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const buf = Taro.base64ToArrayBuffer(b64);
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
  return decodeURIComponent(escape(bin));
}

/* ---------------- 登录 ---------------- */

/** 设备号：H5 / 无 openid 环境下的匿名账号标识 */
function deviceId(): string {
  try {
    const saved = Taro.getStorageSync(DEVICE_KEY) as string;
    if (saved) return saved;
  } catch {
    /* ignore */
  }
  const id = `dev_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  try {
    Taro.setStorageSync(DEVICE_KEY, id);
  } catch {
    /* ignore */
  }
  return id;
}

/** 小程序登录：wx.login 拿 code（5 分钟、一次性）→ 换 token */
async function weappLogin(): Promise<Tokens> {
  /* wx.login 不遵守自己的超时承诺，开发者工具里偶发永远 pending
     （登录态陈旧/网络层卡住的经典症状）。5s 兜底，绝不让它吊死整条登录链。 */
  const { code } = await withTimeout(Taro.login(), 5000, 'wx.login');
  const res = await rawRequest<{ accessToken: string; refreshToken: string; expiresIn: number }>(
    'POST',
    '/auth/wechat/login',
    { body: { code } },
    { auth: false },
  );
  return {
    accessToken: res.accessToken,
    refreshToken: res.refreshToken,
    expiresAt: Date.now() + (res.expiresIn || 7200) * 1000,
  };
}

/** H5 / 开发环境：设备号换匿名账号（P1 接口，mock 后端已实现） */
async function anonymousLogin(): Promise<Tokens> {
  const res = await rawRequest<{ accessToken: string; refreshToken: string; expiresIn: number }>(
    'POST',
    '/auth/anonymous',
    { body: { deviceId: deviceId() } },
    { auth: false },
  );
  return {
    accessToken: res.accessToken,
    refreshToken: res.refreshToken,
    expiresAt: Date.now() + (res.expiresIn || 7200) * 1000,
  };
}

/**
 * 保证有会话：没有就静默登录一次。并发调用共享同一个 Promise。
 *
 * ⚠ 这里必须**同时**看 token 存不存在**和它还有多久过期**。
 *
 * 以前只看「存不存在」（`if (cur?.accessToken)`），于是过期 token 也被当成
 * 有效会话直接放行 —— 所有并发请求带着同一个死 token 去打服务端，
 * 全部 401，然后全部去 refresh。而服务端的 refreshToken 是**轮换**的
 * （旧的一次性作废），并发 refresh 只有一发成功，其余全 401，
 * 于是又各自去 `saveTokens(null)` + 重新登录 —— 登录接口限流 10/min，
 * 4 个并发请求就能把额度打光，表现为「墙是空的 / 详情加载不出来 /
 * 随机一道点了没反应」。
 *
 * 现在（token 快过期时）：
 *   · 还有 refreshToken → **刷新**（保住同一个账号，不换身份）；
 *   · 完全没有会话     → 登录。
 * 两条路都是**单飞**的（refreshTask / loginTask），并发调用共享同一发。
 */
let loginTask: Promise<Tokens> | null = null;

/** 登录失败后的退避窗口：期间直接快速失败，不再打 /auth。 */
let loginFailUntil = 0;

/** 提前多少毫秒把 token 当作过期（留出请求往返的余量） */
const TOKEN_SKEW_MS = 60_000;

export function ensureSession(): Promise<Tokens> {
  const cur = loadTokens();
  /* 会话还在且没过期 → 直接用（零额外往返） */
  if (cur?.accessToken && cur.expiresAt > Date.now() + TOKEN_SKEW_MS) {
    return Promise.resolve(cur);
  }
  /* 会话还在但过期了 → 先尝试刷新（保住同一个账号）。
     refreshTokens() 自己是单飞的，所以并发调用只会打一发 /auth/refresh。 */
  if (cur?.refreshToken) return refreshTokens().then((t) => t ?? login());
  /* 完全没有会话 → 登录 */
  return login();
}

/** 真正登录一次（单飞）。 */
function login(): Promise<Tokens> {
  if (loginTask) return loginTask;
  /* 刚失败过：别再打 /auth（限流 10/min，连打会把窗口彻底废掉） */
  if (Date.now() < loginFailUntil) {
    return Promise.reject(new NetworkError('登录暂时不可用，请稍后再试'));
  }

  loginTask = (async () => {
    try {
      console.log('[session] login begin', IS_WEAPP ? 'weapp' : 'h5');
      /* 整条登录链（wx.login + 换 token）再套一层总闸：401 重放会重新进到这里，
         若这里挂住，页面看起来「什么都好好的」，但第一次写请求会永远 pending
         ——表现就是「点随机一道卡死且没有任何提示」。总闸保证 8s 内必定出结果。 */
      const next = await withTimeout(
        IS_WEAPP ? weappLogin() : anonymousLogin(),
        API_TIMEOUT,
        '登录',
      );
      saveTokens(next);
      console.log('[session] login ok');
      return next;
    } catch (e) {
      console.error('[session] login failed', e);
      /* 退避：失败后 5s 内不再打 /auth。
         没有它，429 会自我强化 —— 每次点击都再打一次必然 429 的接口，
         用户看到的就是「随机一道点了没反应，怎么点都没用」。 */
      loginFailUntil = Date.now() + 5_000;
      throw e;
    } finally {
      loginTask = null;
    }
  })();
  return loginTask;
}

/**
 * 刷新 token；失败就清掉会话，让下一次请求重新登录。
 *
 * ⚠ 必须**单飞**（single-flight）：并发 401 时只有一发真的去打 /auth/refresh。
 *
 * 服务端的 refreshToken 是轮换的（`services/auth.ts` 里先删旧的再签新的），
 * 所以同一枚 refreshToken 并发刷新只有一发能成功，其余必然 401。
 * 不做单飞的话：N 个并发请求 → N 次 refresh → 1 成功 N-1 失败 →
 * 失败的又各自 `saveTokens(null)` + 重新登录 → 登录限流被打爆。
 */
let refreshTask: Promise<Tokens | null> | null = null;

async function refreshTokens(): Promise<Tokens | null> {
  if (refreshTask) return refreshTask;
  refreshTask = (async () => {
    const cur = loadTokens();
    if (!cur?.refreshToken) return null;
    try {
      const res = await rawRequest<{ accessToken: string; refreshToken: string; expiresIn: number }>(
        'POST',
        '/auth/refresh',
        { body: { refreshToken: cur.refreshToken } },
        { auth: false },
      );
      const next: Tokens = {
        accessToken: res.accessToken,
        refreshToken: res.refreshToken,
        expiresAt: Date.now() + (res.expiresIn || 7200) * 1000,
      };
      saveTokens(next);
      return next;
    } catch (e) {
      console.warn('[api] 刷新 token 失败，重新登录', e);
      /* ⚠ 只有「当前存着的还是我这次用的那个 token」才清空。
         并发场景下别人可能已经刷新成功了（存了新 token），
         这时把会话清掉等于**把赢家刚拿到的有效 token 抹掉**，
         逼着客户端又去登录一次 —— 而登录限流只剩 10/min。
         少一次登录，就少一次 429。 */
      if (loadTokens()?.refreshToken === cur.refreshToken) saveTokens(null);
      return null;
    } finally {
      refreshTask = null;
    }
  })();
  return refreshTask;
}

/* ---------------- 请求 ---------------- */

type Query = Record<string, string | number | boolean | null | undefined>;

interface RequestOptions {
  body?: unknown;
  query?: Query;
  /** false = 不带 Authorization（登录/字典类接口） */
  auth?: boolean;
  /** 透传请求头（Idempotency-Key / If-Match） */
  headers?: Record<string, string>;
  /** 超时毫秒，默认取 config */
  timeout?: number;
}

/** 时区偏移：`+08:00` 形态，服务端用来补 tzOffset（§3.4） */
function tzOffset(): string {
  const minutes = -new Date().getTimezoneOffset();
  const sign = minutes >= 0 ? '+' : '-';
  const abs = Math.abs(minutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `${sign}${hh}:${mm}`;
}

function buildUrl(path: string, query?: Query): string {
  const url = `${getApiBaseUrl()}${path}`;
  if (!query) return url;
  const pairs = Object.entries(query)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return pairs.length ? `${url}?${pairs.join('&')}` : url;
}

/**
 * 安全网：给任意 promise 套一个客户端超时。
 *
 * 为什么要它：Taro.request 的 `timeout` 选项在 H5 适配器（和部分小程序环境）
 * 下并不可靠——一旦底层请求卡住，promise 会一直 pending，调用方永远等不到
 * 结果，上层既拿不到数据也进不了 catch，表现就是「点了没反应 / 卡住」。
 * 这里用 Promise.race 兜底：无论底层多不靠谱，都会在 `ms` 后 reject，
 * 让上层（如随机一道）能给出「抽不出来」之类的反馈，而不是永远卡死。
 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new NetworkError(`${label} 超时（${ms}ms）`));
    }, ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** 底层请求：不发 token、不重试。只给登录/刷新与 request 内部用。 */
async function rawRequest<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  options: RequestOptions = {},
  inner: { auth?: boolean } = {},
): Promise<T> {
  const useAuth = inner.auth ?? options.auth ?? true;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Timezone-Offset': tzOffset(),
    ...options.headers,
  };
  if (useAuth) {
    const cur = loadTokens();
    if (cur?.accessToken) headers.Authorization = `Bearer ${cur.accessToken}`;
  }

  let res: Taro.request.SuccessCallbackResult<unknown>;
  try {
    /* withTimeout 兜底：即使底层 request 不遵守 timeout（H5 适配器已知问题），
       也不会让调用方永远 pending —— 超时后转成 NetworkError 进入统一错误处理。 */
    res = await withTimeout(
      Taro.request({
        url: buildUrl(path, options.query),
        method,
        data: options.body as Record<string, unknown> | undefined,
        header: headers,
        timeout: options.timeout ?? API_TIMEOUT,
        dataType: 'json',
      }),
      options.timeout ?? API_TIMEOUT,
      `${method} ${path}`,
    );
  } catch (e: unknown) {
    const msg = String((e as { errMsg?: string })?.errMsg || e || '网络请求失败');
    throw new NetworkError(msg);
  }

  const status = res.statusCode;
  const data = res.data as { error?: { code?: string; message?: string; fields?: Record<string, string> } };

  /* 空体成功响应要做短路（P1-6）：204/205/304 按 HTTP 语义没有 body。
     微信小程序适配器对空体做 JSON 解析时会 reject（空串 "" 或解析失败），
     走到上方 catch 被包成 NetworkError —— 于是 DELETE 会"看起来失败、其实已删"，
     触发 store 的乐观回滚，墙上卡片复活、服务端已软删，再删又报错的死循环。
     H5 适配器本就对 204 走 resolve(null)，这里统一短路，两条环境都安全。 */
  if (status === 204 || status === 205 || status === 304) return null as T;

  if (status >= 200 && status < 300) return data as T;

  const code = data?.error?.code || `HTTP_${status}`;
  const message = data?.error?.message || `请求失败（${status}）`;
  /* 429 要带上 Retry-After：前端据此退避，而不是让用户不停重试把限流打得更死 */
  const retryAfter = Number(res.header?.['Retry-After'] ?? res.header?.['retry-after'] ?? '');
  throw new ApiError(
    status,
    code,
    message,
    data?.error?.fields,
    Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
  );
}

/** 业务请求：自动保证会话；401 时刷新一次并重放一次。 */
export async function request<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const needAuth = options.auth !== false;
  if (needAuth) await ensureSession();

  try {
    return await rawRequest<T>(method, path, options);
  } catch (e) {
    if (!(e instanceof ApiError) || e.status !== 401) throw e;

    /* 401 有两种：token 过期（能刷新）和 token 被服务端判废
       （换后端/清库/重启 mock 都会这样）。两种情况都必须自愈：
       先试刷新，失败就**清掉会话强制重新登录**，再重放一次。
       之前少了「清会话」这步：旧 token 一直在 storage 里，
       ensureSession 看到有值就直接用，于是永远 401、页面永远空。 */
    const failedToken = loadTokens()?.accessToken;
    const refreshed = await refreshTokens();
    if (!refreshed) {
      /* ⚠ 只在「存的还是我这次用的那个 token」时才清会话。
         并发 401 时，refreshTokens() 内部已经有一次「赢家已存新 token」的判断；
         这里再判一次，是为了覆盖「刷新失败 → 重新登录成功 → 别人又拿到了新 token」
         的交错：那时把会话清掉会抹掉有效的登录态，白白再触发一次登录
         （登录限流 10/min，每多一次就多一分 429 的风险）。 */
      if (loadTokens()?.accessToken === failedToken) saveTokens(null);
      await ensureSession();
    }
    try {
      return await rawRequest<T>(method, path, options);
    } catch (e2) {
      if (e2 instanceof ApiError && e2.status === 401) {
        /* 二次 401：会话确实救不回来，清掉让用户重进（页面会显示错误态） */
        saveTokens(null);
      }
      throw e2;
    }
  }
}

/** 一次上传尝试：发出去、把 body 归一、按状态码返回或抛错。 */
async function uploadOnce<T>(
  path: string,
  filePath: string,
  formData: Record<string, string>,
): Promise<T> {
  const cur = loadTokens();
  let res: Taro.uploadFile.SuccessCallbackResult;
  try {
    res = await withTimeout(
      Taro.uploadFile({
        url: buildUrl(path),
        filePath,
        name: PHOTO_UPLOAD_FIELD,
        formData,
        header: {
          Authorization: cur ? `Bearer ${cur.accessToken}` : '',
          'X-Timezone-Offset': tzOffset(),
        },
      }),
      API_TIMEOUT * 3, // 上传比 JSON 慢得多（弱网上传 10MB 很常见），给 3 倍
      `UPLOAD ${path}`,
    );
  } catch (e: unknown) {
    const msg = String((e as { errMsg?: string })?.errMsg || e || '上传失败');
    throw new NetworkError(msg);
  }

  const status = res.statusCode;
  let body: unknown = res.data;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      /* 保留原文，下面按失败处理 */
    }
  }
  if (status >= 200 && status < 300) return body as T;

  const err = (body as { error?: { code?: string; message?: string; fields?: Record<string, string> } })
    ?.error;
  throw new ApiError(status, err?.code || `HTTP_${status}`, err?.message || '上传失败', err?.fields);
}

/**
 * 上传文件（multipart）：单独走 Taro.uploadFile，不经过 JSON 通道。
 *
 * 与 `request()` 保持**同一套 401 自愈语义**（以前这里是缺口）：
 * token 过期/被判废时，JSON 请求能刷新重放，而上传直接抛 ApiError →
 * compose 页把它当"照片没传上去"降级成无图记录，用户以为成功了。
 * 现在：401 → 刷新（失败则清会话重登）→ **只重放一次**；二次 401 才清会话抛出。
 *
 * 顺带补了超时：`Taro.uploadFile` 没有 timeout 选项，弱网下会一直转圈，
 * 用户既不能取消也拿不到失败反馈（compose 的 submitting 卡死）。
 */
export async function upload<T>(
  path: string,
  filePath: string,
  formData: Record<string, string> = {},
): Promise<T> {
  await ensureSession();
  try {
    return await uploadOnce<T>(path, filePath, formData);
  } catch (e) {
    if (!(e instanceof ApiError) || e.status !== 401) throw e;

    /* 与 request() 的 401 处理逐字对齐：先刷新；刷新不出来就清会话强制重登。
       同样只在「存的还是我这次用的那个 token」时才清 —— 否则会把并发赢家
       刚拿到的新 token 抹掉，白白多触发一次登录（登录限流 10/min）。 */
    const failedToken = loadTokens()?.accessToken;
    const refreshed = await refreshTokens();
    if (!refreshed) {
      if (loadTokens()?.accessToken === failedToken) saveTokens(null);
      await ensureSession();
    }
    try {
      return await uploadOnce<T>(path, filePath, formData);
    } catch (e2) {
      if (e2 instanceof ApiError && e2.status === 401) {
        /* 二次 401：会话确实救不回来，清掉让用户重进 */
        saveTokens(null);
      }
      throw e2;
    }
  }
}

/**
 * 把任意异常变成一句能给用户看的话（页面 toast 用）。
 *
 *  ⚠ 为什么 422 要单独处理：服务端的校验错误带**逐字段**文案
 *  （`fields.eat` = 「吃了什么最多 60 个字」、`fields.photoIds` =
 *  「最多 5 张照片」…），那才是用户真正需要看到的话。
 *  以前这里直接落到 `e.message`，而服务端的 message 是笼统的
 *  「字段校验失败」—— 用户既不知道是哪一项、也不知道超了多少，
 *  只能猜。现在把 fields 里第一条文案提到前面。
 */
export function errorText(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === 'NOT_FOUND') return '这一条已经不在了';
    /* 410：撤销窗口已过（GONE）。删除撤销、分享链接过期等用得到，
       必须明确告诉用户"没救了"，沉默会让人以为操作成功了。 */
    if (e.code === 'GONE') return '这一步已经超时了，没法再撤销';
    /* 409：乐观锁冲突（If-Match 版本对不上）。说明编辑期间这条记录被人改过，
       我们的版本过期了 —— 提示拉最新再改，而不是静默覆盖或报「操作失败」。 */
    if (e.code === 'CONFLICT') return '这条记录刚被改过，请退回重新打开再保存';
    /* 409：照片仍被某条记录引用（删照片前的依赖校验）。提示先去解引用。 */
    if (e.code === 'PHOTO_IN_USE') return '这张照片还有记录在用，先删掉那条记录';
    if (e.code === 'IMAGE_REJECTED') return '这张图没过审核，换一张吧';
    if (e.code === 'UNSUPPORTED_MEDIA_TYPE') return '只支持 jpeg / png / webp 格式的图片';
    if (e.code === 'FILE_TOO_LARGE') return '照片太大了，换一张';
    if (e.code === 'RATE_LIMITED') {
      /* 限流要说清「等多久」：笼统的「稍后再试」会让人立刻再点，
         而再点只是再吃一次 429 —— 看起来就像"点了没反应"。 */
      const wait = e.retryAfter ? Math.max(1, Math.ceil(e.retryAfter)) : 0;
      return wait ? `操作太频繁，${wait} 秒后再试` : '操作太频繁，稍后再试';
    }
    /* 422：优先给逐字段文案（合约 §3.3：422 → 字段级标红） */
    if (e.code === 'VALIDATION_FAILED') {
      const detail = firstFieldMessage(e.fields);
      if (detail) return detail;
    }
    /* 任何带 fields 的错误（写记录、传照片校验等）都优先把字段文案顶上来（P2-5）：
       fields 的值是服务端给的中文文案，比笼统的 e.message 更有用。 */
    const fieldDetail = firstFieldMessage(e.fields);
    if (fieldDetail) return fieldDetail;
    return e.message || '操作失败';
  }
  if (e instanceof NetworkError) return '网络不太好，稍后再试';
  return '出了点问题，稍后再试';
}

/**
 * 取 fields 里第一条给用户看的文案。
 *
 *  为什么只取一条：toast 放不下多行，报「菜名和店名都超长了」反而
 *  更难懂。表单页会自己列出全部出问题的字段（行内红字），
 *  toast 这里只负责把用户引到第一个问题上。
 *
 *  ⚠ fields 的键名是服务端给的（eat / shop / photoIds…），
 *  值才是中文文案 —— 不能拿键当文案显示。
 */
export function firstFieldMessage(fields?: Record<string, string>): string {
  if (!fields) return '';
  for (const key of Object.keys(fields)) {
    const msg = fields[key];
    if (msg) return msg;
  }
  return '';
}

/**
 * 取错误里携带的逐字段文案（P2-5）。
 *
 * 表单页用它在出问题的字段下**行内显示红字**（不止 toast 一条笼统提示）：
 * 422 / 写记录 / 传照片校验失败都会带 `fields`，键是字段名、值是中文文案。
 * 非 ApiError 或没 fields 时返回空对象（上层按「没有逐字段错误」处理）。
 */
export function getErrorFields(e: unknown): Record<string, string> {
  if (e instanceof ApiError && e.fields) return e.fields;
  return {};
}
