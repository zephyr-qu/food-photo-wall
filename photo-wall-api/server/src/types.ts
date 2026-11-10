/** Hono 应用上下文与依赖容器类型 */
import type { Config } from './config.js';
import type { Store } from './store/store.js';
import type { AggregateService } from './services/aggregates.js';
import type { AuthService } from './services/auth.js';
import type { MaintenanceService } from './services/maintenance.js';
import type { PhotoService } from './services/photos.js';
import type { RecordService } from './services/records.js';
import type { ShopService } from './services/shops.js';
import type { UserService } from './services/users.js';

export interface AppEnv {
  Variables: {
    requestId: string;
    userId: string;
  };
}

export interface Services {
  cfg: Config;
  store: Store;
  auth: AuthService;
  records: RecordService;
  aggregates: AggregateService;
  shops: ShopService;
  photos: PhotoService;
  users: UserService;
  /** 软删/孤儿照片回收（后台任务，不在请求路径上） */
  maintenance: MaintenanceService;
}
