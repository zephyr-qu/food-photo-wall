/* ================================================================
   空态 · 一句话说明「这里本来该有什么」

   抽出来的原因：三个页面各写一遍，且 detail / shop 的样式完全一样
   （flex 居中 + 一行灰字），只有颜色令牌因深浅色主题而不同。

   两种形态：
   · 默认（页面级）—— 撑满整屏居中，用于「这条记录不在了」这种整页空态
   · mark         —— 多一个空画框 + 提示副文案，用于墙这种「有内容区域但为空」

   主题：detail 是深色底，传 theme="dark" 换令牌。
   ================================================================ */
import React from 'react';
import { View, Text } from '@tarojs/components';

import './index.scss';

export interface EmptyStateProps {
  /** 主文案 */
  text: string;
  /** 副文案（可选），只在 mark 形态下建议使用 */
  hint?: string;
  /** 深色主题（详情页） */
  theme?: 'light' | 'dark';
  /** 显示空画框，用于「内容区为空」而不是「整页无效」 */
  mark?: boolean;
}

export default function EmptyState({
  text,
  hint,
  theme = 'light',
  mark = false,
}: EmptyStateProps) {
  return (
    <View
      className={
        'empty-state empty-state--' + theme + (mark ? ' empty-state--mark' : '')
      }
    >
      {mark && (
        <View className="empty-state__mark">
          {/* 画框内嵌的一块淡底：原型用 ::before 内缩实现，
              小程序不写伪元素，换成子节点 View（数值见 scss） */}
          <View className="empty-state__mark-in" />
        </View>
      )}
      {/* 两行文案包一层：mark 形态是同一段话的两行（原型 <br>），
          行距交给 line-height，不能被外层 gap 再插一截 */}
      <View className="empty-state__copy">
        <Text className="empty-state__t">{text}</Text>
        {hint ? <Text className="empty-state__hint">{hint}</Text> : null}
      </View>
    </View>
  );
}
