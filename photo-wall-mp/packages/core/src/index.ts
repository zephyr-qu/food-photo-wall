/* ================================================================
   @photo-wall/core · 纯逻辑层

   这一层不 import 任何 UI 框架（React / Taro / React Native 都不碰），
   只做「数据 → 数据」的转换。所以它能在小程序、H5、App 里原样复用。

   包含：
   · types/domain     数据形状（FoodRecord / LayoutTile / WallSection…）
   · records          预置数据、照片映射、日期与格式化工具、拟真生成
   · layout           4 列 masonry 布局算法（本项目最核心的部分）

   使用：
     import { layoutWall, REAL_RECORDS } from '@photo-wall/core';
   ================================================================ */

/* ---------------- 类型 ---------------- */
export type {
  FoodRecord,
  NewRecordInput,
  RecordPatch,
  TileSpan,
  LayoutTile,
  WallSection,
  WallLayout,
  CityCount,
} from './types/domain.ts';

/* ---------------- 数据与工具（纯函数） ---------------- */
export {
  PHOTO_MAP,

  /* 纯函数工具 */
  pad,
  mmdd,
  SEP,
  joinBits,
  dateOf,
  timeOf,
  hashOf,
  rngOf,
  photoOf,
  MAX_PHOTOS,
  FIELD_LIMITS,
  FIELD_LABELS,
  overLength,
  photosOf,
  pickCover,
  stampNow,
  datePart,
  timePart,
  composeAt,
  tzOffsetNow,
  todayDate,
  parseAt,
  countByCity,
  citiesInUse,
  placeOf,
} from './records.ts';

/* ---------------- 演示 / 离线兜底数据 ---------------- */
/* ⚠ 这一层夹带真实示例记录与拟真生成，不属于「纯逻辑」。
   生产接后端通常不经过它；仅本地演示 / 离线兜底回落时用。
   仍从 core 顶层导出，是为了不破坏 ui-taro / 测试既有的
   `import { REAL_RECORDS, makeOlder } from '@photo-wall/core'`。 */
export { REAL_RECORDS, makeOlder } from './demo.ts';

export type { FieldName } from './records.ts';

/* ---------------- 照片地址分类（本机 / 云 URL / 包内 / 空） ---------------- */
export type { PhotoKind } from './photo-path.ts';
export {
  isLocalFilePath,
  isRemoteUrl,
  isPackagePath,
  photoKind,
} from './photo-path.ts';

/* ---------------- 持久化判定 ---------------- */
export { resolveInitialRecords } from './persistence.ts';

/* ---------------- 城市 → 省（两级城市选择） ---------------- */
export type { ProvinceCity, ProvinceGroup } from './geo.ts';
export {
  OTHER_PROVINCE,
  CITY_PROVINCE,
  provinceOf,
  groupCitiesByProvince,
  provinceCatalogue,
} from './geo.ts';

/* ---------------- 统计 ---------------- */
export type { StatRow, RepeatedDish, WallStats } from './stats.ts';
export { computeStats, statRows, spotlightMeta } from './stats.ts';

/* ---------------- 布局算法 ---------------- */
export {
  WALL_W,
  GAP,
  COL,
  UNIT,
  HEAD_H,
  GROUP_GAP,
  DIM,
  spanFor,
  layoutGroup,
  layoutWall,
  visibleRecords,
} from './layout.ts';
