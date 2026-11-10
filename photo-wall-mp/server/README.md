# photo-wall mock 后端

零依赖 Node 原生 ESM mock 服务，按 `photo-wall-api/docs/api/photo-wall-api.md` 契约实现 P0 接口，供离线演示 / 前端联调 / 自动化测试。

> 默认跑 **8788**，不是前端连的真后端（8787）。新用户会灌 101 条演示数据（`SEED_NEW_USERS=1`，契约 AC-01 要求 0 条）。

- **端口**：`8788`，用 `PORT` 覆盖
- **依赖**：只用 `node:` 内置模块
- **数据**：全内存，退出即清空；`resetStore()` 重置回种子态

## 启动

```bash
npm run server             # 仓库根目录
node server/src/index.js   # 或直接跑
PORT=9000 npm run server   # 换端口
```

### 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `8788` | 监听端口 |
| `HOST` | `127.0.0.1` | 监听地址（真机联调设 `0.0.0.0`） |
| `RATE_LIMIT` | `0`（关） | 每用户每分钟请求数；>0 时超限 429 + `Retry-After` |
| `MOCK_QUIET` | — | 设 `1` 关请求日志 |
| `SEED_NEW_USERS` | `1` | 新用户注册是否灌示例数据；`0` = 空墙 |
| `DEMO_SEED` | `1` | 契约 12 条之上再灌 89 条演示数据（共 101 条）；`0` = 只播 12 条 |

## 联调速查

固定 token `dev-access-token` 指向种子用户，不必登录：

```bash
curl http://127.0.0.1:8788/healthz
curl -H 'Authorization: Bearer dev-access-token' 'http://127.0.0.1:8788/v1/records?limit=2'
```

换新账号（空数据）：

```bash
curl -X POST http://127.0.0.1:8788/v1/auth/wechat/login \
  -H 'Content-Type: application/json' -d '{"code":"dev-1"}'
```

`code` 一次性（AC-02）：同一 `code` 第二次返回 `401 WECHAT_CODE_INVALID`。H5 用 `POST /v1/auth/anonymous`（`deviceId` 幂等）。

## 端点

路径均相对 `/v1`（`/healthz` 在根路径）。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/healthz` | 健康检查（无鉴权） |
| POST | `/auth/wechat/login` | 微信静默登录（任意 code 成功，一次性） |
| POST | `/auth/anonymous` | 匿名设备登录（deviceId 幂等） |
| POST | `/auth/refresh` | 刷新 token（轮换） |
| GET | `/me` | 当前用户与记录数 |
| GET | `/records` | 列表：`limit`(1-50，默认 10) / `cursor` / `city` / `cityMissing` / `province` / `shopId` / `q` |
| GET | `/records/random` | 随机一道：`city` / `cityMissing` / `province` / `excludeId` |
| GET | `/records/cities` | 全量城市计数 + 省分组 |
| GET | `/records/months` | 月份桶（按 `at` 归桶，非 UTC） |
| GET | `/records/{id}` | 单条 |
| POST | `/records` | 新建（`Idempotency-Key` / `clientRequestId`） |
| PATCH | `/records/{id}` | 局部更新（`If-Match`） |
| DELETE | `/records/{id}` | 软删、幂等 204 |
| POST | `/records/{id}/restore` | 撤销删除 |
| GET | `/stats` | 墙统计六行数字 |
| GET | `/shops/by-name` | 按店名聚合（`name` / `city`） |
| GET | `/shops/{shopId}` | 按店铺 id 聚合 |
| POST | `/photos` | 上传（multipart，字段 `file`，≤10 MiB，jpeg/png/webp） |
| DELETE | `/photos/{photoId}` | 删除（被引用 → 409） |
| GET | `/files/{photoId}.{ext}` | 取回图片字节（`.orig` / 原尺寸 / `-400`） |
| GET | `/geo/cities` | 城市字典（34 省 / 208 城，带 ETag） |

**路由注册顺序**：`/records/random|cities|months` 在 `/records/{id}` 之前；`/shops/by-name` 在 `/shops/{shopId}` 之前。

## 数据重置

内存 store 是模块级单例：

```js
import { resetStore } from '../src/store.js';
resetStore();                          // 回到 101 条种子态
resetStore({ seed: false });           // 清空
resetStore({ seedNewUsers: false });   // 新用户不灌示例数据
resetStore({ demo: false });           // 只播契约 12 条
```

测试用 `beforeEach(() => resetStore())` 隔离。

## 测试

```bash
cd server && npm test    # 或仓库根 npm run server:test
```

`node:test` + `fetch`，89 条用例：`records`（分页/游标/CRUD/幂等/校验）· `aggregate`（计数/统计/随机/店铺/月份）· `auth`（登录/刷新/`/me`/种子一致性）· `photos`（multipart/大小/类型/审核/引用）· `misc`（CORS/路由顺序/错误体/缓存头）· `seed-new-user`（新用户示例数据）。

## 目录

```
server/
├── scripts/   数据生成
├── src/       服务代码（data/ 自动生成，勿手改）
└── test/      用例
```

## 种子数据

种子 = 契约 12 条 + 演示 89 条 = 101 条（`DEMO_SEED=0` 时 12 条）。

- **契约层**：`packages/core/src/records.ts` 的 `REAL_RECORDS` 逐字保留，`photo` 一律 `null`；id 由脚本确定性生成（`rec_<ULID>`），重启不变。
- **演示层**：`src/data/demo-records.js`（手写），89 条跨 12 个月、33 城，覆盖翻页、月份分组、反复吃、表外城市、未记城市、`rating=0`、长 note。
- **新用户示例数据**：创建新用户时自动灌全部种子（`SEED_NEW_USERS=0` 关）；id 按用户维度生成，不跨用户共享；已存在用户不重复灌。

数据由脚本生成，不直接 import core 的 `.ts`。改了 core 数据后重跑 `node server/scripts/gen-seed-data.mjs`（会校验 12 条 / 208 城 / 34 省）。

## mock 与真实后端的差异

- **存储**：内存 Map，不持久化；重启回到种子态。
- **微信登录**：不调 `jscode2session`，任意 code 成功；openid 由 code 派生。
- **示例数据**：新用户自动灌 101 条。
- **照片**：不做 EXIF / 缩放 / 对象存储；字节原样存内存，`-400` 后缀回原图。
- **内容安全**：不接 `imgSecCheck`；请求头 `X-Mock-Reject-Image: 1` 模拟拒绝（`422 IMAGE_REJECTED`）。
- **限流**：默认关闭（`RATE_LIMIT=0`）。
