/* ================================================================
   评分圆点 · 5 个圆，第 n 个亮起表示 n 分

   抽出来的原因：compose（可编辑）和 detail（只读）的**评分逻辑完全一致**
   （1–5 逐档点亮），但外观差异很大，所以这里抽逻辑、不抽外观：

     size  'md' 44rpx 可点击 / 'sm' 12rpx 纯展示
     theme 'light' 浅色页面（表单） / 'dark' 深色页面（详情）

   行为约定：
   · 传了 onSelect 才可点；再点同一档会取消（回传 0），与 compose 的旧行为一致
   · 不传 onSelect 就是只读，不绑定任何点击
   ================================================================ */
import React from 'react';
import { View } from '@tarojs/components';

import './index.scss';

export interface RatingDotsProps {
  /** 当前分值，0 表示未评分 */
  value: number;
  /** 满档，默认 5 */
  max?: number;
  /** 圆点尺寸：md=44rpx（可点），sm=12rpx（展示） */
  size?: 'sm' | 'md';
  /** 配色主题：详情页是深底，需要另一套令牌 */
  theme?: 'light' | 'dark';
  /** 有则允许点击；回传 0 表示取消评分 */
  onSelect?: (next: number) => void;
}

/* 按 max 现场生成刻度。
   之前是常量 [1..5].slice(0, max)：max > 5 时会被静默截成 5，
   传了参数却没有任何效果。 */
function makeRange(max: number): number[] {
  const n = Math.max(0, Math.floor(max));
  return Array.from({ length: n }, (_, i) => i + 1);
}

export default function RatingDots({
  value,
  max = 5,
  size = 'md',
  theme = 'light',
  onSelect,
}: RatingDotsProps) {
  const dots = makeRange(max);

  return (
    <View className={`rating rating--${size} rating--${theme}`}>
      {dots.map((n) => {
        const on = n <= value;
        const cls =
          'rating__dot rating__dot--' + size + (on ? ' rating__dot--on' : '');
        return (
          <View
            key={n}
            className={cls}
            onClick={
              onSelect
                ? () => onSelect(value === n ? 0 : n)
                : undefined
            }
          />
        );
      })}
    </View>
  );
}
