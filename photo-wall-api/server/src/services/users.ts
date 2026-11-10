/** 用户服务：GET /me（§6.1.4） */
import type { Store } from '../store/store.js';
import { err } from '../lib/errors.js';
import { formatUtcIso } from '../lib/time.js';
import { sortedDesc } from '../lib/cursor.js';

export interface MeDto {
  id: string;
  createdAt: string;
  recordCount: number;
  photoCount: number;
  lastRecordAt: string | null;
}

export class UserService {
  constructor(private readonly store: Store) {}

  me(userId: string): MeDto {
    const user = this.store.getUser(userId);
    if (!user) throw err.notFound('用户不存在');

    const records = sortedDesc(this.store.listRecords(userId));
    const photos = this.store.listPhotos(userId);

    return {
      id: user.id,
      createdAt: formatUtcIso(user.createdAt),
      recordCount: records.length,
      photoCount: photos.length,
      lastRecordAt: records.length ? (records[0] as { atLocal: string }).atLocal : null,
    };
  }
}
