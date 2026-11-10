/* ================================================================
   领域类型定义（唯一真实来源）

   迁移前这些形状散落在 JSDoc 注释里（records.js 顶部有 @typedef），
   现在收敛到这里，让 data/ 的纯逻辑和页面都能共享同一份契约。

   ⚠ 刻意保持宽松：strictNullChecks 关闭中，先以「描述数据形状」为目标，
   不追求把每个 null 都逼出来。等迁移稳定后再逐项收紧。
   ================================================================ */

/** 一条「吃过的东西」记录 */
export interface FoodRecord {
  id: string;
  /** 菜名，必填 */
  eat: string;
  shop?: string | null;
  city?: string | null;
  district?: string | null;
  /** 0 表示未评分，1-5 为星级 */
  rating: number;
  /** 形如 2026-10-09T12:30（本地时间，无时区） */
  at: string;
  note?: string | null;
  /** 用户自选照片的持久路径（saveFile 产物或静态路径）；null/undefined 回落预置图 */
  photo?: string | null;
  /** 全部照片（有序，0..5）。null/undefined/空 = 用预置配图。
   *
   *  为什么单开一个字段而不用 photo 装数组：photo 是**封面**（= photos[0]），
   *  很多地方（分享卡片、列表封面）只需要它，形状不能变。 */
  photos?: string[] | null;
  /** 与 photos **一一对应**的服务端 photoId（没有就是 null）。
   *
   *  为什么要有它：编辑一条记录时，没换过的照片必须把原来的 photoId 原样
   *  带回去（PATCH 是整体替换，带不回去等于清空）。可 photo 里只有 URL，
   *  拿不回 id，所以两个字段并行存。 */
  photoIds?: (string | null)[] | null;
  /** 乐观锁版本号（服务端每条记录自增）。
   *
   *  为什么要有它：PATCH 时作为 `If-Match` 发出，服务端校验「我发给你的版本
   *  与你基于的版本一致」才允许写入，否则返回 412（PRECONDITION_FAILED）。
   *  没有它，两条并发编辑会静默覆盖（后写覆盖先写）。前端只读不改。 */
  version?: number;
}

/** 新增记录时的入参：id 和 at 由 store 生成 */
export type NewRecordInput = Omit<FoodRecord, 'id' | 'at'>;

/** 更新记录时的入参：任意字段可选 */
export type RecordPatch = Partial<Omit<FoodRecord, 'id'>>;

/** 块型：决定这一格占几列几行。
 *  与原型 photo-wall-h5 保持一致：只有这四种，没有 full。 */
export type TileSpan = 'hero' | 'wide' | 'tall' | 'small';

/** 布局算出来的一个绝对定位块（单位全部是 rpx） */
export interface LayoutTile {
  record: FoodRecord;
  span: TileSpan;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 墙上的一段：showDate 时按月分组，否则只有一个无标题段 */
export interface WallSection {
  key: string | null;
  label?: string;
  count?: number;
  tiles: LayoutTile[];
  height: number;
  top: number;
}

/** layoutWall 的返回 */
export interface WallLayout {
  sections: WallSection[];
  totalHeight: number;
}

/** 城市统计的一行：[城市名（空串表示未记）, 数量] */
export type CityCount = [string, number];
