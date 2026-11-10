/* ================================================================
   照片墙 · 首页

   一屏只做一件事：看这面墙。
   日期分组、城市筛选、统计、随机一道都在这页**原地完成**，不另开页面 ——
   它们是「看墙」的几种看法，不是几个功能。
   （原型 photo-wall-h5 的设计主张：照片墙不该把你送去别的页面。）

   布局坐标由 core 的 layout.ts 算好（单位 rpx），这里只按坐标摆。
   ⚠ 内联 style 里的 rpx 小程序不认，必须过 Taro.pxTransform。

   ---------- 接后端后的三处变化 ----------
   · 墙的数据来自 store 的「已加载页」，翻页/筛选/随机都走接口；
   · 统计与城市计数**不再本地算**（分页后本地只有几页，算出来会越翻越小），
     改为 store 里的服务端聚合结果；
   · 补了三种状态：首屏骨架、失败重试、到底提示 —— 以前没有网络，
     这三种状态从来不需要，现在必须给。
   ================================================================ */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, Image } from '@tarojs/components';
import Taro, { useDidShow, useReachBottom } from '@tarojs/taro';

import {
  useWall,
  useAggregates,
  loadFirstPage,
  loadAggregates,
  loadMore,
  setCityFilter,
  rollRandom,
  refreshIfStale,
  jumpToMonth,
  writeErrorText,
} from '../../data/store';
import { photoOf, placeOf } from '@photo-wall/core';
import { layoutWall } from '@photo-wall/core';
import EmptyState from '../../components/EmptyState';
import StatsSheet from '../../components/StatsSheet';
import Spotlight from '../../components/Spotlight';
import CityPicker from '../../components/CityPicker';
import MonthAxis from '../../components/MonthAxis';
import { previewPhoto } from '../../utils/taro';
import { resolveAssetUrl } from '../../utils/asset';
import { wallShare, wallTimelineShare } from '../../utils/share';
import { goDetail, goCompose } from '../../utils/router';
import type { FoodRecord, ProvinceGroup } from '@photo-wall/core';

import './index.scss';

/** rpx → 当前平台可用单位 */
const px = (n: number): string => Taro.pxTransform(n);

/** 和原型 records.js 的 monthLabel 一致：「2025-10」→「十月」 */
const MONTH_CN = [
  '一', '二', '三', '四', '五', '六',
  '七', '八', '九', '十', '十一', '十二',
];
const monthLabel = (key: string): string =>
  MONTH_CN[parseInt(key.slice(5, 7), 10) - 1] + '月';

/** 图注副行：店 · 省·市（和原型 records.js 的 metaOf 一致，没店名时给占位） */
const metaText = (r: FoodRecord): string =>
  [r.shop, placeOf(r)].filter(Boolean).join(' · ') || '没记店名';

export default function WallPage() {
  const { records, status, error, hasMore, total, filterCity, offline } = useWall();
  /* 只有「网络失败」才会同时有 offline + error；纯本地演示模式 offline 恒 true
     但没有 error，不能给它显示「没有网络」的提示。 */
  const offlineHint = offline && Boolean(error);
  const { cities: cityAgg, stats, months } = useAggregates();
  const [showDate, setShowDate] = useState(false);
  const [cityOpen, setCityOpen] = useState(false);
  const [statsOpen, setStatsOpen] = useState(false);
  /** 随机一道：null = 浮窗关闭；有值 = 浮窗打开并展示这一条 */
  const [spotRecord, setSpotRecord] = useState<FoodRecord | null>(null);
  /** 抽牌中：防止连点、也给出「点了有响应」的视觉，避免「点了没反应」的错觉 */
  const [rolling, setRolling] = useState(false);
  /** 抽牌中的**同步**闸。
   *
   * 为什么要 ref 而不是 state：`rolling` 是 React state，同一次事件循环里
   * 连点两次，两次调用看到的都是**旧的** `rolling=false`（state 还没提交），
   * 于是两次并发请求都发出去 —— 在 token 恰好过期时，这就是两次并发
   * refresh 竞态（服务端 refreshToken 是轮换的，只有一发能成功）。
   * ref 是同步的，第二次调用立刻看到 `true`。
   */
  const rollingRef = useRef(false);
  const loadingMore = useRef(false);
  /** 上一次「随机一道」的结果，避免连点两次还是同一道 */
  const lastRandomId = useRef<string | null>(null);

  /* 首屏：先拉墙，再拉聚合（聚合慢一点不影响墙先出来） */
  useEffect(() => {
    if (status === 'idle') {
      loadFirstPage();
      loadAggregates();
    }
  }, [status]);

  /* 从详情/编辑页返回、或切后台再回来：store 还活着，status 仍是 'ready'，
     首屏 effect 不会重跑。超过 30s 就静默重拉一次，避免长期看着旧数据。 */
  useDidShow(() => {
    refreshIfStale();
  });

  /** 状态栏高度（px）：自绘导航（navigationStyle: 'custom'）时，
      顶栏要自己托住状态栏（height/paddingTop 内联计算）。
      h5 没有原生状态栏，取 0 —— 与改动前行为一致。 */
  const statusBarH = useMemo(() => {
    try {
      const info =
        typeof Taro.getWindowInfo === 'function'
          ? Taro.getWindowInfo()
          : Taro.getSystemInfoSync();
      return info.statusBarHeight || 0;
    } catch {
      return 0;
    }
  }, []);

  /** 右上角原生胶囊的让位宽度（px）。
      胶囊宽度随机型 / 是否有「更多」按钮而变，写死 rpx 会压住「统计」按钮
      （实测胶囊左沿 296pt、第三个按钮右沿 306.7pt → 压了 11pt）。
      这里直接问系统要胶囊矩形：内容右边界停在胶囊左边，再留 12px 呼吸。
      h5 没有胶囊，返回 0（不加让位）。 */
  const capsulePad = useMemo(() => {
    if (process.env.TARO_ENV !== 'weapp') return 0;
    try {
      const rect =
        typeof Taro.getMenuButtonBoundingClientRect === 'function'
          ? Taro.getMenuButtonBoundingClientRect()
          : null;
      if (!rect || !rect.left) return 0;
      const info =
        typeof Taro.getWindowInfo === 'function'
          ? Taro.getWindowInfo()
          : Taro.getSystemInfoSync();
      const winW = info.windowWidth || 375;
      return Math.max(0, Math.round(winW - rect.left + 12));
    } catch {
      return 0;
    }
  }, []);

  /* 触底懒加载：一次取一页（PAGE_SIZE=10），追加到墙尾。
     并发由 store 内部保护，这里的 ref 只是省一次无效调用。 */
  useReachBottom(() => {
    if (loadingMore.current || !hasMore) return;
    loadingMore.current = true;
    loadMore().finally(() => {
      loadingMore.current = false;
    });
  });

  /* 随机一道：走服务端（池子是全库，不是已加载的几页），避开上一次。
     与原型一致 —— 不跳页，压暗墙面打一束光打在选中的这道上。 */
  const roll = useCallback(async (): Promise<FoodRecord | null> => {
    /* 用 ref 做同步闸：state 在同一 tick 里还是旧值，双击会并发两次 */
    if (rollingRef.current) return null;
    rollingRef.current = true;
    console.log('[roll] start');
    setRolling(true);
    try {
      const pick = await rollRandom(lastRandomId.current);
      console.log('[roll] picked', pick?.id ?? 'null');
      /* 护栏：核心字段缺失（比如接口响应形状又变）= 这条记录没法渲染，
         直接当失败处理。Spotlight 渲染期崩一次会把整页卡死，绝不喂它坏数据。 */
      if (pick && !pick.eat) {
        console.error('[roll] malformed record', pick);
        Taro.showToast({ title: '抽不出来，稍后再试', icon: 'none', duration: 1800 });
        return null;
      }
      if (!pick) {
        /* null 有两种：请求真失败（下面 catch 已 toast），或当前筛选下没有可抽的菜。
           这里只处理后者 —— 否则用户看到的将是「点了毫无反应」。
           离线时抽不到要给"网络"原因，不能说「墙还是空的」误导用户。 */
        Taro.showToast({
          title: offlineHint
            ? '现在没有网络，联网后再抽'
            : filterCity
              ? '这个城市还没有能抽的菜'
              : '墙还是空的，先贴一张',
          icon: 'none',
          duration: 1800,
        });
        return null;
      }
      lastRandomId.current = pick.id;
      return pick;
    } catch (e) {
      console.error('[roll] failed', e);
      /* 用 errorText 而不是硬编码文案：限流（429）要说清「等多久」，
         笼统的「稍后再试」会让人立刻再点 —— 而再点只是再吃一次 429，
         表现出来就是「随机一道又卡住了」。 */
      Taro.showToast({ title: writeErrorText(e), icon: 'none', duration: 2200 });
      return null;
    } finally {
      console.log('[roll] done');
      rollingRef.current = false;
      setRolling(false);
    }
  }, [filterCity, offlineHint]);

  /** 点「随机一道」：打开浮窗并给第一张（抽不到时 roll 内部已给过提示） */
  const openSpotlight = useCallback(() => {
    roll().then((first) => {
      if (first) setSpotRecord(first);
    });
  }, [roll]);

  /** 浮窗里点「换一个」 */
  const rerollSpotlight = useCallback(() => {
    roll().then((next) => {
      if (next) setSpotRecord(next);
    });
  }, [roll]);

  /** 浮窗里点「就它了」：关掉并提示，不跳页 */
  const confirmSpotlight = useCallback((record: FoodRecord) => {
    setSpotRecord(null);
    Taro.showToast({
      title: `今天就吃 ${record.eat}`,
      icon: 'none',
      duration: 2000,
    });
  }, []);

  const openDetail = useCallback((record: FoodRecord) => {
    goDetail(record.id);
  }, []);

  const openCompose = useCallback(() => {
    goCompose();
  }, []);

  const toggleDate = useCallback(() => {
    setShowDate((v) => !v);
    Taro.pageScrollTo({ scrollTop: 0, duration: 0 });
  }, []);

  /* 城市筛选（两级）：点「城市」开卡片，先选省、再选市。
     收起的两条路径（选值 / 点遮罩）都走 closeCity()。 */
  const closeCity = useCallback(() => {
    setCityOpen(false);
  }, []);

  /** 落定一个城市（null = 全部，'' = 未记）：关卡片、重拉墙、回到顶部 */
  const applyCity = useCallback(
    (city: string | null) => {
      const next = filterCity === city ? null : city;
      closeCity();
      Taro.pageScrollTo({ scrollTop: 0, duration: 0 });
      setCityFilter(next);
    },
    [closeCity, filterCity],
  );

  /* 点顶栏「城市」始终打开选择器（A4）。
     取消筛选交给选择器里的「全部」行，或再点一次当前城市（applyCity 的 toggle 已支持）。
     以前的逻辑是「筛选态点这里 = 清空筛选 + 全量重载」——换个城市要两步、墙闪两次。 */
  const onCityBtn = useCallback(() => {
    setCityOpen((v) => !v);
  }, []);

  /* 城市分组：服务端给了 provinces 就直接用；否则（本地兜底）
      数据层已统一在「线上/离线兜底」两条路都给出 provinces（离线由同份 groupCitiesByProvince 补），墙页不再各自分组。 */
  const provinceGroups = useMemo<ProvinceGroup[]>(() => {
    if (!cityAgg || !cityAgg.provinces) return [];
    return cityAgg.provinces.map((p) => ({
      province: p.province,
      count: p.count,
      cities: p.cities,
    }));
  }, [cityAgg]);

  const { sections, totalHeight } = useMemo(
    () => layoutWall(records, showDate),
    [records, showDate],
  );


  /* 月轴高亮：墙上第一张所在的月份（跳月后第一张就是目标月，天然正确） */
  const activeMonth = records.length > 0 ? records[0].at.slice(0, 7) : '';

  const showSkeleton = status === 'loading' && records.length === 0;
  const showError = status === 'error' && records.length === 0;
  const showEmpty = status === 'ready' && records.length === 0;
  const showEnd = status === 'ready' && records.length > 0 && !hasMore;

  return (
    <View className="pw">
      {/* 顶栏：品牌（红点 + 衬线名）+ 三个看法开关。
          原型 .topbar 固定在墙上方，这里用 sticky 复现同一条线。
          自绘导航下这条栏同时托住状态栏（statusBarH 内联进 height/padding）；
          小程序右上角浮着胶囊，topbar--wx 负责让位。 */}
      <View
        className={'topbar' + (process.env.TARO_ENV === 'weapp' ? ' topbar--wx' : '')}
        style={{
          height: `calc(${px(88)} + ${statusBarH}px)`,
          paddingTop: `${statusBarH}px`,
          /* 精确让位（见 capsulePad）：class 里的 200rpx 只是取不到胶囊时的兜底 */
          ...(capsulePad ? { paddingRight: `${capsulePad}px` } : {}),
        }}
      >
        <View className="brand">
          {/* 红点 + 品牌名成一个整体（.brand__head）：放不下时整体换行，
              不会出现「红点单独留在第一行、名字掉到第二行」。 */}
          <View className="brand__head">
            <View className="brand__dot" />
            <Text className="brand__name">X师傅美食记</Text>
          </View>
        </View>
        {/* 右侧三个入口：和原型一样用**小字按钮**而不是胶囊。
            胶囊是城市筛选条（ribbon）里的控件，顶栏用胶囊会把
            品牌名挤到没有位置 —— 三个胶囊在窄屏上必定溢出。
            按钮文字固定（"日期"），开关状态靠底色表达，不在字面加"开/关"。 */}
        <View className="topbar__right">
          <View
            className={'iconbtn' + (showDate ? ' iconbtn--on' : '')}
            onClick={toggleDate}
          >
            <Text>日期</Text>
          </View>
          <View
            className={'iconbtn' + (filterCity !== null || cityOpen ? ' iconbtn--on' : '')}
            onClick={onCityBtn}
          >
            <Text>{filterCity !== null ? filterCity || '未记' : '城市'}</Text>
          </View>
          {/* 统计：和日期/城市同一层级，都是「看这面墙的一种看法」。
              浮层打开时点亮（iconbtn--on = 墨底纸字），给「点了有响应、现在正开着」的反馈，
              与日期/城市的高亮语言一致。 */}
          <View
            className={'iconbtn' + (statsOpen ? ' iconbtn--on' : '')}
            onClick={() => setStatsOpen(true)}
          >
            <Text>统计</Text>
          </View>
        </View>
      </View>

      {/* 离线提示：断网刷新失败时会保留已加载的墙，但必须让用户知道
          「现在看到的不是最新的」，否则会以为数据没更新/丢了（P1-2）。 */}
      {offlineHint && !showError && (
        <View className="wall-offline">
          <Text>{error || '网络不太好，显示的是上次加载的内容'}</Text>
        </View>
      )}

      {/* 城市筛选（两级：省 → 市）：顶栏下弹纸色卡片，只盖右上一块。
          组件本体在 components/CityPicker，贴一张的编辑页复用它（sheet 形态）。 */}
      <CityPicker
        open={cityOpen}
        variant="dropdown"
        top={`calc(${px(88)} + ${statusBarH}px + ${px(12)})`}
        groups={provinceGroups}
        allCount={cityAgg?.total ?? total}
        uncityCount={cityAgg?.uncityCount ?? 0}
        city={filterCity}
        onPick={applyCity}
        onClose={closeCity}
      />

      {/* 墙 */}
      <View className="board">
        {showSkeleton ? (
          /* 首屏骨架：不用转圈，直接用墙的节奏铺 6 个灰块 ——
             骨架和真墙同构，加载完不会「跳一下」。 */
          <View className="wall wall--skeleton" style={{ height: px(1200) }}>
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <View key={i} className="sk" style={{ height: px(180 + (i % 3) * 60) }} />
            ))}
          </View>
        ) : showError ? (
          <View className="wall-error">
            <Text className="wall-error__t">{error || '加载失败'}</Text>
            <View
              className="wall-error__btn"
              onClick={() => {
                loadFirstPage();
                loadAggregates();
              }}
            >
              <Text>重试</Text>
            </View>
          </View>
        ) : showEmpty ? (
          <EmptyState
            mark
            text={
              offlineHint
                ? '现在没有网络，暂时看不了墙'
                : filterCity !== null
                  ? '这个城市还没有照片。'
                  : '墙还是空的。'
            }
            hint={
              offlineHint
                ? '网络恢复后会自动刷新；也可以退出重进。'
                : filterCity !== null
                  ? '换一个城市，或者贴一张。'
                  : '贴一张试试。'
            }
          />
        ) : (
          <View className="wall" style={{ height: px(totalHeight) }}>
            {sections.map((sec) => (
              /* 用 sec.top 绝对定位：组间距由 layout 里的 GROUP_GAP 决定，
                 totalHeight 也是按同一套公式累加的，两者天然一致。
                 之前只给 height 不给 top，GROUP_GAP 算了却没画出来。 */
              <View
                key={sec.key || 'all'}
                className="sec"
                style={{ top: px(sec.top), height: px(sec.height) }}
              >
                {showDate && sec.key && (
                  <View
                    className="month"
                    style={{ top: `calc(${px(88)} + ${statusBarH}px)` }}
                  >
                    <Text className="month__m">{monthLabel(sec.key)}</Text>
                    <Text className="month__n">
                      {sec.key.slice(0, 4)} · {sec.count} 张
                    </Text>
                    <View className="month__i" />
                  </View>
                )}
                {sec.tiles.map(({ record, x, y, w, h, span }) => (
                  <View
                    key={record.id}
                    /* t-{span} 决定图注的显示规则：大图常显、小图默认隐藏。
                       原型里只有 hero / wide 常显图注，small 是 hover 才出。
                       小程序没有 hover，所以 small 靠"长按预览"看内容、
                       点进去看详情；图注不常显，墙才干净、照片才是主角。
                       hoverClass = 原型 :active 的按压变暗（brightness .93）。 */
                    className={`tile t-${span}`}
                    hoverClass="tile--down"
                    style={{
                      left: px(x),
                      top: px(y),
                      width: px(w),
                      height: px(h),
                    }}
                    onClick={() => openDetail(record)}
                  >
                    <Image
                      className="tile__img"
                      src={resolveAssetUrl(photoOf(record))}
                      mode="aspectFill"
                      lazyLoad
                      onLongPress={() => previewPhoto(resolveAssetUrl(photoOf(record)))}
                    />
                    <View className="tile__cap">
                      <Text className="tile__name">{record.eat}</Text>
                      {/* 店·城市只在 hero 上常显，其余给小图留出画面 */}
                      <Text className="tile__meta">{metaText(record)}</Text>
                    </View>
                  </View>
                ))}
              </View>
            ))}
          </View>
        )}

        {/* 到底了：真实分页才有终点，以前伪造数据是「永远翻不完」 */}
        {showEnd && (
          <View className="wall-end">
            <Text className="wall-end__t">
              {filterCity !== null ? '这个城市就这些了' : '到底了 · 共 ' + total + ' 张'}
            </Text>
          </View>
        )}
      </View>

      {/* 底部：和原型一致 —— 左「随机一道」胶囊（骰子图标）+ 右「贴一张」
          圆形快门（相机图标）。原型里这两颗按钮浮在墙上方（dock 是渐隐
          遮罩 + 两颗浮动按钮），不是一条通栏的实心按钮条。 */}
      <View className="dock">
        <View
          className={`dice${rolling ? ' dice--busy' : ''}`}
          hoverClass="dice--down"
          onClick={() => !rolling && openSpotlight()}
        >
          <Image className="dice__icon" src={resolveAssetUrl('/static/img/dice.png')} mode="aspectFit" />
          <Text>{rolling ? '抽签中…' : '随机一道'}</Text>
        </View>
        <View className="shutter" hoverClass="shutter--down" onClick={openCompose}>
          <Image className="shutter__icon" src={resolveAssetUrl('/static/img/camera.png')} mode="aspectFit" />
          <Text className="shutter__t">贴一张</Text>
        </View>
      </View>

      {/* 统计：底部升起的一张纸。口径 = 服务端全量（不吃城市筛选） */}
      <StatsSheet
        open={statsOpen}
        stats={stats}
        onClose={() => setStatsOpen(false)}
      />

      {/* 右缘月份轴：点/拖跳到某月（原型有，之前完全没实现）。
          只在「日期分组」打开时显示 —— 墙上没有月份标签时，轴没有参照物。
          数据来自 /records/months（跟随城市筛选），跳转走 cursorInclusive。 */}
      <MonthAxis
        months={months}
        activeMonth={activeMonth}
        visible={showDate && !showEmpty && !showError && !statsOpen && !cityOpen}
        onJump={(m) => {
          void jumpToMonth(m).then((ok) => {
            if (ok) {
              /* 跳月 = "从该月重铺墙"：必须回到顶部，否则看到的是新列表的中段（A3） */
              Taro.pageScrollTo({ scrollTop: 0, duration: 0 });
              return;
            }
            Taro.showToast({
              title: offlineHint ? '现在没有网络，联网后再跳月' : '跳转失败，稍后再试',
              icon: 'none',
              duration: 2000,
            });
          });
        }}
      />

      {/* 随机一道：压暗墙面，一束光打在一张上 */}
      <Spotlight
        record={spotRecord}
        onAgain={rerollSpotlight}
        onPick={confirmSpotlight}
        onClose={() => setSpotRecord(null)}
      />
    </View>
  );
}

/* 转发 / 分享到朋友圈：用静态属性而不是 hook。
   Taro 4.3 函数式页面会在创建 Page 时，按页面生命周期表把组件上的同名
   静态属性挂到页面实例（onShareAppMessage / onShareTimeline 都在表里），
   所以 `Component.onShareTimeline` 必须存在，菜单里的「分享到朋友圈」
   才会出现。注意 babel 插件靠**具名函数表达式**识别要不要给页面加
   enableShareTimeline 配置 —— `= 某个已导入函数` 这种赋值识别不到。 */
WallPage.onShareAppMessage = wallShare;
WallPage.onShareTimeline = function onShareTimeline() {
  return wallTimelineShare();
};
