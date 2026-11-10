/* ================================================================
   本机照片：压缩 + 持久化 + 清理

   为什么需要它：
   · chooseMedia 给的是临时路径，重启即失效 → 必须 saveFile 转持久路径；
   · saveFile 有 10MB 配额 → 先 compressImage 再存，别把原图塞进去；
   · 换图 / 换回默认 / 放弃编辑 / 删记录时，不再被引用的本机文件
     必须清掉，否则配额迟早被孤儿文件吃满。

   上传（POST /photos）不在这里：它属于接口层（src/api），
   本文件只管「本机文件」的生命周期，两者失败策略也不同
   （上传失败可以降级为本地路径继续用，本机文件失败就真的没了）。

   判定「哪个是本机文件」全部走 core 的 photoKind，避免 UI 各写一遍。
   ================================================================ */
import Taro from '@tarojs/taro';
import { isLocalFilePath } from '@photo-wall/core';

import { PHOTO_COMPRESS_QUALITY } from '../config';

const IS_WEAPP = process.env.TARO_ENV === 'weapp';

/** 压缩一张图；失败就退回原图（压缩是优化，不是必需）。H5 不做。 */
async function compress(tempPath: string): Promise<string> {
  if (!IS_WEAPP || typeof Taro.compressImage !== 'function') return tempPath;
  try {
    const res = await Taro.compressImage({
      src: tempPath,
      quality: PHOTO_COMPRESS_QUALITY,
    });
    return res?.tempFilePath || tempPath;
  } catch (e) {
    console.warn('[photo] 压缩失败，用原图', e);
    return tempPath;
  }
}

/**
 * 把 chooseMedia 的临时路径变成「尽量持久」的本机路径。
 * 先压缩再 saveFile：10MB 配额下，原图（几 MB）存不了几张。
 * saveFile 失败时退回压缩后的临时路径（本次会话可用），persisted=false
 * 让调用方决定要不要提示 —— 这里不越权替 UI 决定。
 */
export async function persistPhoto(
  tempPath: string,
): Promise<{ path: string; persisted: boolean }> {
  /* H5 没有 saveFile（`@tarojs/taro-h5` 里是 temporarilyNotSupport），
     chooseMedia 给的临时路径（blob:/data:）本次会话内有效、上传也能用 ——
     直接当成功处理。以前这里 catch 成 persisted=false，导致 H5 每次选图
     都弹「照片未能长期保存」，是 100% 误报（B6）。 */
  if (!IS_WEAPP) return { path: tempPath, persisted: true };
  const compressed = await compress(tempPath);
  try {
    const res = await Taro.saveFile({ tempFilePath: compressed });
    const saved = (res as { savedFilePath?: string }).savedFilePath;
    return { path: saved || compressed, persisted: Boolean(saved) };
  } catch (e) {
    console.warn('[photo] saveFile 失败，本次运行内有效', e);
    return { path: compressed, persisted: false };
  }
}

/** 删掉一个本机文件（包内静态图 / 云 URL 不动）。失败静默——文件可能已被系统清理。 */
export function discardLocalPhoto(path?: string | null): void {
  if (!path || !isLocalFilePath(path)) return;
  Taro.removeSavedFile({ filePath: path }).catch(() => {
    /* 忽略：临时路径本来就不在 saveFile 管理范围内 */
  });
}
