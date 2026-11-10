/* ================================================================
   选照片：`Taro.chooseMedia` + 持久化 + **失败时每一种原因都要有交代**。

   为什么单独成模块：这段以前是组件里的一个闭包，只吃两个入参
   （还能选几张、上限），却被 `photos.length` 隐式绑住，于是
   "提交期间不能再选图"这类约束只能靠调用方记得先判断。抽出来之后
   入参显式、可测（把 Taro 换成假实现就能验每种 errMsg 的分支），
   组件里只剩"选完塞进 state"。

   ---------- errMsg 分支的由来（都是踩过的） ----------
   · `cancel` —— 用户主动取消，**不是错误**，不能弹提示；
   · `privacy` —— 隐私协议未同意。它和"权限"消息里都含 permission，
     以前被误报成「相册权限」并引导去设置页，用户照做也没用；
   · `auth|authorize|permission|deny` —— 真没授权，引导去设置；
   · 其它 —— 什么都不做会像"按钮坏了"，至少给一句兜底文案。
   ================================================================ */
import Taro from '@tarojs/taro';

import { persistPhoto } from '../../utils/photo';

/**
 * 让用户选照片并持久化。
 *
 * @param selected 已选张数（用来算还能选几张）
 * @param max      上限（契约：至多 5 张）
 * @returns 持久化后的路径列表（按用户选择顺序）；取消 / 失败返回 null
 */
export async function pickPhotos(selected: number, max: number): Promise<string[] | null> {
  let tempPaths: string[];
  try {
    const res = await Taro.chooseMedia({
      /* 还能再选几张 = 上限 - 已选。至少给 1（chooseMedia 的 count 不能为 0） */
      count: Math.max(1, max - selected),
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      sizeType: ['compressed'],
    });
    tempPaths = (res?.tempFiles || [])
      .map((f) => f.tempFilePath)
      .filter(Boolean) as string[];
  } catch (e) {
    /* 用户主动取消不算错误，直接返回。
       其余情况（未授权 / 隐私协议未同意 / 相册不可用）都要给引导，
       否则按钮点了毫无反应。 */
    const msg = String((e as { errMsg?: string })?.errMsg || '');
    if (msg.includes('cancel')) return null;

    /* 隐私协议未同意：用户点了「暂不使用」后，挂起的 chooseMedia 会以
       privacy 错误失败。这时不要误报成「相册权限」（消息里也含 permission），
       提示他再点一次照片并在弹窗里同意即可。 */
    if (/privacy/i.test(msg)) {
      Taro.showToast({
        title: '需要同意隐私指引才能选照片',
        icon: 'none',
        duration: 2400,
      });
      return null;
    }

    const denied = /auth|authorize|permission|deny/i.test(msg);
    if (denied) {
      const { confirm } = await Taro.showModal({
        title: '需要相册权限',
        content: '在设置里允许访问相册后，才能选照片',
        confirmText: '去设置',
      });
      if (confirm) Taro.openSetting();
      return null;
    }

    /* 其他原因：至少告诉用户为什么没动静，别让它像坏按钮 */
    Taro.showToast({
      title: '没能打开相册，请稍后再试',
      icon: 'none',
      duration: 2000,
    });
    return null;
  }
  if (!tempPaths.length) return null;

  /* 逐张持久化：saveFile 有 10MB 配额，压缩失败的那张退回临时路径 */
  const paths: string[] = [];
  let notPersisted = 0;
  for (const temp of tempPaths) {
    const persisted = await persistPhoto(temp);
    if (!persisted.persisted) notPersisted += 1;
    paths.push(persisted.path);
  }
  if (notPersisted > 0) {
    /* saveFile 失败时退回临时路径：本次会话内能看，重启后会失效。
       这比"换张图失败、直接丢掉用户刚选的照片"体验更好，但要提示。 */
    Taro.showToast({ title: '照片未能长期保存', icon: 'none', duration: 2000 });
  }
  return paths;
}
