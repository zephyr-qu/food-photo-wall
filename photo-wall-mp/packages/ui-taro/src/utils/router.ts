/* ================================================================
   路由封装

   为什么要有这一层：
   页面路径字符串原本散落在多个文件里，改目录结构时容易漏改；
   而且只有一处记得对中文参数做 encodeURIComponent，其余都没做。

   约定：
   · 路径只在这里出现一次
   · 参数统一 encodeURIComponent
   · 对外暴露 goXxx（直接跳）和 routes.xxx（只要 URL 时用）

   ---------- 导航深度保护 ----------
   微信小程序页面栈上限是 10 层。详情页和店铺页之间可以互相跳
   （详情 →「这家店」→ 店铺 → 点一张照片 → 详情 → …），
   来回几次就会触顶，navigateTo 静默失败、按钮像坏了一样。
   做法：跳转前统计栈里已有的同名页面，达到上限时改用 redirectTo
   （替换当前页，不加深栈），语义上也更对 —— 用户是在同一类内容里横向走。
   ================================================================ */
import Taro from '@tarojs/taro';

const enc = encodeURIComponent;

/** 页面栈上限，微信固定 10；留 1 层余量给即将压入的新页 */
const MAX_STACK = 10;

/** 只生成 URL，不跳转。需要自己做 navigateTo 时用这个 */
export const routes = {
  /** 详情页：必须带 id */
  detail: (id: string): string => `/pages/detail/index?id=${enc(id)}`,

  /** 贴一张 / 编辑：带 id 进编辑态，不带是新建 */
  compose: (id?: string): string =>
    id ? `/pages/compose/index?id=${enc(id)}` : '/pages/compose/index',

  /** 店铺页：店名必填（可能含中文和空格）；city 用于同名连锁店消歧 */
  shop: (name: string, city?: string | null): string =>
    `/pages/shop/index?name=${enc(name)}${city ? `&city=${enc(city)}` : ''}`,

  /** 首页 */
  wall: (): string => '/pages/wall/index',
};

/**
 * 安全跳转：栈快满时自动降级为 redirectTo。
 *
 * @param url     目标页（含 query，已 encode）
 * @param options 可指定替换策略
 */
export function navigate(url: string): void {
  const pages = Taro.getCurrentPages?.() || [];
  if (pages.length >= MAX_STACK - 1) {
    /* 栈已接近上限：替换当前页而不是继续压栈 */
    Taro.redirectTo({ url });
    return;
  }
  Taro.navigateTo({ url });
}

/** 打开详情页 */
export function goDetail(id: string): void {
  navigate(routes.detail(id));
}

/** 打开贴一张（传 id 则进编辑态） */
export function goCompose(id?: string): void {
  navigate(routes.compose(id));
}

/** 打开店铺页（city 可选：同名连锁店按城市消歧） */
export function goShop(name: string, city?: string | null): void {
  navigate(routes.shop(name, city));
}

/**
 * 安全解码 query 参数。
 *
 * 页面参数在不同宿主下是否已被解码并不一致（微信原生 onLoad 通常是**已解码**的），
 * 直接再 decodeURIComponent 一次遇到含 `%` 的内容会抛 URIError：
 *   decodeURIComponent('50%折扣') → URIError: URI malformed
 * 整个页面白屏。所以这里解一次失败就原样返回。
 */
export function safeDecode(value: string): string {
  if (!value) return '';
  try {
    return decodeURIComponent(value);
  } catch (e) {
    /* 已经是解码后的字符串（或含裸 %），原样使用 */
    return value;
  }
}
