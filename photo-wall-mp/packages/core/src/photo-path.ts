/* ================================================================
   照片地址分类（纯函数）

   为什么单独抽出来：照片字段 `photo` 在历史上同时承载三种东西，
   而且**判断散落在 UI 里**（compose 的清理、detail 的删除各写一遍
   `startsWith('wxfile://') || includes('/temp/')`）。
   一旦「上云」把 https URL 写进同一个字段，这两处就会各自漏判 ——
   于是把判定收成一个有单测的纯函数，UI 只问「这是哪一类」。

   四类：
   · local   —— 本机文件。saveFile 的持久路径（wxfile://...），
                或 chooseMedia 的临时路径（http://tmp/...、/temp/...）；
                这类文件会被系统清理、也只能本机用，删记录时要顺手删文件。
   · remote  —— 公网 URL（后端接管照片后的目标形态）。可直接给 <Image>。
   · package —— 包内静态资源（`/static/img/xxx.jpg`，必须 `/` 开头）。
                跟着版本发布，不可删、跨端可用。
   · none    —— 空值或不认识的形态（相对路径是错的，按 none 处理）。
   ================================================================ */

export type PhotoKind = 'local' | 'remote' | 'package' | 'none';

/** 开发者工具给的临时路径是 `http://tmp/...` —— 看着像 URL，其实是本机临时文件。 */
const DEVTOOLS_TEMP = /^https?:\/\/tmp\//i;
const HTTP = /^https?:\/\//i;

/**
 * 是不是「只在本机存在、可以删」的文件路径。
 *
 * 注意 http://tmp/... 必须算 local：它虽然长成 URL，但换机/重启就没了，
 * 当成 remote 存进记录会得到一条永远 404 的照片。
 */
export function isLocalFilePath(path?: string | null): boolean {
  if (!path) return false;
  if (path.startsWith('wxfile://')) return true;
  if (DEVTOOLS_TEMP.test(path)) return true;
  if (path.startsWith('blob:') || path.startsWith('file://')) return true;
  /* 真机临时目录：.../temp/xxx.jpg；saveFile 失败退化时拿到的就是它 */
  return path.includes('/temp/');
}

/** 公网可访问的 https 图片（云存储 / 后端返回的 URL）。 */
export function isRemoteUrl(path?: string | null): boolean {
  if (!path) return false;
  return HTTP.test(path) && !DEVTOOLS_TEMP.test(path);
}

/** 包内静态资源：必须以 `/` 开头，否则会被当作相对路径解析（详见 core/records.ts）。 */
export function isPackagePath(path?: string | null): boolean {
  if (!path) return false;
  return path.startsWith('/') && !HTTP.test(path);
}

/** 归类。UI 只需要这一个函数就能决定「能不能删 / 要不要上传 / 能不能跨端」。 */
export function photoKind(path?: string | null): PhotoKind {
  if (!path) return 'none';
  if (isLocalFilePath(path)) return 'local';
  if (isRemoteUrl(path)) return 'remote';
  if (isPackagePath(path)) return 'package';
  return 'none';
}
