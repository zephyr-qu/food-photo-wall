/**
 * 维护任务：软删记录 / 孤儿照片的定期回收。
 *
 * 为什么必须有它：
 *   · 删除是**软删**（`deletedAt`），为了支持"5 秒撤销"和"30 天内可恢复"。
 *     但软删的数据一直留在库里：用户删 1000 条，库里仍是 1000 条；
 *   · 照片更明显 —— `var/uploads` 里的文件只有在"记录彻底消失"后才该删，
 *     否则撤销恢复时图就没了。不回收的话磁盘只增不减。
 *
 * 设计：
 *   · **不在请求路径上**：回收是后台任务（启动一次 + 每小时一次），
 *     绝不因为用户点删除就同步跑一遍全表扫描；
 *   · **保留期 = restoreWindowDays**：撤销窗口内绝不能删，否则
 *     `POST /records/{id}/restore` 会失败；
 *   · **先库后盘**：先让 store 删记录/照片行，再按返回的 photoId 删磁盘文件。
 *     反过来做的话，中途崩溃会留下"库里有行、盘上没文件"的坏数据；
 *   · 失败不抛（定时任务里抛异常会打断后续调度），只记日志。
 */
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { Config } from '../config.js';
import type { Store } from '../store/store.js';

export interface PurgeResult {
  records: number;
  photos: number;
  files: number;
  /** 删文件时的失败数（文件已不存在不算失败） */
  fileErrors: number;
}

export class MaintenanceService {
  constructor(
    private readonly store: Store,
    private readonly cfg: Config,
  ) {}

  /**
   * 执行一次回收。
   * @param retentionDays 覆盖保留期（默认取 cfg.restoreWindowDays）
   */
  async purge(retentionDays = this.cfg.restoreWindowDays): Promise<PurgeResult> {
    /* 1) 先收集"即将被删的照片文件名" —— store 删完就拿不到了。
          照片文件名约定是 `<photoId>.<ext>`（见 PhotoService.upload），
          所以这里从 photoId 反推目录下的文件；用一个宽松的 glob 更稳，
          但零依赖环境下按已知扩展名尝试即可。 */
    const candidates = this.store
      .listAllPhotos?.()
      ?.filter((p) => p.deletedAt !== null)
      .map((p) => p.id) ?? [];
    /* 2) 库里回收 */
    const { records, photos } = this.store.purgeSoftDeleted(retentionDays);

    /* 3) 盘上回收：只删"确实已从库里移除"的照片文件。
          注意 candidates 是回收前的快照，可能包含"仍被引用所以没删"的，
          所以要再查一次库里是否还有这行。 */
    let files = 0;
    let fileErrors = 0;
    for (const id of candidates) {
      if (this.store.getPhoto(id)) continue; // 还在库里 = 仍被引用，不能删文件
      for (const ext of ['jpg', 'png', 'webp', 'gif']) {
        const p = join(this.cfg.storageDir, `${id}.${ext}`);
        try {
          await unlink(p);
          files += 1;
          break; // 一张照片只会有一个扩展名
        } catch (e) {
          const code = (e as NodeJS.ErrnoException).code;
          if (code !== 'ENOENT') fileErrors += 1;
        }
      }
    }

    return { records, photos, files, fileErrors };
  }

  /**
   * 启动定时回收：立即跑一次（清掉上次进程留下的过期数据），之后每小时一次。
   *
   * @returns 停止函数（测试/优雅退出时调用）
   */
  start(intervalMs = 60 * 60 * 1000): () => void {
    const run = async (): Promise<void> => {
      try {
        const r = await this.purge();
        if (r.records || r.photos || r.files) {
          console.log(
            `[maintenance] 回收：记录 ${r.records} / 照片行 ${r.photos} / 文件 ${r.files}` +
              (r.fileErrors ? `（${r.fileErrors} 个文件删除失败）` : ''),
          );
        }
      } catch (e) {
        /* 定时任务里不抛：抛了会打断后续调度 */
        console.error('[maintenance] 回收失败', e);
      }
    };

    void run(); // 启动即跑一次
    const timer = setInterval(() => void run(), intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }
}
