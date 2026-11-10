/* ================================================================
   右缘月份轴

   原型 photo-wall-h5 的 MonthAxis：贴在墙的右缘，一列月份数字（10/09/08…），
   点一下就跳到那个月；按住上下拖会跟着走，并浮一个「10 月」的提示气泡。

   ---------- 和原型的两个不同 ----------
   1. **数据来自接口**（GET /records/months），不是从已渲染的 sections 推。
      因为墙是分页的：未加载的月份根本不在内存里，只看 sections 会得到
      一条"只有当前几页"的假轴。
   2. **跳转 = 重铺墙**（store.jumpToMonth），不是 scrollTo。同理，
      目标月份的内容还没加载，没法靠滚动到达。

   ---------- 三个状态 ----------
   · 没有月份数据（还没加载 / 空库）→ 不渲染，别占地方；
   · 当前所在月高亮：以墙上第一张的月份为准（跳月后第一张就是目标月）；
   · 拖动中浮气泡，抬手 900ms 后消失（照搬原型）。
   ================================================================ */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text } from '@tarojs/components';
import Taro from '@tarojs/taro';
import type { ITouchEvent } from '@tarojs/components';

import type { ApiMonth } from '../../api/types';

import './index.scss';

const px = (n: number): string => Taro.pxTransform(n);

/**
 * 从 Taro 的 View 事件里取触摸点。
 *
 * 为什么需要它：`ViewProps` 把 onTouchStart/onTouchMove 声明成 `CommonEventFunction`，
 * 参数是 `BaseEventOrig`（**没有** touches 字段），但运行时给的就是 `ITouchEvent`。
 * 直接在 JSX 里写 `(e: ITouchEvent) => ...` 在 `strictFunctionTypes` 下是错的
 * （参数收窄不允许），于是这里收窄一次、三处共用，而不是在 JSX 里打三个断言。
 */
const touchesOf = (e: unknown): ITouchEvent['touches'] => (e as ITouchEvent).touches;

/** 每格高度（rpx）：原型 30px@390 ≈ 58rpx，这里取整 56 */
const CELL_RPX = 56;
/** 轴上最多显示多少个月（再多月轴会顶穿屏幕；多出来的按月截断） */
const MAX_CELLS = 10;

export interface MonthAxisProps {
  /** 月份桶（Store 的 aggregate.months），跟随当前城市筛选 */
  months: ApiMonth[] | null;
  /** 当前所在月（'YYYY-MM'）；通常是墙上第一张的月份 */
  activeMonth: string;
  /** 是否显示（日期分组关闭时不显示 —— 没有月标签，轴就失去参照物） */
  visible: boolean;
  /** 点某月 */
  onJump: (month: string) => void;
}

export default function MonthAxis({ months, activeMonth, visible, onJump }: MonthAxisProps) {
  const [bubble, setBubble] = useState<string | null>(null);
  const bubbleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 轴的屏幕位置（touch 事件的 clientY 是绝对坐标，要减去轴顶才有意义）。
      小程序没有 getBoundingClientRect，用 SelectorQuery 量一次并缓存。 */
  const axisTop = useRef<number | null>(null);
  /** 抬手时要跳的那个月：touchstart/move 记下，touchend 用它。
      用 ref 而不是局部变量 —— 局部变量在每次 render 时重建，
      touch 事件跨 render 时读不到之前写的值。 */
  const pendingMonth = useRef<string | null>(null);
  /** 本次触摸是否发生过拖动：区分"点一下"（交给 onClick）与"拖到某格抬手"（touchend 跳）。
   *  以前 touchend 无条件跳 + onClick 又跳一次 = 每次点月轴发两次跳月请求（A3/旧 P2-14）。 */
  const moved = useRef(false);

  const cells = useMemo(() => (months || []).slice(0, MAX_CELLS), [months]);

  /** 一格在当前屏幕上的实际像素高度。
   *  ⚠ 不能写死 `CELL_RPX / 2`（= 750rpx 恰为 390pt 的假设）：iPhone SE 390pt 以下会
   *  偏慢半格、Pro Max 会偏快半格（旧 P2-13）。按 windowWidth 动态换算。 */
  const cellPx = useMemo(() => {
    try {
      const info =
        typeof Taro.getWindowInfo === 'function' ? Taro.getWindowInfo() : Taro.getSystemInfoSync();
      const w = info?.windowWidth || 375;
      return (CELL_RPX / 750) * w;
    } catch {
      return CELL_RPX / 2;
    }
  }, []);

  useEffect(() => {
    /* 气泡 timer 卸载时清理（否则回调打到已卸载组件；旧 P2-15） */
    return () => {
      if (bubbleTimer.current) clearTimeout(bubbleTimer.current);
    };
  }, []);

  useEffect(() => {
    if (!visible) {
      axisTop.current = null;
      return;
    }
    Taro.createSelectorQuery()
      .select('.axis')
      .boundingClientRect((rect) => {
        const r = rect as { top?: number } | null;
        if (r && typeof r.top === 'number') axisTop.current = r.top;
      })
      .exec();
  }, [visible, cells.length]);

  const showBubble = useCallback((month: string) => {
    setBubble(month);
    if (bubbleTimer.current) clearTimeout(bubbleTimer.current);
    bubbleTimer.current = setTimeout(() => setBubble(null), 900);
  }, []);

  const jump = useCallback(
    (month: string) => {
      showBubble(month);
      onJump(month);
    },
    [onJump, showBubble],
  );

  /* 「按住拖」：小程序没有 pointer 事件，用 touchmove 算落在第几格。
     拖动只负责**显示气泡**，抬手（touchend）才真正跳 —— 否则一路拖过去
     会连续触发 N 次重铺墙的请求（每次都是三个接口）。 */
  const indexAtY = useCallback(
    (clientY: number): number => {
      const top = axisTop.current;
      if (top === null) return 0;
      return Math.floor((clientY - top) / cellPx);
    },
    [cellPx],
  );

  /** 把越界下标夹回合法区间 */
  const clampIndex = useCallback(
    (i: number): number => Math.max(0, Math.min(cells.length - 1, i)),
    [cells.length],
  );

  if (!visible || cells.length === 0) return null;

  const totalH = cells.length * CELL_RPX + 8;

  return (
    <View
      className="axis"
      /* 顶部让过顶栏（88rpx）+ 状态栏。
         ⚠ 内联 style 里的 rpx 不会被转换（Taro 只转 scss 里的；H5 会把它
         当成 128px 直接算，实测 top 变成 1001px、整条轴跑到视口外）。
         必须过 Taro.pxTransform —— 这条规则 wall/index.tsx 顶部也写了。 */
      style={{ top: `calc(env(safe-area-inset-top, 0px) + ${px(128)})`, height: px(totalH) }}
      onTouchStart={(e) => {
        moved.current = false;
        const touch = touchesOf(e)[0];
        if (!touch) return;
        const m = cells[clampIndex(indexAtY(touch.clientY))];
        if (m) {
          pendingMonth.current = m.month;
          showBubble(m.month);
        }
      }}
      onTouchMove={(e) => {
        moved.current = true;
        const touch = touchesOf(e)[0];
        if (!touch) return;
        const m = cells[clampIndex(indexAtY(touch.clientY))];
        if (m) {
          pendingMonth.current = m.month;
          showBubble(m.month);
        }
      }}
      onTouchEnd={() => {
        /* 只有"拖动过"才在抬手时跳；单纯点一下交给子格的 onClick，
           避免同一次点击触发两次跳月请求（A3） */
        if (moved.current && pendingMonth.current) jump(pendingMonth.current);
        pendingMonth.current = null;
        moved.current = false;
      }}
    >
      {/* 拖动/点击时浮出的「10 月」气泡 */}
      {bubble ? <View className="axis__bubble">{monthCn(bubble)}</View> : null}

      {cells.map((m) => (
        <View
          key={m.month}
          className={'axis__m' + (m.month === activeMonth ? ' axis__m--on' : '')}
          onClick={() => jump(m.month)}
        >
          <Text className="axis__t">{m.month.slice(5, 7)}</Text>
        </View>
      ))}
    </View>
  );
}

const MONTH_CN = [
  '一', '二', '三', '四', '五', '六',
  '七', '八', '九', '十', '十一', '十二',
];

/** '2026-10' → '十月' */
function monthCn(key: string): string {
  const n = parseInt(key.slice(5, 7), 10);
  return n >= 1 && n <= 12 ? MONTH_CN[n - 1] : key;
}
