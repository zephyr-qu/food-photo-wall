/* ================================================================
   写操作：新建 / 编辑 / 删除 / 撤销删除。

   这一层的三条约束（都来自实际踩过的坑）：
     · 离线时**直接拒绝**（OfflineWriteError），不做本地排队 —— 没有"待同步"
       队列，假装成功会让用户以为贴上去了；
     · 删除是**乐观**的：先摘卡片，失败再回滚（成功后 dirty=true，切页回来
       一定重拉，否则本地删除会被服务端旧数据盖回来）；
     · 版本用 `If-Match`：knownVersion 优先取调用方传的，其次取详情缓存，
       不传就不带 —— 宁可少拦一次冲突，也不要用错版本把别人的改动覆盖掉。
   ================================================================ */
import { USE_REMOTE_DATA } from '../config';
import { createRecord, deleteRecordApi, patchRecord, restoreRecord } from '../api';
import type { FoodRecord, NewRecordInput, RecordPatch } from '@photo-wall/core';

import { emitWall, freshness, wall } from './store-state.ts';
import { cacheRecord, dropCachedRecord, getCachedRecord, persistLocal, readStored } from './store-cache.ts';
import { OfflineWriteError, idempotencyKey, stampNowLocal } from './store-errors.ts';
import { refreshAll } from './store-refresh.ts';
import { loadAggregates } from './store-aggregates.ts';
import { loadFirstPage } from './store-paging.ts';
import { toCreateInput, toFoodRecord, toPatchInput } from './adapters';

/**
 * 离线时禁止写：明确报错，绝不"假成功"。
 *
 * 以前这里会造一条 `id: 'local_' + Date.now()` 的记录，只写 storage 并当场
 * 塞进墙里，然后给用户"贴上了"的 toast。问题在于：
 *   · 全仓**没有回传队列**（grep `local_` 只有这一处生成），这条记录永远
 *     上不去服务端；
 *   · 一旦联网，`loadFirstPage` 用服务端首页整体替换 `records`，它当场消失。
 * 用户视角就是"我明明贴上去了，怎么没了"。
 *
 * 取舍：宁可在点「贴上去」时告诉他"现在没网，先别贴"，也不要给一个
 * 五分钟后自己消失的假记录。要做离线队列（outbox）是另一个量级的工程
 * （冲突合并、幂等重放、照片补传），不在本次范围。
 *
 * 注意：**只读**在离线时仍然可用（走 storage 缓存 + 顶部「离线」角标），
 * 那个场景是有意义的降级。
 */
function assertWritableOnline(): void {
  if (!USE_REMOTE_DATA) return; // 纯本地演示模式：本来就没有服务端，允许写
  if (wall.offline) {
    throw new OfflineWriteError();
  }
}

/** 新建一条。返回新记录（纯本地演示模式下返回本地生成的对象）。
 *
 *  照片走 opts.photoIds（有序的服务端 photoId 列表）：
 *  input 里的 photos/photoIds 只是渲染形状，真正写进接口的是 photoIds。 */
export async function addRecord(
  input: NewRecordInput,
  opts: { photoIds?: string[] | null; at?: string; tzOffset?: string } = {},
): Promise<FoodRecord> {
  assertWritableOnline();

  if (!USE_REMOTE_DATA) {
    const rec: FoodRecord = {
      id: 'local_' + Date.now(),
      eat: input.eat,
      shop: input.shop || null,
      city: input.city || null,
      district: input.district || null,
      rating: input.rating || 0,
      at: opts.at || stampNowLocal(),
      note: input.note || null,
      photo: input.photo || null,
      photos: input.photos || null,
    };
    const local = [rec, ...readStored()];
    persistLocal(local);
    emitWall({ records: [rec, ...wall.records], total: wall.total + 1 });
    return rec;
  }

  const created = await createRecord(
    /* POST 的 photoIds 统一发数组：空数组 = 明确「这张没有自定义照片」，
       语义与缺省等价，但发出来更直白（服务端不用猜）。 */
    toCreateInput(input, opts.photoIds ?? [], opts.at, opts.tzOffset),
    idempotencyKey(),
  );
  await refreshAll();
  return toFoodRecord(created, 'full');
}

/** 更新一条（编辑）。离线时禁止（理由同 assertWritableOnline）。 */
export async function updateRecord(
  id: string,
  patch: RecordPatch,
  opts: { photoIds?: string[] | null; tzOffset?: string; version?: number } = {},
): Promise<FoodRecord | null> {
  assertWritableOnline();

  if (!USE_REMOTE_DATA) {
    const local = readStored().map((r) => (r.id === id ? { ...r, ...patch } : r));
    persistLocal(local);
    emitWall({ records: wall.records.map((r) => (r.id === id ? { ...r, ...patch } : r)) });
    return local.find((r) => r.id === id) || null;
  }

  /* 乐观锁：If-Match 必须是「用户编辑所基于的那个版本」，不能是「缓存里最新的版本」。
     缓存是 stale-while-revalidate 的写侧：表单读到 v1 的同时，后台 getRecord 可能
     已经把缓存写成 v2。若这里取 v2，服务端会放行一份 v1 时代的表单，把别人在 v2
     上的修改整份覆盖掉（P1-4）。所以优先用页面回填时记下的版本快照；
     拿不到（理论上不会）才退回缓存版本，服务端仍会做一致性校验。 */
  const knownVersion = opts.version ?? getCachedRecord(id)?.version;

  const updated = await patchRecord(
    id,
    toPatchInput(patch, opts.photoIds, opts.tzOffset),
    knownVersion,
  );
  /* 写操作立刻更新缓存：否则详情页会从缓存里读到**改之前**的旧内容
     （缓存是 stale-while-revalidate，读的时候先给缓存里的旧值）。 */
  cacheRecord(id, updated);
  await refreshAll();
  return toFoodRecord(updated, 'full');
}

/**
 * 删除一条：**软删 + 可撤销**（对齐原型「无确认 + 5s 撤销」）。
 *
 * 语义变化（相对之前"二次确认 → 永久删"）：
 *   · 立即从墙上移除（乐观），不等服务端；
 *   · 服务端是软删（`deletedAt`），30 天内可 `restore`；
 *   · 页面拿到返回值后弹 5 秒「撤销」，用户点了就调 `undoDelete`。
 *
 * 为什么乐观移除：原型的设计主张是"删错了能救回来"，而不是"先拦你一道"。
 * 二次确认把成本压在每次删除上，撤销只在真删错时付出 —— 后者体验更好。
 *
 * 注意：照片**不在这里回收**。软删期间 restorable，照片必须留着；
 * 硬删/过期回收交给服务端后台任务（前端不猜）。
 */
export async function deleteRecord(id: string): Promise<boolean> {
  assertWritableOnline();

  if (!USE_REMOTE_DATA) {
    const local = readStored().filter((r) => r.id !== id);
    persistLocal(local);
    emitWall({ records: wall.records.filter((r) => r.id !== id), total: wall.total - 1 });
    return true;
  }

  /* 先乐观移除（用户立刻看到结果），失败再回滚 */
  const snapshot = wall.records;
  const snapshotTotal = wall.total;
  emitWall({ records: snapshot.filter((r) => r.id !== id), total: snapshotTotal - 1 });

  try {
    await deleteRecordApi(id);
    /* 缓存里这条已经不存在了：删掉，否则详情页会从缓存里读到一条已删的记录
       （缓存是 stale-while-revalidate，先给缓存值）。 */
    dropCachedRecord(id);
  } catch (e) {
    /* 回滚：把墙恢复原样，否则用户会以为删掉了、其实没删 */
    emitWall({ records: snapshot, total: snapshotTotal });
    throw e;
  }

  /* 后台刷新（不 await）：墙已经乐观更新，不必让用户等三个接口。
     失败也不回滚 —— 删除已经成功了，刷新失败只是数字暂时不准。 */
  freshness.dirty = true; // P1-7b：刚删除过，下次 onShow 即便在冷却期内也要强制对齐一次
  void Promise.all([loadFirstPage({ keepRecords: true }), loadAggregates()]).catch(() => {
    /* 静默：下次 onShow 的 refreshIfStale（dirty=true）会补上 */
  });
  return true;
}

/**
 * 撤销删除：把记录恢复回墙（调 `POST /records/{id}/restore`）。
 *
 * 失败要**明确告诉用户**（尤其 410 GONE = 超过撤销窗口）：
 * 这时候记录已不可恢复，沉默会让人以为撤销成功了。
 */
export async function undoDelete(id: string): Promise<boolean> {
  if (!USE_REMOTE_DATA) {
    /* 本地模式：删除是真删（storage 里已经没了），撤销无从恢复 */
    return false;
  }
  /* 恢复本身失败必须往上抛：详情页 onUndo 靠 catch 弹「超过撤销期限 /
     恢复失败」的明确文案，沉默会让人以为恢复成功了（P1 口径）。 */
  await restoreRecord(id);
  freshness.dirty = true; // P1-7b：恢复后同样强制下次对齐

  /* 后续刷新失败不回抛：记录已经恢复成功，刷新失败只是数字暂时不准 ——
     原来整个 try 包在一起 throw，恢复其实成功了却弹「恢复失败」+ 自动返回，
     是误报。freshness.dirty=true 保证下次 onShow 的 refreshIfStale 补上；
     直接 catch 后什么都不做也被 lint 的 no-useless-catch 拦。 */
  await Promise.all([loadFirstPage({ keepRecords: true }), loadAggregates()]).catch(() => {
    /* 静默：见上 */
  });
  return true;
}
