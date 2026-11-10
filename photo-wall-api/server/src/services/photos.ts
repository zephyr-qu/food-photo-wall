/**
 * 照片服务：POST /photos（multipart）与 DELETE /photos/{photoId}。
 *
 * 说明：本实现把原图落盘并用同一 URL 充当三种尺寸（不做图像处理，零原生依赖）。
 * 生产部署按契约 §6.5.1 换成「对象存储 + 图片处理 + CDN」三档 URL 即可，
 * 数据库字段（url / photo_url / thumb_url）已经预留。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Config } from '../config.js';
import { err } from '../lib/errors.js';
import { readImageInfo, sniffMime } from '../lib/image.js';
import { newId } from '../lib/ids.js';
import { nowMs } from '../lib/time.js';
import { WechatSecCheck } from '../lib/wechat-sec-check.js';
import type { Store } from '../store/store.js';
import type { PhotoRow } from '../store/types.js';
import { toPhotoDto, type PhotoDto } from '../lib/dto.js';

const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp']);

export class PhotoService {
  private readonly secCheck: WechatSecCheck;

  constructor(
    private readonly store: Store,
    private readonly cfg: Config,
  ) {
    this.secCheck = new WechatSecCheck(cfg);
  }

  async upload(userId: string, file: File): Promise<PhotoDto> {
    if (!file || typeof file.arrayBuffer !== 'function') throw err.badRequest('缺少 file 字段');
    if (file.size > this.cfg.photoMaxBytes) throw err.fileTooLarge();

    const buf = Buffer.from(await file.arrayBuffer());
    if (buf.length > this.cfg.photoMaxBytes) throw err.fileTooLarge();

    // 1) 类型判定：先看 magic bytes，不认识 → 415（不是 jpeg/png/webp）
    const mime = sniffMime(buf);
    if (!mime) throw err.unsupportedMedia('仅支持 jpeg / png / webp');
    if (!ALLOWED.has(mime)) throw err.unsupportedMedia('暂不支持 gif，请用 jpeg / png / webp');

    // 2) 能被识别但结构损坏 → 422（内容不合格，换一张）
    const info = readImageInfo(buf);
    if (!info) throw err.imageRejected('图片无法解析，请换一张');

    // 内容安全：真调微信 img_sec_check；未开启时明确放行（见 lib/wechat-sec-check.ts）
    const verdict = await this.secCheck.check(buf, info.mime);
    if (!verdict.approved) throw err.imageRejected(verdict.reason);

    const id = newId('pho');
    const filename = `${id}.${info.ext}`;
    const dir = this.cfg.storageDir;
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, filename), buf);

    // 照片经 API 自身托管（/v1/files/...）；生产改成 CDN 域名即可
    const base = `${this.cfg.publicBaseUrl}/v1/files/${filename}`;
    const row: PhotoRow = {
      id,
      userId,
      url: base,
      photoUrl: base,
      thumbUrl: base,
      width: info.width,
      height: info.height,
      size: buf.length,
      mime: info.mime,
      status: 'approved',
      createdAt: nowMs(),
      deletedAt: null,
    };
    this.store.insertPhoto(row);
    return toPhotoDto(row);
  }

  remove(userId: string, photoId: string): void {
    const photo = this.store.getPhoto(photoId);
    if (!photo || photo.userId !== userId || photo.deletedAt !== null) {
      throw err.notFound('照片不存在');
    }
    /* 被引用判定：出现在**任意**未删除记录的**任意一张**照片里就算被占用。
       一条记录可以挂 5 张图，所以不能只看老的那一个 photoId —— 漏判会让
       正在展示的图被物理删掉，前端直接裂图。 */
    const referenced = this.store
      .listRecords(userId)
      .some((r) => r.photoIds.includes(photoId));
    if (referenced) throw err.photoInUse();
    photo.deletedAt = nowMs();
    this.store.updatePhoto(photo);
  }

}
