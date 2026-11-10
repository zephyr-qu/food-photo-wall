/* ================================================================
   统计浮层 · 从底部升起的一张纸

   原型 photo-wall-h5 的 StatsSheet：整页从下方滑入，盖住墙面，
   圆角上沿 + 顶部一道 grip，标题「这面墙」，右上角 ×。
   六行数据不带卡片、不带图标、不做图表 —— 就是六行文字。

   为什么不做成新页面：统计是「看这面墙的另一种看法」，
   和城市筛选、按月分组一样，属于原地展开，不是另一个功能。
   页面栈里多一层反而要用户自己回来。

   ---------- 接后端后 ----------
   数字来自 GET /stats（服务端全量口径），不再对「已加载的几页」算。
   量词（张照片/座城市/家店）仍在这里拼 —— 接口只给数字，
   文案改版不该要求后端跟着改。
   ================================================================ */
import React from 'react';
import { View, Text } from '@tarojs/components';

import type { ApiStats } from '../../api/types';

import './index.scss';

export interface StatsSheetProps {
  open: boolean;
  /** 服务端聚合结果；null = 还没加载出来（显示占位破折号） */
  stats: ApiStats | null;
  onClose: () => void;
}

interface Row {
  k: string;
  v: string;
  n?: string;
}

/** 六行文案：与原型 / core 的 statRows 完全一致的措辞 */
function rows(stats: ApiStats | null): Row[] {
  if (!stats) {
    return [
      { k: '拍过的', v: '—' },
      { k: '五分', v: '—' },
      { k: '去过', v: '—' },
      { k: '吃过', v: '—' },
      { k: '均分', v: '—' },
      { k: '反复吃', v: '—' },
    ];
  }
  const repeated = stats.repeated.length
    ? stats.repeated
        .slice(0, 3)
        .map((r) => `${r.eat} ${r.count} 次`)
        .join('、')
    : '无';
  return [
    { k: '拍过的', v: `${stats.total} 张照片` },
    { k: '五分', v: `${stats.fiveCount} 道`, n: stats.firstFiveEat || undefined },
    { k: '去过', v: `${stats.cities} 座城市` },
    { k: '吃过', v: `${stats.shops} 家店` },
    { k: '均分', v: stats.avgRating ? stats.avgRating.toFixed(1) : '—' },
    { k: '反复吃', v: repeated },
  ];
}

export default function StatsSheet({ open, stats, onClose }: StatsSheetProps) {
  const list = rows(stats);

  return (
    <View className={`stats-sheet${open ? ' stats-sheet--on' : ''}`}>
      {/* 点遮罩关闭：浮层本身不拦截，只有纸面区域吃掉点击 */}
      <View className="stats-sheet__mask" onClick={onClose} />

      <View className="stats-sheet__paper">
        <View className="stats-sheet__grip" />

        <View className="stats-sheet__bar">
          <Text className="stats-sheet__t">这面墙</Text>
          <View className="stats-sheet__x" onClick={onClose}>
            <Text>×</Text>
          </View>
        </View>

        <View className="stats-sheet__body">
          {list.map((r) => (
            <View className="stat" key={r.k}>
              <Text className="stat__k">{r.k}</Text>
              <Text className="stat__v">{r.v}</Text>
              {r.n ? <Text className="stat__n">{r.n}</Text> : null}
            </View>
          ))}
        </View>
      </View>
    </View>
  );
}
