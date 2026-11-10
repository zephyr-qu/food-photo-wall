/* ================================================================
   城市选择浮层 —— 两级：省 → 市

   两个宿主共用这一个组件：
   · 照片墙：variant="dropdown"，钉在顶栏下，纸色卡片，只盖右上一块
   · 表单（贴一张 / 编辑）：variant="sheet"，从底部上滑，配合输入框

   数据由调用方给（groups）：
   · 墙上用 groupCitiesByProvince(已拍记录) —— 带计数、按数量降序
   · 表单里用 provinceCatalogue() —— 全量城市表、不带计数

   交互约定：
   · 一级点省，省内只有一个城市（北京/上海这类直辖市）时直接落定
   · 二级顶部有「‹ 全部省份」返回，二级里不会再长出四级
   · 半透明遮罩点一下即关；onPick 只管选值，关不关由宿主决定
   ================================================================ */
import React, { useEffect, useState } from 'react';
import { View, Text } from '@tarojs/components';
import { provinceOf } from '@photo-wall/core';
import type { ProvinceGroup } from '@photo-wall/core';

import './index.scss';

export interface CityPickerProps {
  open: boolean;
  /** dropdown：顶栏下的卡片；sheet：底部上滑 */
  variant?: 'dropdown' | 'sheet';
  /** dropdown 变体的 top（照片墙要把状态栏高度算进去） */
  top?: string;
  /** 一级标题；二级会自动换成省名 */
  hint?: string;
  /** 各省城市 */
  groups: ProvinceGroup[];
  /** 是否显示右侧计数（表单里用全量表时关掉） */
  showCounts?: boolean;
  /** 一级额外的「全部」行（照片墙用）；不传则不出现 */
  allCount?: number;
  /** 一级额外的「未记」行（照片墙用） */
  uncityCount?: number;
  /** 一级顶部的「不记城市」行（表单用：城市只选不填，得有个「留空」的出口） */
  allowNone?: boolean;
  /** 当前选中的城市；null = 全部 */
  city: string | null;
  onPick: (city: string | null) => void;
  onClose: () => void;
}

export default function CityPicker({
  open,
  variant = 'dropdown',
  top,
  hint,
  groups,
  showCounts = true,
  allCount,
  uncityCount,
  allowNone = false,
  city,
  onPick,
  onClose,
}: CityPickerProps) {
  /** 二级：当前展开的省；null = 一级 */
  const [province, setProvince] = useState<string | null>(null);

  /* 每次打开都回到一级 —— 上次展开的省不该成为下次的起点 */
  useEffect(() => {
    if (open) setProvince(null);
  }, [open]);

  if (!open) return null;

  const group = province ? groups.find((g) => g.province === province) ?? null : null;
  /** 当前筛选的城市属于哪个省（一级里点亮这一行） */
  const activeProvince = provinceOf(city);

  const cls = 'citypick' + (variant === 'sheet' ? ' citypick--sheet' : ' citypick--dd');
  /** 照片墙的卡片：一级不放说明行（那行字小又多，白占一截高度），
      二级才需要省名当标题；抽屉形态一级要有「选择城市」 */
  const showHeader = Boolean(group) || variant === 'sheet';

  const cityRow = (name: string, count: number) => (
    <View
      key={name}
      className={'citypick__row' + (city === name ? ' citypick__row--on' : '')}
      onClick={() => onPick(name)}
    >
      <Text className="citypick__name">{name}</Text>
      {showCounts && <Text className="citypick__n">{count}</Text>}
    </View>
  );

  return (
    <>
      <View
        className={'citypick-mask' + (variant === 'sheet' ? ' citypick-mask--dim' : '')}
        onClick={onClose}
      />
      <View
        className={cls}
        style={variant === 'dropdown' && top ? { top } : undefined}
      >
        {variant === 'sheet' && <View className="citypick__handle" />}
        {showHeader && (
          <View className="citypick__h">{group ? group.province : hint ?? '选择城市'}</View>
        )}

        {group ? (
          <>
            <View
              className="citypick__row citypick__row--back"
              onClick={() => setProvince(null)}
            >
              <Text className="citypick__chev">‹</Text>
              <Text>全部省份</Text>
            </View>
            <View className="citypick__scroll">
              <View className="citypick__list">
                {group.cities.map(({ city: name, count }) => cityRow(name, count))}
              </View>
              {/* 渐隐：省 / 城市一多就滚，边缘给个「还有」的暗示 */}
              <View className="citypick__fade" />
            </View>
          </>
        ) : (
          <View className="citypick__scroll">
            <View className="citypick__list">
              {/* 表单里「城市只选不填」：得留一个「不记城市」的出口 */}
              {allowNone && (
                <View
                  className={
                    'citypick__row' + (city === null || city === '' ? ' citypick__row--on' : '')
                  }
                  onClick={() => onPick('')}
                >
                  <Text className="citypick__name">不记城市</Text>
                </View>
              )}
              {/* 「全部」在最前：没筛选时它是选中态（墨底纸字） */}
              {allCount !== undefined && (
                <View
                  className={'citypick__row' + (city === null ? ' citypick__row--on' : '')}
                  onClick={() => onPick(null)}
                >
                  <Text className="citypick__name">全部</Text>
                  <Text className="citypick__n">{allCount}</Text>
                </View>
              )}
              {groups.map((g) => (
                <View
                  key={g.province}
                  className={
                    'citypick__row citypick__row--prov' +
                    (activeProvince === g.province ? ' citypick__row--on' : '')
                  }
                  onClick={() => {
                    /* 省内只有一城（直辖市）就直接落定，少点一次 */
                    if (g.cities.length === 1) {
                      onPick(g.cities[0].city);
                    } else {
                      setProvince(g.province);
                    }
                  }}
                >
                  <Text className="citypick__name">{g.province}</Text>
                  {showCounts && <Text className="citypick__n">{g.count}</Text>}
                  {g.cities.length > 1 && <Text className="citypick__chev">›</Text>}
                </View>
              ))}
              {uncityCount !== undefined && uncityCount > 0 && (
                <View
                  className={'citypick__row' + (city === '' ? ' citypick__row--on' : '')}
                  onClick={() => onPick('')}
                >
                  <Text className="citypick__name">未记</Text>
                  <Text className="citypick__n">{uncityCount}</Text>
                </View>
              )}
            </View>
            {/* 渐隐：省 / 城市一多就滚，边缘给个「还有」的暗示 */}
            <View className="citypick__fade" />
          </View>
        )}
      </View>
    </>
  );
}
