/* ================================================================
   本地兜底 + 记录缓存 —— store 的"外部记忆"。

   两块东西都是"和墙状态无关、可以单独替换"的：
     · storage：断网/冷启动时墙里的内容（F-3 离线可用）；
     · recordCache：详情页的同步首帧（先给缓存再后台刷新，避免每次进来白屏）。
   ================================================================ */
import Taro from '@tarojs/taro';
import { REAL_RECORDS, resolveInitialRecords } from '@photo-wall/core';
import type { FoodRecord } from '@photo-wall/core';
import type { ApiRecord } from '../api/types';

import { USE_REMOTE_DATA } from '../config';
import { currentUserId } from '../api/client';

/* ---------------- 本地兜底（storage） ---------------- */

/**
 * storage key 按 userId 隔离（P1-4 / P1-5）：同一设备换账号后，
 * 不能再读到上一账号缓存的 storage 记录；也不能再读到别人的预置数据。
 * 匿名（未登录）用固定键，保证匿名态自洽。
 */
function storageKey(): string {
  const uid = currentUserId();
  return `photo-wall:records:v2:${uid ?? 'anonymous'}`;
}

/**
 * 只读 storage 里的用户缓存（无值返回 `[]`）。
 *
 * **仅用于「在线模式下的离线兜底」**：断网时回放用户自己上一次成功的缓存。
 * 注意：在线模式下 `persistLocal` 不被调用（storage 永远是空的），
 * 所以断网时这里会返回 `[]` —— 也就是「离线但没本机缓存」，而不是把
 * 12 条别人的预置示例数据当用户数据回灌（这是 P1-4 修掉的老 bug）。
 */
function readLocalCache(): FoodRecord[] {
  let raw: unknown;
  try {
    raw = Taro.getStorageSync(storageKey());
  } catch {
    raw = undefined;
  }
  if (raw == null) return [];
  return Array.isArray(raw) ? (raw as FoodRecord[]) : [];
}

/**
 * 本地演示模式专用：storage 无值时回落到预置示例数据（REAL_RECORDS）。
 *
 * 与 `readLocalCache` 的区别：演示模式（`USE_REMOTE_DATA = false`）本来就是用
 * 预置数据起家的，断网兜底也要给「完整的演示墙」；而**在线模式**断网兜底
 * 绝不许把别人的示例数据塞给用户 —— 那个场景走 `readLocalCache`（返回 `[]`）。
 */
export function readStored(): FoodRecord[] {
  let raw: unknown;
  try {
    raw = Taro.getStorageSync(storageKey());
  } catch {
    raw = undefined;
  }
  return resolveInitialRecords(raw, REAL_RECORDS);
}

export function persistLocal(list: FoodRecord[]): void {
  try {
    Taro.setStorageSync(storageKey(), list);
  } catch (e) {
    console.warn('[store] 保存失败', e);
  }
}

/**
 * 离线兜底数据源（P1-4）。
 *
 *   · 在线模式（`USE_REMOTE_DATA`）断网：只回放本机缓存 `readLocalCache()`，
 *     缓存为空就返回 `[]` —— **绝不复活 12 条别人的预置示例数据**。
 *   · 纯本地演示模式（`!USE_REMOTE_DATA`）：storage 无值回落 `readStored()`
 *     （含 REAL_RECORDS），演示墙才完整。
 *
 * 凡是「`wall.offline || !USE_REMOTE_DATA`」这种混合分支都用它，
 * 这样两种模式各自拿到正确的兜底，不会把演示数据塞给在线用户。
 */
export function readOfflineSource(): FoodRecord[] {
  return USE_REMOTE_DATA ? readLocalCache() : readStored();
}
/**
 * 记录缓存（id → 接口原始 DTO）。
 *
 * 为什么存**原始 DTO** 而不是 FoodRecord：
 * FoodRecord 是渲染形状，列表用缩略图（'thumb'）、详情用原图（'full'），
 * 两者需要同一份 DTO 的不同字段。存 DTO 才能两种尺寸都用对。
 *
 * ⚠ 容量上限：这是纯内存缓存，长期滚动会把见过的每条记录都留着。
 * 超出上限就丢最老的（Map 的插入顺序 = 写入顺序，够用）。
 *
 * ⚠ 按 userId 隔离（P1-5）：换账号后绝不能读到上一账号的缓存记录，
 * 否则 `fetchRecord` 会直接返回别人的记录（404 被后台刷新静默吞掉）。
 * key 由「当前 userId + 记录 id」拼成；匿名态用固定前缀。
 */
const recordCache = new Map<string, ApiRecord>();
const RECORD_CACHE_MAX = 200;

/** 缓存键：把当前用户维度编进 id，换账号自然读不到上一账号的条目。 */
function cacheKey(id: string): string {
  return `${currentUserId() ?? 'anon'}${id}`;
}

/** 写缓存并维持容量上限 */
export function cacheRecord(id: string, rec: ApiRecord): void {
  /* 先删再写：让这条成为「最新」（Map 保持插入序） */
  recordCache.delete(cacheKey(id));
  recordCache.set(cacheKey(id), rec);
  while (recordCache.size > RECORD_CACHE_MAX) {
    const oldest = recordCache.keys().next();
    if (oldest.done) break;
    recordCache.delete(oldest.value);
  }
}

/** 读缓存（带用户隔离） */
export function getCachedRecord(id: string): ApiRecord | undefined {
  return recordCache.get(cacheKey(id));
}

/** 删缓存（带用户隔离） */
export function dropCachedRecord(id: string): void {
  recordCache.delete(cacheKey(id));
}
