/* ================================================================
   随机一道 · 全屏浮窗

   原型 photo-wall-h5 的 Spotlight：墙压暗（这里用深色遮罩），
   一束光（白色照片卡）打在选中的那道菜上，下方两道按钮
   「换一个」「就它了」。

   关键交互（原型有、之前我做成跳转详情页完全丢了）：
   · 换一个：交叉过渡而不是"先消失再出现"，两张照片短暂重叠，不出现空白
   · 就它了：朱砂红章「今天」落下来，停一下再收起，有仪式感

   为什么不做成跳转详情页：这是"不知道吃什么"的场景，
   用户要的是原地换几张看看，跳页会打断这个动作。
   ================================================================ */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, Image } from '@tarojs/components';

import { photosOf, spotlightMeta } from '@photo-wall/core';
import type { FoodRecord } from '@photo-wall/core';

import { resolveAssetUrl } from '../../utils/asset';

import './index.scss';

export interface SpotlightProps {
  /** 当前展示的那道菜；null = 不显示 */
  record: FoodRecord | null;
  /** 换一个：由父组件换一条记录传进来 */
  onAgain: () => void;
  /** 就它了 */
  onPick: (record: FoodRecord) => void;
  onClose: () => void;
}

type Phase = 'idle' | 'picked' | 'closing';

export default function Spotlight({ record, onAgain, onPick, onClose }: SpotlightProps) {
  const [cur, setCur] = useState<FoodRecord | null>(record);
  /** 上一张：换一个时用来做交叉过渡 */
  const [prev, setPrev] = useState<FoodRecord | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  /* 父组件换了记录就更新展示；同时清理"上一张" */
  useEffect(() => {
    if (record) setCur(record);
  }, [record]);

  /* 关闭时重置状态，下次打开是干净的 idle */
  useEffect(() => {
    if (cur === null) {
      setPhase('idle');
      setPrev(null);
    }
  }, [cur]);

  /* 卸载/关闭时清掉所有定时器，避免在已关闭的浮层上继续跑动画 */
  useEffect(
    () => () => {
      timers.current.forEach(clearTimeout);
      timers.current = [];
    },
    [],
  );

  const reroll = useCallback(() => {
    if (prev || phase !== 'idle' || !cur) return;
    setPrev(cur);
    onAgain();
    timers.current.push(setTimeout(() => setPrev(null), 300));
  }, [cur, prev, phase, onAgain]);

  /* 盖章 → 停留 → 淡出 → 真正关闭（原型时间轴：盖章 300ms + 停留 320ms） */
  const confirm = useCallback(() => {
    if (phase !== 'idle' || !cur) return;
    setPhase('picked');
    timers.current.push(
      setTimeout(() => {
        setPhase('closing');
        timers.current.push(
          setTimeout(() => {
            onPick(cur);
            setCur(null);
          }, 260),
        );
      }, 620),
    );
  }, [cur, phase, onPick]);

  if (!record || !cur) return null;

  return (
    <View
      className={`spot${phase === 'closing' ? ' spot--closing' : ''}`}
      onClick={(e) => {
        /* 点空白处关闭，但盖章过程中不允许打断 */
        if (e.target === e.currentTarget && phase === 'idle') onClose();
      }}
    >
      <Text className={`spot__k${phase === 'picked' ? ' spot__k--hidden' : ''}`}>
        {prev ? '换一张…' : '今天就吃这个？'}
      </Text>

      {/* stage 用 grid 把新旧两张叠在同一格，交叉过渡时不会留白 */}
      <View className={`spot__stage${phase === 'picked' ? ' spot__stage--picked' : ''}`}>
        {prev ? (
          <View className="spot__ph spot__ph--leaving" key={`leave-${prev.id}`}>
            <Image className="spot__img" src={resolveAssetUrl(photosOf(prev)[0])} mode="aspectFill" />
          </View>
        ) : null}

        <View className="spot__ph spot__ph--enter" key={`enter-${cur.id}`}>
          <Image className="spot__img" src={resolveAssetUrl(photosOf(cur)[0])} mode="aspectFill" />

          {/* 朱砂红章：落下来后微微回弹 */}
          {phase === 'picked' ? (
            <View className="spot__stamp">
              <Text className="spot__stamp-t">今天</Text>
            </View>
          ) : null}
        </View>
      </View>

      <Text className={`spot__name${prev ? ' spot__name--swap' : ''}`}>{cur.eat}</Text>
      <Text className={`spot__sub${prev ? ' spot__sub--swap' : ''}`}>
        {spotlightMeta(cur)}
      </Text>

      <View className={`spot__acts${phase !== 'idle' ? ' spot__acts--dim' : ''}`}>
        <View className="spot__btn" onClick={reroll}>
          <Text>换一个</Text>
        </View>
        <View className="spot__btn spot__btn--solid" onClick={confirm}>
          <Text>就它了</Text>
        </View>
      </View>
    </View>
  );
}
