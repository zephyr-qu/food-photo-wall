/* ================================================================
   详情页：一道菜

   这页是「一张照片 + 它的说明」。照片按原始比例完整显示，不裁切 ——
   用户点进来看的就是这一张，裁掉任何一边都不合适。
   所以画框高度跟着片子的长宽比走，而不是钉死 4:5。

   深色底是刻意的：照片在深底上更亮，说明文字退到次要位置。

   ---------- 接后端后 ----------
   记录改为按 id 请求（GET /records/{id}），因此有三种状态：
   加载中（深色骨架）/ 404（「这一条已经不在了」）/ 网络失败（可重试）。
   以前从本地数组 find，永远同步、永远有值，这三种状态根本不存在。
   ================================================================ */
import React, { useEffect, useRef, useState } from 'react';
import { View, Text, Image, Swiper, SwiperItem } from '@tarojs/components';
import Taro, { useRouter, useDidShow } from '@tarojs/taro';

import {
  deleteRecord,
  undoDelete,
  fetchRecord,
  fetchSharedRecord,
  writeErrorText,
} from '../../data/store';
import { photoOf, photosOf, joinBits, dateOf, timeOf, placeOf } from '@photo-wall/core';
import type { FoodRecord } from '@photo-wall/core';
import RatingDots from '../../components/RatingDots';
import EmptyState from '../../components/EmptyState';
import { previewPhoto } from '../../utils/taro';
import { goCompose, goShop } from '../../utils/router';
import { resolveAssetUrl } from '../../utils/asset';
import { openShare } from '../../api';
import { buildRecordShare } from '../../utils/share';
import { errorText } from '../../api/client';

import './index.scss';

/** 撤销窗口（毫秒）：与原型一致 5 秒 */
const UNDO_WINDOW_MS = 5000;

/**
 * 当前详情页的"分享上下文"（模块级，供 onShareAppMessage 读取）。
 *
 * 为什么不用组件内的 ref：`onShareAppMessage` 挂在页面实例上（Taro 把组件的
 * 静态属性搬过去），作用域里没有组件实例。渲染时写进这个对象即可。
 */
const currentDetail: {
  id: string;
  eat: string;
  /** FoodRecord.photo 是 `string | null | undefined`（可选字段），这里原样保留 */
  photo: string | null | undefined;
  isSharedView: boolean;
} = { id: '', eat: '', photo: null, isSharedView: false };

/**
 * 已申请的分享令牌，按记录 id 记忆（而非模块级单值）。
 *
 * 之前 shareToken 是 currentDetail 上的单值字段：A 分享过一次后，打开 B 详情页
 * 不会重置它，于是 B 的分享链接里塞的是 A 的 token，对方打开必 404（后端按 token
 * 校验记录归属）。改成「id → token」的 Map 后，每条记录的令牌互不串用。
 */
const shareTokens = new Map<string, string>();

/**
 * 两种来源合成一个 hook：正常（需登录）或分享落地（免登录 + token）。
 *
 * 为什么不在详情页里写两个分支：状态机（loading/ready/error/404）与重试逻辑
 * 完全一致，只有"用哪个接口"这一行不同。
 */
function useShareAwareRecord(
  id: string,
  shareToken: string | null,
): { record: FoodRecord | null; status: 'loading' | 'ready' | 'error'; error: string | null; reload: () => void } {
  const [record, setRecord] = useState<FoodRecord | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!id) {
      setStatus('ready');
      return;
    }
    let alive = true;
    setStatus('loading');
    const task = shareToken ? fetchSharedRecord(id, shareToken) : fetchRecord(id);
    task
      .then((rec) => {
        if (!alive) return;
        setRecord(rec);
        setStatus('ready');
        setError(null);
      })
      .catch((e) => {
        if (!alive) return;
        setRecord(null);
        setStatus('error');
        setError(errorText(e));
      });
    return () => {
      alive = false;
    };
  }, [id, shareToken, tick]);

  return { record, status, error, reload: () => setTick((n) => n + 1) };
}

export default function DetailPage() {
  const router = useRouter();
  const id = router.params.id || '';
  /** 分享落地模式：路径带 `share=<token>`，说明对方是从卡片点进来的 */
  const shareToken = router.params.share || null;
  const isSharedView = !!shareToken;

  /* 两种数据来源：
     · sharedView → 免登录走 /share/records/{id}?token=（落地页）；
     · 正常 → 走自己的 /records/{id}（需登录）。 */
  const { record, status, error, reload } = useShareAwareRecord(id, shareToken);
  const [deleting, setDeleting] = useState(false);
  /** 底部「已删除 · 撤销」条是否显示 */
  const [undoVisible, setUndoVisible] = useState(false);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 多图时当前选中的是第几张（Swiper 受控 current + 底部圆点高亮） */
  const [slideIndex, setSlideIndex] = useState(0);

  /* 把当前记录写进模块级分享上下文（onShareAppMessage 读它）。
     每帧都写、且 record 为 null 时清空：否则加载中/加载失败/404 时点「转发」，
     读到的是上一条记录的 id/eat（P0-2 修复后的残留窄口，A9）。 */
  currentDetail.id = record?.id ?? '';
  currentDetail.eat = record?.eat ?? '';
  currentDetail.photo = record?.photo ?? null;
  currentDetail.isSharedView = isSharedView;
  /* 分享令牌统一放模块级 `shareTokens` Map（见文件顶部：按 id 复用，
     onShareAppMessage 回调里读），这里不再另存 ref。 */

  /* 离开页面时清掉定时器，避免回调打到已卸载的组件。
     ⚠ 必须放在所有早退 return **之前**：React 要求每次渲染的 hook 顺序一致，
     放在 `if (!record) return` 之后会让后续渲染少一个 hook，整页渲染成空。 */
  useEffect(() => {
    return () => {
      if (undoTimer.current) clearTimeout(undoTimer.current);
    };
  }, []);

  /* 回到前台（从编辑页返回、或切后台再回来）时重新拉一次。
     详情页在 navigateTo(compose) 后不会销毁，record 是旧 useState 快照，
     不重拉的话「保存成功」后看到的仍是编辑前的菜名/照片/评分（P1-1）。
     首次 show 由 useShareAwareRecord 的 effect 负责，这里跳过避免重复请求。
     ⚠ 必须放在所有早退 return 之前，保持 hook 顺序稳定。 */
  const firstShowRef = useRef(true);
  useDidShow(() => {
    if (firstShowRef.current) {
      firstShowRef.current = false;
      return;
    }
    reload();
  });

  if (status === 'loading' && !record) {
    return (
      <View className="dp dp--empty">
        <View className="dp__skeleton" />
      </View>
    );
  }

  if (!record) {
    /* 区分「记录真的没了」和「网络失败」—— 以前只有前者一种文案，
       把网络问题也显示成"已经不在了"会误导用户以为数据丢了。 */
    const isMissing = !error || /已经不在了|NOT_FOUND/.test(error);
    return (
      <View className="dp dp--empty">
        {isMissing ? (
          <EmptyState text="这一条已经不在了" theme="dark" />
        ) : (
          <View className="dp__fail">
            <Text className="dp__fail-t">{error || '加载失败'}</Text>
            <View className="dp__fail-btn" onClick={reload}>
              <Text>重试</Text>
            </View>
          </View>
        )}
      </View>
    );
  }

  /** 只在「详情页仍是栈顶」时才返回。
   *
   * 删除后的 5s 定时器、撤销失败的 800ms 定时器都挂在时间上：这期间用户可能
   * 已经点了「这家店/编辑」进了别的页。无条件 `navigateBack()` 会把**当前页**
   * 弹掉，用户看到的就是"页面自己跳走了"（A2）。 */
  const navigateBackIfStillTop = (): void => {
    const pages = Taro.getCurrentPages?.() || [];
    const top = pages[pages.length - 1] as { route?: string } | undefined;
    if (pages.length > 1 && top?.route && top.route.includes('pages/detail/index')) {
      Taro.navigateBack();
    }
  };

  const onEdit = () => {
    if (deleting || undoVisible) return;
    goCompose(record.id);
  };

  const onShop = () => {
    if (deleting || undoVisible) return;
    /* 带上城市：同名连锁店（海底捞·成都/重庆）才不会把两城的记录混成一家（A5） */
    goShop(record.shop || '', record.city);
  };

  const onPreview = () => {
    /* 多图时预览**当前选中**的那张，不是第一张；编辑删图后 slideIndex 可能越界 */
    const list = photosOf(record).map(resolveAssetUrl);
    const index = Math.min(slideIndex, Math.max(0, list.length - 1));
    previewPhoto(list[index] || resolveAssetUrl(photoOf(record)));
  };

  /**
   * 删除：**无二次确认 + 5 秒撤销**（对齐原型，而非"先拦你一道"）。
   *
   * 流程：
   *   1. 立即软删并从墙上移除（乐观，用户马上看到结果）；
   *   2. 底部弹「已删除 · 撤销」，5 秒后自动消失；
   *   3. 点了撤销 → restore，记录回到原时间位置（服务端保证，不是排到最前）；
   *   4. 超时/离开页面 → 什么都不做（软删记录 30 天后由后台回收）。
   *
   * 为什么不用 showModal 确认：删除在这个产品里是低频且可恢复的操作，
   * 用确认框把成本压在每次删除上，而撤销只在真删错时才付出 —— 后者更省事。
   * 后端已实现软删 + restore（含 410 超窗），这条链路才成立。
   */
  const onDelete = async () => {
    if (deleting) return;
    setDeleting(true);
    try {
      await deleteRecord(record.id);
      /* 注意：软删期间照片必须留着（还要 restore），不能在这里 discard。
         真正的回收交给服务端在超过撤销窗口后做。 */
      showUndoBar();
    } catch (e) {
      setDeleting(false);
      /* 离线删除会被 store 拒绝，这里的文案要能说清"不是你的错" */
      Taro.showToast({ title: writeErrorText(e), icon: 'none', duration: 2200 });
    }
  };

  /** 底部「已删除 · 撤销」条：5 秒后自动收起并返回上一页 */
  const showUndoBar = () => {
    setUndoVisible(true);
    if (undoTimer.current) clearTimeout(undoTimer.current);
    undoTimer.current = setTimeout(() => {
      setUndoVisible(false);
      /* 撤销窗口过了：这时才离开详情页（记录已不在，留着没意义）。
         用户可能已经在别的页面，只在仍是栈顶时返回。 */
      navigateBackIfStillTop();
    }, UNDO_WINDOW_MS);
  };

  /** 点「撤销」：把记录恢复回来 */
  const onUndo = async () => {
    if (undoTimer.current) clearTimeout(undoTimer.current);
    setUndoVisible(false);
    try {
      await undoDelete(record.id);
      Taro.showToast({ title: '已恢复', icon: 'none', duration: 1200 });
      /* 恢复成功后详情页仍然有效（记录回来了），不用导航 */
      setDeleting(false);
    } catch (e) {
      /* 410 GONE = 超过撤销窗口，必须明确说清（沉默会让人以为恢复成功了） */
      const apiErr = e as { code?: string; status?: number };
      const gone = apiErr?.code === 'GONE' || apiErr?.status === 410;
      Taro.showToast({
        title: gone ? '超过撤销期限，已经恢复不了了' : writeErrorText(e),
        icon: 'none',
        duration: 2400,
      });
      /* 存进同一个 timer ref：卸载/手动返回时会被清掉，且只在仍是栈顶时返回 */
      if (undoTimer.current) clearTimeout(undoTimer.current);
      undoTimer.current = setTimeout(() => navigateBackIfStillTop(), 800);
    }
  };

  /* 时间与地点：只在有内容时才分段，避免出现空段。
     日期/时刻一律走 records.ts 的 dateOf/timeOf，不要在这里手写 slice ——
     格式一旦变，散落的手写逻辑就会漏改。 */
  const meta = joinBits([
    record.shop,
    placeOf(record),
    `${dateOf(record.at)} ${timeOf(record.at)}`,
  ]);

  /* 全部照片（有序）。photosOf 在没有自定义照片时回落成 1 张预置图，
     所以这个数组永远至少 1 个元素 —— 单图路径不需要额外分支。 */
  const photos = photosOf(record).map(resolveAssetUrl);
  const multi = photos.length > 1;
  /* 编辑时删过照片后，slideIndex 可能比照片数大 —— 夹回合法区间，
     否则 Swiper current 越界、底部圆点一个都不高亮。 */
  const safeIndex = Math.min(slideIndex, Math.max(0, photos.length - 1));

  return (
    <View className="dp">
      {/* 顶部条：日期戳。小程序的返回交给原生导航栏（深色 nav +
          navigationBarTextStyle: white，箭头是白的）—— 原型是浮层才自带 ×，
          小程序有原生返回，再画一个是重复控件；H5 没有原生导航，
          按原型保留 ×。 */}
      <View className="dp__bar">
        {process.env.TARO_ENV !== 'weapp' && (
          <View className="dp__close" onClick={() => Taro.navigateBack()}>
            <Text>×</Text>
          </View>
        )}
        <Text className="dp__stamp">
          {dateOf(record.at)} {timeOf(record.at)}
        </Text>
      </View>

      {/* 照片：固定 4:5 画框，照片按原比例完整显示（aspectFit），空出的边留深底。
          不铺满整屏的原因：照片长宽比各不相同，铺满必然裁掉一块 ——
          用户点进来看自己拍的这张，裁掉任何一边都不合适。

          多张时换成 Swiper 让用户左右滑着切（自绘底部圆点，不用地上的指示点）。 */}
      <View className="dp__shot" onClick={onPreview}>
        <View className="dp__frame">
          {multi ? (
            <>
              {/* Swiper 内部是 absolute 布局，必须有确定高度；
                  所以它绝对定位铺在 .dp__frame 撑出来的 4:5 画框里。 */}
              <Swiper
                className="dp__swiper"
                indicatorDots={false}
                current={safeIndex}
                onChange={(e) => setSlideIndex(e.detail.current)}
              >
                {photos.map((src, i) => (
                  <SwiperItem key={`${i}-${src}`} className="dp__slide">
                    <Image className="dp__img" src={src} mode="aspectFit" />
                  </SwiperItem>
                ))}
              </Swiper>
              {/* 自绘圆点：当前项高亮。放画框底部，避免和 .dp__img 抢位置 */}
              <View className="dp__dots">
                {photos.map((src, i) => (
                  <View
                    key={`${i}-${src}`}
                    className={'dp__dot' + (i === safeIndex ? ' dp__dot--on' : '')}
                  />
                ))}
              </View>
            </>
          ) : (
            <Image className="dp__img" src={photos[0]} mode="aspectFit" />
          )}
        </View>
      </View>

      <View className="dp__body">
        <Text className="dp__name">{record.eat}</Text>
        <Text className="dp__meta">{meta}</Text>

        {/* 备注：没有备注时也给一句话，避免这一块凭空消失、版面塌掉。
            原型 photo-wall-h5 就是这么处理的（"没有留下备注。"）。 */}
        <Text className={`dp__note${record.note ? '' : ' dp__note--empty'}`}>
          {record.note || '没有留下备注。'}
        </Text>

        {/* 评分 + 操作同一行：左边评分、右边按钮，和原型一致。
            6 分以上才显示评分的旧逻辑保留（rating>0）。 */}
        <View className="dp__row">
          {record.rating > 0 ? (
            <View className="dp__rate">
              <RatingDots value={record.rating} size="sm" theme="dark" />
              <Text className="dp__score">{record.rating} 分</Text>
            </View>
          ) : (
            <View className="dp__rate">
              <Text className="dp__score">未评</Text>
            </View>
          )}

          <View className="dp__acts">
            {/* 有店名才给「这家店」入口 —— 没有店名时这条没意义。
                分享落地页不给：`/shops/by-name` 按浏览者自己的账号过滤，
                访客点进去只会看到「这家店还没有记录」，还会被静默建档登录（A8）。
                删除/撤销条展示期间也收掉：此时记录已在服务端软删，再点只会 404（A2）。 */}
            {record.shop && !isSharedView && !undoVisible ? (
              <View className="btn btn--quiet dp__act" onClick={onShop}>
                <Text>这家店</Text>
              </View>
            ) : null}
            {/* 编辑/删除只在**自己的**详情页出现。
                分享落地页是别人的记录（且未登录），给按钮只会点出 401/404。 */}
            {!isSharedView && !undoVisible ? (
              <>
                <View className="btn btn--quiet dp__act" onClick={onEdit}>
                  <Text>编辑</Text>
                </View>
                <View className="btn btn--quiet dp__act dp__act--danger" onClick={onDelete}>
                  <Text>{deleting ? '删除中…' : '删除'}</Text>
                </View>
              </>
            ) : null}
          </View>
        </View>
      </View>

      {/* 删除后的「撤销」条：5 秒内点一下就能恢复。
          刻意做成底部细条而不是 modal：不打断浏览，也不逼用户做决定。 */}
      {undoVisible ? (
        <View className="undo">
          <Text className="undo__t">已删除</Text>
          <View className="undo__btn" onClick={onUndo}>
            <Text>撤销</Text>
          </View>
        </View>
      ) : null}
    </View>
  );
}

/* 单条记录转发：**必须是具名函数表达式**，Taro 的 babel 插件靠它识别页面
   要不要生成 onShareAppMessage（与 wall 页的 onShareTimeline 同一条规则，
   见 pages/wall/index.tsx 末尾注释）。

   为什么用模块级变量而不是组件内的 ref：onShareAppMessage 是挂在**页面实例**
   上的静态属性，作用域里拿不到某个组件实例的 state/ref。所以渲染时把当前
   记录的三个字段写进模块变量，分享时读它。

   为什么"点分享时才申请 token"而不是加载就申请：大多数看详情的人不分享，
   提前申请等于给每条记录都开一个公开口子。微信允许 onShareAppMessage
   返回 Promise，正好可以在用户触发时再请求。 */
DetailPage.onShareAppMessage = async function onShareAppMessage() {
  const fallback = { title: 'X师傅美食记', path: '/pages/wall/index' };
  const { id, eat, photo } = currentDetail;
  if (!id) return fallback;

  /* 分享落地页（别人转给我的）不应该再转出去 —— 那是在传别人的链接 */
  if (currentDetail.isSharedView) return fallback;

  try {
    /* 已申请过就复用（后端同样幂等，这里只省一次往返）。按记录 id 记忆，
       避免换一条记录后复用上一条的 token（否则对方打开会 404）。 */
    const token =
      shareTokens.get(id) ??
      (await withShareTimeout(openShare(id), 2500))?.shareToken;
    if (!token) {
      /* 超时/失败 → 退回首页。绝不能返回一个 path 里没有有效 token 的链接：
         对方打开会落到「这一条已经不在了」，比不分享更伤。 */
      return fallback;
    }
    shareTokens.set(id, token);
    return buildRecordShare(eat, id, token, photo);
  } catch {
    /* 申请失败（离线/未登录）→ 退回分享首页 */
    return fallback;
  }
};

/**
 * 分享 token 申请的超时保护。
 *
 * 为什么需要：`onShareAppMessage` 返回 Promise 时，微信会等它 resolve 再弹
 * 分享面板。真机弱网下这个请求可能拖到 5~8 秒，用户会觉得"点了转发没反应"。
 * 2.5 秒还没回来就放弃，退回分享首页 —— 快一点给出**能用的**卡片，
 * 比慢一点给出**精确的**卡片更重要（用户此刻的意图是"转发"）。
 */
function withShareTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}
