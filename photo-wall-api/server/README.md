# 照片墙后端 · Hono 实现

按 [`docs/api/photo-wall-api.md`](../docs/api/photo-wall-api.md) 契约实现的接口服务端。

- **Hono 4** + `@hono/node-server` + **zod** + tsx，Node ≥ 20
- 102 个测试覆盖 AC-01 ~ AC-38
- 默认纯内存即可运行；单机生产用 **better-sqlite3**。如需换用 Postgres，实现 `Store` 接口即可，路由层无需改动

## 快速开始

```bash
cd server
npm install
npm run dev            # http://localhost:8787/v1
npm test               # 102 个测试
npm run seed           # 造一个带 12 条示例记录的演示账号并打印 token
npm run build          # 编译到 dist/（NodeNext/ESM）
node dist/src/index.js # 生产启动（tsx 仅开发用）
```

启动后：`/v1/healthz` 健康检查 · `/v1/docs` Swagger UI · `/v1/openapi.yaml` 契约原文 · `/v1/geo/cities` 城市字典。

```bash
B=http://localhost:8787/v1
TOKEN=$(curl -s -X POST $B/auth/anonymous -H 'Content-Type: application/json' \
  -d '{"deviceId":"demo-device"}' | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).accessToken')

curl -s -H "Authorization: Bearer $TOKEN" "$B/records?limit=3"
curl -s -H "Authorization: Bearer $TOKEN" "$B/stats"
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"eat":"冒烤鸭","city":"成都","rating":5}' $B/records
```

`npm run seed` 默认写 SQLite（`var/db.sqlite`）。删除该文件即从空库开始。

## 目录结构

```
src/         入口、配置、路由、服务、store、lib、data
test/        用例
scripts/     数据生成、演示账号
db/          schema.sql
```

`src/data/*.ts` 由 `npm run gen-data` 从 `photo-wall-mp/packages/core/src` 抽取，和前端逐字一致。core 不在标准位置时，用 `PHOTO_WALL_SRC` 指定目录。

## 实现取舍

下面这些都是有意为之的简化，上生产前按注释替换：

1. **存储默认纯内存**，重启即丢，只为测试和本地零配置联调。单机生产用 `STORAGE=sqlite`（`better-sqlite3`，单文件、ACID），库文件必须落在持久卷上；并发写是单写者。跨表写入不是原子的，靠 `INSERT ... ON CONFLICT` 加应用层回收缓解。
2. **照片不做图像处理**：`url / photo / photoThumb` 指向同一个文件（`/v1/files/<id>.<ext>`）。生产按契约生成 `1080w` / `400w` 三档，放 CDN。
3. **微信登录留了开发模式**：没配 `WECHAT_APPID/SECRET` 时 `openid = dev:<code>`，完全不碰微信；配了就调真实 `jscode2session`，`session_key` 不下发。
4. **内容安全只做到接缝**：`IMAGE_CHECK_ENABLED=true` 且凭据配置齐全时才调用真实审核，否则上传一律 `approved`。真审核同步调 `wxa/img_sec_check`（上限 1MB），微信不可达、超时、判定违规一律 fail-closed。另外，这个接口已经从官方文档目录里移除了，有下线风险。
5. **`createdAt/updatedAt` 带毫秒**，因为 AC-17 要求同秒内编辑能看出 `updatedAt` 变化；`eatenAtUtc` 仍是整分钟。
6. **`/records/months` 的 `firstCursor` 是“该月最新一条”**。keyset 严格 `<`，用它翻页会跳过该月第一条，跳月请用 `from/to` 整月区间。
7. **限流是单进程内存滑动窗口**（`middleware/rate-limit.ts`）。
8. **`/shops/by-name` 传 `city` 时同时收窄记录**，用来做同名跨城消歧。
9. **`q`（菜名模糊搜索，P2）已实现**：大小写不敏感子串。

**微信 code 是一次性的**（AC-02）。开发模式默认允许复用，`STRICT_WECHAT_CODES=true` 才严格——测试即通过该开关覆盖 AC-02。

## 换 PostgreSQL

1. `psql $DATABASE_URL -f db/schema.sql`
2. 实现 `src/store/store.ts` 的 `Store` 接口（约 20 个方法），注入 `new PostgresStore(pool)`。

聚合查询下沉到 SQL（`db/schema.sql` 末尾有参考语句）；`/records` 的 keyset 分页用索引 `(user_id, eaten_at_utc desc, id desc)`。`Store` 用 `number`（epoch ms）表示时间，Postgres 用 `timestamptz`，转换放在适配器里。

## 部署

- HTTPS 终结在反代（Nginx/Caddy）上，`PUBLIC_BASE_URL` 填对外域名——主机根，不含 `/v1`。
- `JWT_SECRET` 必须换掉（32 字节随机）。仍为默认值时会打印警告。
- 照片：`STORAGE_DIR` 换成对象存储挂载或直传 CDN；小程序那边要把域名加入 `uploadFile` / `downloadFile` 合法域名。
- `STORAGE=sqlite` 时 `SQLITE_FILE` 必须落在持久卷。
- 日志：未捕获异常打 `[unhandled]`，接入结构化日志时需保留 `requestId`。
- `NODE_ENV=production` 启动自检会直接拒绝：默认 JWT 密钥、缺微信凭据、没开 `STRICT_WECHAT_CODES`。

## 已知限制

- 无图片处理（不缩放、不转码 EXIF），`width/height` 读原图。
- 后台回收任务（`services/maintenance.ts`，启动时跑一次加每小时一次）清理过期的软删记录，以及没被引用的软删照片。
- 过期幂等键只做懒清理，没有独立清扫任务。
- 无增量同步/推送：前端写完重拉列表、计数、统计（契约 §7.4）。
- 限流是单进程内存计数，重启清零。

## 环境变量

完整列表见 [`.env.example`](./.env.example)。常用的：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `8787` | 监听端口 |
| `JWT_SECRET` | dev 值 | 生产必改 |
| `STORAGE` | `memory` | `sqlite` = 单文件持久 |
| `SQLITE_FILE` | `var/db.sqlite` | `STORAGE=sqlite` 时的库文件 |
| `SEED_DEMO_RECORDS` | `false` | 新用户注入 12 条示例 |
| `PUBLIC_BASE_URL` | `http://localhost:8787` | 照片 URL 前缀（主机根） |
| `TRUST_PROXY` | `false` | 是否在反向代理后 |

### 限流的分组依据

| `TRUST_PROXY` | 未登录请求的 key | 适用场景 |
| --- | --- | --- |
| `false`（默认） | TCP 对端 IP（`getConnInfo`） | 直连公网 |
| `true` | `X-Forwarded-For` 的**最右一跳** | 部署在 Nginx/Caddy 后 |

> 最左一跳由客户端编造，不可信，所以取最右。反过来，直连公网却设 `TRUST_PROXY=true`，等于开了个绕过口子。已登录请求按 `userId` 分组。
