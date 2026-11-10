/* ================================================================
   店铺页：一家店的档案

   一屏回答三件事：这是哪家店、我跟它熟不熟、在这吃过什么。
   统计不做表格也不做卡片，就是店名下面一行安静的元信息 ——
   它是背景信息，不该和照片抢注意力。

   ---------- 接后端后 ----------
   聚合改由 GET /shops/by-name 提供（本地只有已加载的几页，
   按店名过滤会漏掉没翻到的记录）。三种状态：加载中 / 无此店 / 失败可重试。
   ================================================================ */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, Image } from '@tarojs/components';
import Taro, { useDidShow, useRouter } from '@tarojs/taro';

import { fetchShop } from '../../data/store';
import { photoOf, dateOf, joinBits } from '@photo-wall/core';
import EmptyState from '../../components/EmptyState';
import RatingDots from '../../components/RatingDots';
import { errorText } from '../../api/client';
import { goDetail, safeDecode } from '../../utils/router';
import { resolveAssetUrl } from '../../utils/asset';
import type { ShopView } from '../../api/types';

import './index.scss';

export default function ShopPage() {
  const router = useRouter();
  /* safeDecode 而不是裸 decodeURIComponent：店名含 % 时后者会抛
     URIError: URI malformed，整页白屏。 */
  const name = safeDecode(router.params.name || '');
  /* 城市：详情页跳过来时会带（同名连锁店消歧，A5） */
  const cityParam = safeDecode(router.params.city || '') || null;

  const [shop, setShop] = useState<ShopView | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'missing' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  /** 当前查看的城市（null = 该店名下的全部城市，合并口径） */
  const [city, setCity] = useState<string | null>(cityParam);
  /** 翻页中（A6） */
  const [loadingMore, setLoadingMore] = useState(false);

  /* 常点：按菜名聚合次数，取前 3；渲染期计算，不动接口形状。
     聚合口径和 api/types.ts 的 ApiStats.repeated 一致（按 eat 计数）。

     ⚠ 必须放在下面所有早退 return **之前**：React 要求每次渲染的 hook
     顺序一致。以前这个 useMemo 写在「loading / error / missing」三个早退
     之后 —— 首屏走 loading 分支时只挂了 4 个 hook，数据回来后走 ready
     分支变成 5 个，hook 数量在两次渲染间变了，React 直接抛
     "Minified React error #310"（rendered fewer hooks than expected），
     表现就是店铺页永远卡在骨架屏、看起来像接口没回来。

     shop 可能为 null（首屏还没拿到数据），所以用空数组兜底。 */
  const topEats = useMemo(() => {
    const counts = new Map<string, number>();
    (shop?.items ?? []).forEach((r) => {
      counts.set(r.eat, (counts.get(r.eat) || 0) + 1);
    });
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const top = ranked.slice(0, 3);
    const max = top.length ? top[0][1] : 1;
    return top.map(([eat, n]) => ({ eat, n, pct: Math.round((n / max) * 100) }));
  }, [shop?.items]);

  /** 同名连锁店的城市候选（A5）：详情页带了城市就直接落到那一家；
   *  没带/想看别的城市时，这里给出可切换的 chip。 */
  const candidateCities = useMemo(() => {
    const set = new Set<string>();
    (shop?.candidates ?? []).forEach((c) => c.cities.forEach((x) => set.add(x)));
    return [...set];
  }, [shop?.candidates]);

  useEffect(() => {
    let alive = true;
    setStatus('loading');
    fetchShop(name, { city })
      .then((res) => {
        if (!alive) return;
        if (!res) {
          setStatus('missing');
          return;
        }
        setShop(res);
        setStatus('ready');
        /* 导航栏标题跟随店名（旧 P3-2：以前恒为「店铺」） */
        if (res.name) Taro.setNavigationBarTitle({ title: res.name });
      })
      .catch((e) => {
        if (!alive) return;
        setError(errorText(e));
        setStatus('error');
      });
    return () => {
      alive = false;
    };
  }, [name, city, tick]);

  /** 加载更早的记录（A6：以前 100 条后静默截断） */
  const loadMore = async (): Promise<void> => {
    if (!shop || !shop.hasMore || !shop.nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const next = await fetchShop(name, { city, cursor: shop.nextCursor });
      if (!next) return;
      setShop((prev) =>
        prev
          ? {
              ...prev,
              /* 只追加 items；统计/名称等以第一次响应为准（同一口径） */
              items: prev.items.concat(next.items),
              hasMore: next.hasMore,
              nextCursor: next.nextCursor,
            }
          : next,
      );
    } catch (e) {
      Taro.showToast({ title: errorText(e), icon: 'none', duration: 2200 });
    } finally {
      setLoadingMore(false);
    }
  };

  /* 从详情页返回时刷新：店铺页实例不会销毁，不重拉的话「删掉/改过的记录」
     还留在照片格和统计里（A1）。首次 show 由上面的 effect 负责，跳过避免重复请求。
     ⚠ 放在所有早退 return 之前，保持 hook 顺序稳定。 */
  const firstShowRef = useRef(true);
  useDidShow(() => {
    if (firstShowRef.current) {
      firstShowRef.current = false;
      return;
    }
    setTick((n) => n + 1);
  });

  /* 刷新中且已有数据时不要闪骨架，继续显示旧内容（下面 :82 起的分支） */
  if (status === 'loading' && !shop) {
    return (
      <View className="sp">
        <View className="sp__head">
          <View className="sp__sk sp__sk--name" />
          <View className="sp__sk sp__sk--meta" />
        </View>
      </View>
    );
  }

  /* 只有「还没有任何数据」时才整页报错；已有内容时刷新失败就继续显示旧的，
     不要让一次网络抖动把整页换掉 */
  if (status === 'error' && !shop) {
    return (
      <View className="sp sp--empty">
        <Text className="sp__fail-t">{error || '加载失败'}</Text>
        <View className="btn btn--quiet" onClick={() => setTick((n) => n + 1)}>
          <Text>重试</Text>
        </View>
      </View>
    );
  }

  if (status === 'missing' || !shop) {
    return (
      <View className="sp sp--empty">
        <EmptyState text="这家店还没有记录" />
      </View>
    );
  }

  const openRecord = (id: string): void => {
    goDetail(id);
  };

  /* 首次 / 最近：按天比较。原型两个都写，这里保持一致。
     后端在店铺没有记录时会返回 firstAt/lastAt = null（§6.4.2），这里兜底。 */
  const firstDay = shop.firstAt ? dateOf(shop.firstAt) : '—';
  const lastDay = shop.lastAt ? dateOf(shop.lastAt) : '—';

  return (
    <View className="sp">
      <View className="sp__head">
        <View className="sp__title-row">
          <Text className="sp__name">{name}</Text>
          {/* 地点：店名右侧胶囊标签。指定了城市就显示该城市；
              否则单城显示城名、多城用「N 城」折叠（A5：同名连锁店要看清楚是哪家）。 */}
          {shop.cities.length > 0 && (
            <Text className="sp__loc">
              {city || (shop.cities.length === 1 ? shop.cities[0] : `${shop.cities.length} 城`)}
            </Text>
          )}
        </View>

        {/* 同名连锁店：不同城市各有一家时，给可切换的城市 chip（A5） */}
        {candidateCities.length > 1 && (
          <View className="sp__cands">
            <Text className="sp__cands-k">同名店</Text>
            {city !== null && (
              <Text
                className="sp__cand"
                onClick={() => {
                  setCity(null);
                  setTick((n) => n + 1);
                }}
              >
                全部
              </Text>
            )}
            {candidateCities.map((c) => (
              <Text
                key={c}
                className={'sp__cand' + (c === city ? ' sp__cand--on' : '')}
                onClick={() => {
                  if (c === city) return;
                  setCity(c);
                  setTick((n) => n + 1);
                }}
              >
                {c}
              </Text>
            ))}
          </View>
        )}

        {/* 统计：等宽数字 + 更小标签的 metric 行，层级靠字号字重拉出来
            （不改设计令牌的三档文字约束）。最后一项没有则整项不出现。
            「均分」排在最右 —— 视觉上正对着右上角的地点标签。 */}
        <View className="sp__stats">
          <View className="sp__metric">
            <Text className="sp__v">{shop.visitCount}</Text>
            <Text className="sp__k">去过</Text>
          </View>
          <View className="sp__metric">
            <Text className="sp__v">{shop.dishCount}</Text>
            <Text className="sp__k">点过</Text>
          </View>
          {shop.fiveCount > 0 && (
            <View className="sp__metric">
              <Text className="sp__v">{shop.fiveCount}</Text>
              <Text className="sp__k">五分</Text>
            </View>
          )}
          {shop.avgRating > 0 && (
            <View className="sp__metric sp__metric--avg">
              <Text className="sp__v">{shop.avgRating.toFixed(1)}</Text>
              <Text className="sp__k">均分</Text>
            </View>
          )}
        </View>

        {/* 首次 / 最近：用 hairline 和上面的统计分隔开 */}
        <View className="sp__span">
          <Text className="sp__span-k">第一次</Text>
          <Text className="sp__span-v">{firstDay}</Text>
          <Text className="sp__span-k">最近</Text>
          <Text className="sp__span-v">{lastDay}</Text>
        </View>

        {/* 常点：从记录里聚合出的「档案感」区块，把数字变成可读的清单 */}
        {topEats.length > 0 && (
          <View className="sp__freq">
            <Text className="sp__freq-h">常点</Text>
            {topEats.map((e) => (
              <View key={e.eat} className="sp__freq-row">
                <Text className="sp__freq-eat">{e.eat}</Text>
                <View className="sp__freq-bar">
                  <View className="sp__freq-fill" style={{ width: `${e.pct}%` }} />
                </View>
                <Text className="sp__freq-n">×{e.n}</Text>
              </View>
            ))}
          </View>
        )}
      </View>

      {/* 照片格：2 列正方形，和墙同一套图注手法 */}
      <View className="sp__photos">
        {shop.items.map((r) => {
          return (
            <View key={r.id} className="sp__ph" onClick={() => openRecord(r.id)}>
              <Image className="sp__img" src={resolveAssetUrl(photoOf(r))} mode="aspectFill" lazyLoad />
              <View className="sp__cap">
                <Text className="sp__eat">{r.eat}</Text>
                <Text className="sp__when">
                  {joinBits([dateOf(r.at).slice(5), r.rating ? `${r.rating} 分` : null])}
                </Text>
                {/* 图注评分星：复用 RatingDots，sm/dark 正好踩在照片暗遮罩上 */}
                {r.rating > 0 && (
                  <RatingDots value={r.rating} size="sm" theme="dark" />
                )}
              </View>
            </View>
          );
        })}
      </View>

      {/* A6：翻页 + 明确的到底提示（以前 >100 条时静默截断，数字与照片对不上） */}
      {shop.hasMore ? (
        <View className="sp__more" onClick={() => void loadMore()}>
          <Text>{loadingMore ? '加载中…' : '加载更多'}</Text>
        </View>
      ) : shop.items.length > 0 ? (
        <Text className="sp__more-hint">共 {shop.visitCount} 条，已全部加载</Text>
      ) : null}
    </View>
  );
}
