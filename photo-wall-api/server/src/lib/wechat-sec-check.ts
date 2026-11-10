/**
 * 微信内容安全（图片审核）。
 *
 * ---------- 接口选择：为什么用同步的 img_sec_check ----------
 * 微信有两代内容安全能力：
 *   1. `wxa/img_sec_check`（同步）：直接返回 errcode，**图片上限 1MB**。
 *      已从官方文档目录移除（内容安全页现在只列 msgSecCheck / mediaCheckAsync），
 *      但接口**仍可调用**（实测返回凭据错误而非"接口不存在"）。
 *   2. `wxa/media_check_async`（异步）：支持更大文件，但立即返回 `trace_id`，
 *      审核结果**靠微信回调**推给你。
 *
 * 选同步版的理由：
 *   · 前端上传前已用 `Taro.compressImage({quality:72})` 压过（见
 *     `ui-taro/src/utils/photo.ts`），手机原图 2~8MB 压后典型 200~600KB，
 *     本来就在 1MB 窗口内；
 *   · 异步版要额外实现：公网回调端点 + 验签 + trace_id 关联 +
 *     "审核未回前图片算什么状态"的状态机。为 1MB 这条边引入一整套
 *     回调基础设施，不划算；
 *   · 真超 1MB 时**拒绝并提示压缩**（fail-closed），比放行安全，
 *     且实际触发概率很低。
 *
 * 如果将来产品真的需要支持大图直传（比如 App 端相册批量导入原图），
 * 再评估异步版 —— 那时需要的不只是换个接口，而是一套回调编排。
 *
 * ---------- 其它设计取舍 ----------
 *   · **失败即拒绝（fail-closed）**：微信不可达/超时/限流一律按不通过处理。
 *     违规图一旦入库就删不干净，宁可直接告诉用户换一张，也别赌这次调用
 *     恰好是网络问题。
 *   · access_token 进程内缓存、提前 5 分钟过期、并发串行化 ——
 *     微信有频率限制，且并发换 token 会互相踢掉。
 */
import type { Config } from '../config.js';

/** 图片违规（用户在微信后台可申诉的那类） */
export const ERR_IMAGE_RISKY = 87014;
/** access_token 失效 */
const ERR_TOKEN_INVALID = 40001;
/** 微信同步审核的图片上限 1MB */
const IMG_SEC_CHECK_MAX = 1024 * 1024;

interface TokenCache {
  token: string;
  expiresAt: number;
}

interface SecCheckResult {
  /** true = 通过；false = 判定违规 */
  approved: boolean;
  /** 微信原始 errcode，便于日志与测试断言 */
  errcode: number;
  /** 给用户看的失败原因（只在 approved=false 时有意义） */
  reason?: string;
}

export class WechatSecCheck {
  private cache: TokenCache | null = null;
  /** 并发换 token 会互相踢掉，这里串行化 */
  private tokenTask: Promise<string> | null = null;

  constructor(private readonly cfg: Config) {}

  /** 是否具备调用条件（开了开关，且有凭据） */
  private get usable(): boolean {
    return this.cfg.imageCheck.enabled && !!this.cfg.wechat.appId && !!this.cfg.wechat.secret;
  }

  /**
   * 审核一张图。
   * @returns approved=true 只有在微信明确回 errcode=0 时才成立（fail-closed）。
   */
  async check(buf: Buffer, mime: string): Promise<SecCheckResult> {
    if (!this.usable) {
      /* 没开开关：明确放行，不加戏（本地联调不该被拦） */
      return { approved: true, errcode: 0 };
    }

    if (buf.length > IMG_SEC_CHECK_MAX) {
      /* 同步接口吃不下 >1MB。
         选择"明确拒绝"而不是"放行"：放行等于大图可以完全绕过审核。
         也不是"悄悄降质重试"——那会让用户以为传的是原图。
         正常路径下这条分支不该被触发（前端已 compressImage 压到 200~600KB）。 */
      return {
        approved: false,
        errcode: -1,
        reason: `图片超过 ${IMG_SEC_CHECK_MAX / 1024}KB，无法完成内容审核，请压缩后再传`,
      };
    }

    try {
      const token = await this.accessToken();
      const form = new FormData();
      form.append('media', new Blob([new Uint8Array(buf)], { type: mime }), 'image');
      const res = await fetch(
        `https://api.weixin.qq.com/wxa/img_sec_check?access_token=${encodeURIComponent(token)}`,
        { method: 'POST', body: form, signal: AbortSignal.timeout(8000) },
      );
      if (!res.ok) {
        /* 网络层异常：fail-closed */
        return {
          approved: false,
          errcode: -1,
          reason: `内容审核服务不可用（HTTP ${res.status}），请稍后再试`,
        };
      }
      const data = (await res.json()) as { errcode?: number; errmsg?: string };
      const errcode = data.errcode ?? -1;

      if (errcode === 0) return { approved: true, errcode };
      if (errcode === ERR_IMAGE_RISKY) {
        return { approved: false, errcode, reason: '这张图没过内容审核，换一张吧' };
      }
      if (errcode === ERR_TOKEN_INVALID) {
        /* token 被别处刷新了：清缓存重试一次，仍失败则 fail-closed */
        this.cache = null;
        return { approved: false, errcode, reason: '内容审核暂时不可用，请稍后再试' };
      }
      return {
        approved: false,
        errcode,
        reason: `内容审核未通过（${errcode} ${data.errmsg ?? ''}）`,
      };
    } catch (e) {
      /* 超时 / DNS / JSON 解析：fail-closed */
      const msg = e instanceof Error ? e.message : String(e);
      return { approved: false, errcode: -1, reason: `内容审核请求失败：${msg}` };
    }
  }

  /** 拿 access_token（进程内缓存，提前 5 分钟过期） */
  private async accessToken(): Promise<string> {
    if (this.cache && Date.now() < this.cache.expiresAt) return this.cache.token;
    if (this.tokenTask) return this.tokenTask;

    this.tokenTask = (async () => {
      const url = new URL('https://api.weixin.qq.com/cgi-bin/token');
      url.searchParams.set('grant_type', 'client_credential');
      url.searchParams.set('appid', this.cfg.wechat.appId as string);
      url.searchParams.set('secret', this.cfg.wechat.secret as string);
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error(`获取 access_token 失败（HTTP ${res.status}）`);
      const data = (await res.json()) as {
        access_token?: string;
        expires_in?: number;
        errcode?: number;
        errmsg?: string;
      };
      if (!data.access_token) {
        throw new Error(
          `获取 access_token 失败（${data.errcode ?? '?'} ${data.errmsg ?? ''}）`,
        );
      }
      const ttl = (data.expires_in ?? 7200) * 1000;
      /* 提前 5 分钟过期，避免边界上刚好失效 */
      this.cache = { token: data.access_token, expiresAt: Date.now() + Math.max(60_000, ttl - 300_000) };
      return data.access_token;
    })().finally(() => {
      this.tokenTask = null;
    });

    return this.tokenTask;
  }
}
