/* ================================================================
   小程序 API 的薄封装

   这里只放「多处重复、且封装后语义更清楚」的调用。
   不做全量包装 —— Taro.* 本身已经够直白，包一层只会多一层间接。

   当前内容：
   · previewPhoto  看大图（3 个页面都用）
   ================================================================ */
import Taro from '@tarojs/taro';

/**
 * 全屏预览一张图。
 *
 * 抽出来的原因：compose / detail / wall 三处调用一字不差，
 * 且都需要「src 为空就别预览」这层判断（原先三处都没做）。
 *
 * @param src 图片地址，可以是包内相对路径或 saveFile 产生的持久路径
 */
export function previewPhoto(src?: string | null): void {
  if (!src) return;
  Taro.previewImage({ current: src, urls: [src] });
}
