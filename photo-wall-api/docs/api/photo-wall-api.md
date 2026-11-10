# X师傅美食记 · 照片墙 —— 后端接口文档

> 机器可读契约：[openapi.yaml](./openapi.yaml)（冲突时以本文件文字口径为准）
> 验收用例：[acceptance.md](./acceptance.md)

---

## 0. 一屏速览

| 内容 | 章节 |
| --- | --- |
| 接口总表与优先级 | [§5](#5-接口总表)（23 个接口） |
| 逐接口请求 / 响应 / 错误码 | [§6](#6-接口详情) |
| 机器可读契约 | [openapi.yaml](./openapi.yaml) |
| 验收用例 | [acceptance.md](./acceptance.md)（AC-01 ~ AC-38） |
| 字段契约与设计约束 | [§2](#2-接口设计约束)、[§3](#3-通用约定)、[§4](#4-资源模型) |

**三个最容易踩的契约坑**（详见 §2.4）：

1. `at` 必须是 `YYYY-MM-DDTHH:mm` 本地墙钟串，不带时区、不带秒 —— 多一个 `Z` 或 `+08:00` 就会排序错 / 解析崩。
2. `id` 不透明，不要生成 `g..._...` 形态（前端会当成"本地伪造记录"不落盘）。
3. `photo = null` = 用预置配图；`shop/city/district/note = null` = 未记，不能用空串。

---

## 1. 文档约定

- 所有字段名使用 `lowerCamelCase`；传输格式 UTF-8 JSON（上传接口除外）。
- `null` 与"字段缺失"在本接口中**语义相同**：一律视为"未记"；服务端必须把空串 `""` 归一为 `null` 后再入库/返回。
- 示例中的 `https://api.xshifu.example.com/v1` 与 CDN 域名为占位；实际域名由部署环境决定（小程序需在后台配置 `request` / `uploadFile` / `downloadFile` 合法域名）。
- 文中标注「前端调用点」的 `文件:行号` 均相对 `photo-wall-mp/packages/ui-taro/src`，用于后端核对语义，不是要求后端改前端；行号为 2026-10 快照，可能已随重构漂移。
- 版本策略：路径带 `/v1`；破坏性变更升 `/v2`；新增可选字段/接口不算破坏性变更。

---

## 2. 接口设计约束

### 2.1 数据归属与生成

| 字段 | 由谁生成 | 约束 |
| --- | --- | --- |
| `id` | **服务端** | 前端只当不透明串做等值匹配；禁止 `g<数字>_<数字>` 形态（见 §2.4 ②） |
| `at` | **客户端传值，服务端校验并保存** | "什么时候吃的"是用户主观事实；格式见 §2.4 ①，服务端另存 UTC instant 用于排序 |
| `eat` | 客户端 | 服务端必填校验（trim 后非空），唯一必填项 |
| `shop` / `city` / `district` / `note` | 客户端 | 空串一律归一为 `null`；`city` 可为表外手填值，服务端**不得**因不在字典里而拒绝 |
| `rating` | 客户端 | 服务端校验 `integer 0..5`；`0` = 未评，不是"零分" |
| `photo` / `photos` | 服务端（`POST /photos` 产生） | 对外恒为 https URL；前端 `photoOf()` 原样取用 |
| `createdAt` / `updatedAt` / `version` | 服务端 | 前端不写；用于审计、冲突检测（`If-Match`） |
| `shopId` | 服务端（店铺表） | 前端可用店名查询过渡，接入后走 `shopId` |

### 2.2 核心口径

- **排序**：列表按"吃的时间"倒序，以 `eatenAtUtc` 为准、`id` 兜底不重不漏；游标分页见 §6.2.1。
- **分页**：每页默认 10 条，响应带显式 `hasMore`；分页后客户端不再持有全量数据。
- **城市筛选**：`null` = 全部、`cityMissing` = 未记、城市名 = 精确匹配（见 §6.2.1）。
- **聚合口径**：`/stats` 与 `/records/cities` 默认**全量**（不吃城市筛选）；`/records/random` 从当前筛选池抽、支持 `excludeId`。
- **幂等与并发**：写操作支持 `Idempotency-Key`；更新用 `version` + `If-Match` 防覆盖。
- **错误与空值**：错误码见 §3.3；`null` / 缺失 / `""` 语义见 §2.4 ③。

### 2.3 职责划分（什么留在客户端）

| 数据/能力 | 归属 | 理由 |
| --- | --- | --- |
| 记录、照片、用户 | 后端 | 换机、分享、多端的前提 |
| 统计 / 城市计数 / 随机 / 店铺聚合 | **后端** | 分页后客户端不再持有全量数据 |
| 月份分组、中文月名、六行统计文案量词 | 客户端 | 纯展示；接口只给数字，别下发文案（量词会随 UI 改） |
| 墙布局坐标（`hero/wide/tall/small`、x/y/w/h） | **客户端** | 依赖屏宽与块型节奏；后端**不要**下发块型或坐标（见 `packages/core/src/layout.ts:46-70`） |
| 城市 → 省 字典 | 两端同源 | 静态常识表；`GET /geo/cities` 下发以保证多端一致（见 §6.6） |
| 预置配图 | 客户端兜底 / 后端托管 | `photo = null` 时用预置配图；后端 `/v1/files/:name` 可托管（见 `server/src/routes/system.ts`） |

### 2.4 三条硬约束（违反会直接白屏或数字错乱）

**① `at` 的格式是硬契约**
- 形状：`YYYY-MM-DDTHH:mm`（定宽、零填充、无秒、无时区）。
- 为什么：客户端按字符串比较排序，定宽前缀保证字典序 = 时间序；`at.slice(0, 7)` 取月份键；解析侧为兼容 iOS 做 `-`→`/`、`T`→空格 的替换，带 `Z` / `+08:00` / 秒会解析失败并悄悄退回"当前时间"。
- 服务端存储：`eatenAtUtc`（UTC instant，用于排序、分页游标、跨时区）+ `tzOffset`（记录时区）两份；对外仍返回 `at` 本地串（见 §6.2）。列表排序以 `eatenAtUtc` 为准，`at` 仅用于展示与分组；单时区用户两者等价。

**② `id` 不透明，且避开 `g..._...`**
- 客户端会解析 id：`g` 开头且含 `_` 的视为本地伪造数据、**不落盘**。服务端禁止生成该形态。
- 服务端 id 建议 `ULID`/`UUID`，对外形如 `rec_01J9Z8ZK3M4N5P6Q7R8S9T0V`。

**③ 空值语义**
- `null` / 缺失 = 未记；返回 `""` 会被客户端当成"有值"（例如城市筛选、店铺去重、统计口径会把空串当假值处理，数据会脏）。
- `photo = null` = 用预置配图，不是空块。

---

## 3. 通用约定

### 3.1 环境与地址

| 环境 | Base URL | 说明 |
| --- | --- | --- |
| 开发 | `https://dev-api.xshifu.example.com/v1` | 允许测试账号 |
| 预发 | `https://staging-api.xshifu.example.com/v1` | 与线上同数据形态 |
| 生产 | `https://api.xshifu.example.com/v1` | 小程序合法域名需备案并配置 |

- 仅 HTTPS；TLS ≥ 1.2。
- 小程序需配置：`request`、`uploadFile`、`downloadFile` 三类合法域名；CDN 图片域名必须加入 `downloadFile`（或 `<Image>` 可直接用 https，无需 downloadFile，但审核要求域名备案）。
- 健康检查：`GET /healthz`（无鉴权，返回 `{"status":"ok","version":"1.0.0"}`）。

### 3.2 认证

- 小程序冷启动：`Taro.login()` 拿 `code` → `POST /auth/wechat/login` → 拿到 `accessToken / refreshToken`。
- H5 / 开发环境：`POST /auth/anonymous`（设备号换取匿名账号）。
- 除 `POST /auth/*`、`GET /healthz`、`GET /geo/cities`（城市字典公开，供表单选择器在无登录态也能用）外，全部接口要求请求头：
  ```
  Authorization: Bearer <accessToken>
  X-Client-Version: 1.0.0        # 可选，用于灰度
  X-Request-Id: <uuid>           # 可选，服务端回显，便于排障
  ```
- `accessToken` 有效期 2 小时；`refreshToken` 30 天。前端在 401 `TOKEN_EXPIRED` 时调 `POST /auth/refresh` 并重放一次原请求（**只能重放一次**，避免死循环）。
- 所有数据按 `userId` 隔离；**查别人的记录或访问不存在的资源一律返回 404**（不要 403，避免暴露 id 是否存在）。因此错误码表里**不定义也不使用 `FORBIDDEN`**，任何"资源不存在 / 不属于当前用户"统一走 `404 NOT_FOUND`。

### 3.3 成功/失败响应

**成功**：2xx，直接返回资源对象或分页对象，不再套 `{code, data}` 外壳。

**失败**：统一错误体，HTTP 状态码 + 机器可读 `code`：

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "吃了什么是必填",
    "requestId": "req_01J9Z8ZK3M4N5P6Q7R8S9T0V",
    "fields": { "eat": "不能为空" }
  }
}
```

| HTTP | `code` | 含义 | 前端应有行为 |
| --- | --- | --- | --- |
| 400 | `BAD_REQUEST` | 参数结构错误（JSON 解析失败等） | 提示"请求异常" |
| 401 | `TOKEN_MISSING` | 缺 Authorization | 触发登录 |
| 401 | `TOKEN_INVALID` | 签名/格式错误 | 清 token，重新登录 |
| 401 | `TOKEN_EXPIRED` | accessToken 过期 | refresh 后重放一次 |
| 404 | `NOT_FOUND` | 记录/店铺/照片不存在或不属于本人（含已删除） | 详情页空态「这一条已经不在了」 |
| 404 | `NO_RECORD` | 随机在无候选时（语义等同无结果，复用 404 避免新增码） | 提示"这个城市还没有照片" |
| 401 | `WECHAT_CODE_INVALID` | 微信 `code` 无效/已消费/过期 | 重新 `Taro.login()` 取新 code 重试 |
| 409 | `CONFLICT` | 乐观锁版本冲突 | 拉最新数据后提示重试 |
| 409 | `PHOTO_IN_USE` | 删除仍被记录引用的照片 | 先删记录 |
| 410 | `GONE` | 撤销删除窗口已过（restore 用） | 提示"无法撤销" |
| 413 | `FILE_TOO_LARGE` | 照片超过 10 MiB | 提示重选 |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | 非 jpeg/png/webp | 提示重选 |
| 422 | `VALIDATION_FAILED` | 字段校验失败（带 `fields`） | 字段级标红（菜名必填） |
| 422 | `IMAGE_REJECTED` | 图片内容安全未通过 | 提示换一张 |
| 429 | `RATE_LIMITED` | 触发限流 | 按 `Retry-After` 退避 |
| 500 | `INTERNAL_ERROR` | 未捕获异常 | 提示稍后重试 |
| 503 | `SERVICE_UNAVAILABLE` | 维护/过载 | 提示稍后重试 |

**分页对象**（统一形状）：

```json
{
  "items": [],
  "nextCursor": "eyJhdCI6IjIwMjYtMTAtMDlUMTI6MzAiLCJpZCI6InJlY18wMUo5In0",
  "hasMore": true,
  "total": 22
}
```

- `nextCursor`：不透明串（服务端可 base64url 编码 `{atUtc, id}`）；`hasMore=false` 时可为 `null`。
- `total`：当前筛选条件命中的总条数（可选返回，但推荐给"全部 N"之外的场景用；城市计数走 `/records/cities`）。
- `limit` 默认 10（对齐前端 `PAGE_SIZE`），最大 50。
- **游标必须"不重不漏"**：以 `(eaten_at_utc DESC, id DESC)` 做 keyset；同分钟多条记录靠 id 兜底；翻页期间新增记录不得导致已翻页重复。

### 3.4 时间与时区

| 字段 | 格式 | 示例 | 说明 |
| --- | --- | --- | --- |
| `at`（请求/响应） | `YYYY-MM-DDTHH:mm` | `2026-10-09T12:30` | 用户本地墙钟时间，无时区、无秒；**响应必返**，前端显示/分月/排序依赖 |
| `tzOffset`（请求/响应） | `±HH:mm` | `+08:00` | 记录时区偏移；新建时若不传，取请求头 `X-Timezone-Offset`，再缺省 `+08:00` |
| `eatenAtUtc`（响应） | RFC3339 UTC | `2026-10-09T04:30:00Z` | 服务端排序/游标口径；前端不读 |
| `createdAt` / `updatedAt`（响应） | RFC3339 UTC | `2026-10-09T04:31:02Z` | 审计字段 |

新建时也可直接传 `eatenAt`（RFC3339，带偏移），与 `at + tzOffset` 二选一；两者都传时以 `eatenAt` 为准。
`at` 若晚于服务器时间 5 分钟以上 → `422`（防误传未来时间）；`at` 早于 1970 年 → `422`。

**`X-Timezone-Offset` 的失败语义（硬约束）**

| 情况 | 行为 |
| --- | --- |
| 未传 / 传空串 | 视为未提供，按 `tzOffset` → 默认 `+08:00` 依次回落 |
| 格式合法（`±HH:mm`，范围 ±14:00 且 14 小时只能 `:00`） | 采用该偏移 |
| **格式非法**（`bogus` / `8:00` / `+8` / `+0800` / `+25:00` / `+14:30`） | **`400 BAD_REQUEST`** |

> **不允许静默回落**：非法头若当成 `+08:00` 照常写入，记录的 `at`/`eatenAtUtc` 会与客户端以为的时区差几小时且无任何信号，连锁影响排序、分月、统计 —— 必须响亮失败。
> body 里的 `tzOffset` 由 schema 校验，非法时是 `422 VALIDATION_FAILED`，与请求头这一层（`400`）刻意区分。

> **`at` 由谁产生**
>
> - **服务端**：客户端不传 `at` 也不传 `eatenAt` 时，用 `Date.now()` 投影到该请求偏移生成（`resolveTemporal` 第三分支）。
> - **客户端**：ui-taro 的「贴一张」表单有日期 + 时刻控件，POST/PATCH body 带 `at` 和 `tzOffset` —— **成对发送**：只发 `at` 服务端按默认 `+08:00` 解释，跨时区用户排序会错。
> - **补记**：日期控件 `end=today`（不允许未来）+ 时刻；编辑态回填原 `at`。优先级：`eatenAt` > `at` > 服务端 now。
> - **P0 允许只传 `at`**，服务端按 `X-Timezone-Offset` 补 `tzOffset`。

### 3.5 幂等、并发与限流

- **创建幂等**：`POST /records` 支持请求头 `Idempotency-Key: <uuid>`（或 body `clientRequestId`）。同 key 24h 内重复请求返回**首次结果**（201，附 `Idempotent-Replayed: true`），避免弱网重试产生两条。
- **更新冲突**：`PATCH /records/{id}` 可带 `If-Match: <version>`（或 body `expectedVersion`）；版本不匹配返回 `409 CONFLICT`。前端当前无并发场景，可先不传，服务端仍必须原子更新。
- **删除语义（定死）**：软删（`deleted_at IS NULL` 过滤）。响应规则：
  - 删**本人存在的**记录 → `204`（已删除）。
  - 删**本人已删除的**记录（重复调用）→ `204`（幂等）。
  - 删**不存在的 id** 或 **别人的记录** → `404 NOT_FOUND`（与"查不到"统一，绝不 403）。
  - `GET`/`PATCH` 已删除或不存在/非本人的记录，同样 `404`。
  - 前端"删除后返回"逻辑不依赖具体响应体，但依赖"别人的记录不会曝出 403"。
- **限流**（建议值，可调）：普通接口 60 req/min/用户；`POST /photos` 20 req/min/用户；`POST /auth/*` 10 req/min/IP。超限返回 429 + `Retry-After`（秒）。

  **分组依据（安全硬约束）**——限流效果完全取决于 key 能否被客户端控制：

  | 请求 | key | 说明 |
  | --- | --- | --- |
  | 已登录 | `userId` | 与代理配置无关；绕过需不断注册，而注册接口本身也受限流 |
  | 未登录，直连部署 | **TCP 对端 IP** | 客户端伪造 `X-Forwarded-For` 无效 |
  | 未登录，反代之后 | `X-Forwarded-For` 的**最右一跳** | 由最近的可信代理追加，客户端无法占据该位置 |

  > **不得取 `X-Forwarded-For` 的最左段**：由客户端编造，取它等于限流可被"每次换个假 IP"绕过。只有在**确实**位于自家反向代理之后时才信任该头（`TRUST_PROXY=true`）。


### 3.6 缓存

| 接口 | 缓存策略 |
| --- | --- |
| `/records*`、`/stats`、`/shops*`、`/me` | `Cache-Control: no-store`（个人数据） |
| `/records/random` | `Cache-Control: no-store`（必须每次重算） |
| 图片 CDN | `Cache-Control: public, max-age=31536000, immutable`（内容寻址，换图即换 URL） |
| `/geo/cities` | `ETag` + `Cache-Control: public, max-age=86400`，支持 `If-None-Match` → 304 |

### 3.7 字段级约束（服务端必须校验）

> **单一真源**：上限只在前端 `packages/core/src/records.ts` 的 `FIELD_LIMITS` / `MAX_PHOTOS` 定义，由 `gen-data.mjs` 生成 `server/src/data/shared-limits.ts`，zod schema 与前端输入框共用同一份数字。改上限只改前端并重跑 `npm run gen-data`；`test/shared-limits.test.ts` 在不一致时失败。
>
> **长度按 `trim()` 后的字符数算**（纯空白不占额度），POST 与 PATCH 口径一致。
>
> **聚合口径**：后端 `services/aggregates.ts` 的省分组、计数、`avgRating`、`repeated`、月份桶必须与前端 `core` 同一份数据、同一口径（省归属 `provinceOf` 单一真源、省序 `count DESC → 码点序`、`localeCompare('zh-Hans-CN')` 兜底、月份按本地墙钟 `at.slice(0,7)`）。`test/aggregate-parity.test.ts` 跨端断言，源码缺失时跳过。

| 字段 | 规则 | 失败 `fields` 键 |
| --- | --- | --- |
| `eat` | `trim()` 后 1–60 字符；不接受纯空白/换行 | `eat` |
| `shop` | `trim()` 后 ≤ 80 字符；空串归一 `null` | `shop` |
| `city` | `trim()` 后 ≤ 40 字符；空串归一 `null`；**不校验是否在字典内**（历史手填值合法） | `city` |
| `district` | `trim()` 后 ≤ 40 字符；空串归一 `null` | `district` |
| `note` | ≤ 200 字符（前端 `maxlength=200`），保留换行；空串归一 `null` | `note` |
| `rating` | 整数 0–5；缺省 `0` | `rating` |
| `at` / `eatenAt` | 格式合法；不在未来 > 5 分钟 | `at` |
| `photoId` | 存在、属于当前用户、状态 `approved`；`null` 表示清除自定义照片 | `photoId` |
| `photoIds` | 数组，0–5 个；元素存在、属于当前用户、状态 `approved`、互不重复；**顺序保留**（不去重不排序） | `photoIds` |
| `shopId` | 存在且属于当前用户（若传）；与 `shop` 同时传时以 `shopId` 为准 | `shopId` |
| `id` | 服务端生成，不可由客户端指定 | — |
| `limit` | 1–50；缺省 10；越界 → `400 BAD_REQUEST`（**无** `fields`，仅 `message`） | — |
| `cursor` | 服务端可解码；非法 → `400 BAD_REQUEST`（同上） | — |

---

## 4. 资源模型

### 4.1 实体关系（最小集）

```
User 1 ──── n Record n ──── 0..5 Photo
                  │
                  └──── 0..1 Shop   （店铺按 (name, city) 唯一；记录冗余存 shop 名）
GeoCity (静态字典，可按版本下发)
```

- **Record** 是唯一核心实体，其余都是它的聚合视图（统计、城市计数、店铺页、随机）。
- **Shop** 建议建独立表：`id / name / city / userId / createdAt`；同一店名跨城市视为**两家店**。记录表同时保留 `shop`（店名快照）与 `shop_id`，读取时以 `shop_id` 为准、`shop` 兜底（兼容历史/无店铺实体的记录）。
- **Photo** 属于 User，可被多条记录引用（一条记录可挂 0–5 张；同一张照片也可被多条记录引用）。

### 4.2 Record（记录）—— 响应主体

```json
{
  "id": "rec_01J9Z8ZK3M4N5P6Q7R8S9T0V",
  "eat": "甜水面",
  "shop": "马旺子川小馆",
  "shopId": "shp_01J9Z8ZK3M4N5P6Q7R8S9T0V",
  "city": "成都",
  "district": null,
  "rating": 5,
  "at": "2026-10-09T12:30",
  "tzOffset": "+08:00",
  "eatenAtUtc": "2026-10-09T04:30:00Z",
  "note": "面条筋道，甜辣刚好。辣子是现舂的，香得不像话。",
  "photo": "https://cdn.xshifu.example.com/p/r/01J9Z8ZK3M4N5P6Q7R8S9T0V-1080.jpg",
  "photoThumb": "https://cdn.xshifu.example.com/p/r/01J9Z8ZK3M4N5P6Q7R8S9T0V-400.jpg",
  "photoId": "pho_01J9Z8ZK3M4N5P6Q7R8S9T0V",
  "photos": [
    {
      "photoId": "pho_01J9Z8ZK3M4N5P6Q7R8S9T0V",
      "photo": "https://cdn.xshifu.example.com/p/r/01J9Z8ZK3M4N5P6Q7R8S9T0V-1080.jpg",
      "photoThumb": "https://cdn.xshifu.example.com/p/r/01J9Z8ZK3M4N5P6Q7R8S9T0V-400.jpg"
    },
    {
      "photoId": "pho_01J9Z8ZK3M4N5P6Q7R8S9T0W",
      "photo": "https://cdn.xshifu.example.com/p/r/01J9Z8ZK3M4N5P6Q7R8S9T0W-1080.jpg",
      "photoThumb": "https://cdn.xshifu.example.com/p/r/01J9Z8ZK3M4N5P6Q7R8S9T0W-400.jpg"
    }
  ],
  "version": 3,
  "createdAt": "2026-10-09T04:31:02Z",
  "updatedAt": "2026-10-09T04:31:02Z"
}
```

| 字段 | 类型 | 可空 | 说明 |
| --- | --- | --- | --- |
| `id` | string | 否 | 不透明；≤ 64；服务端生成；**禁止** `^g.*_` 形态 |
| `eat` | string | 否 | 菜名，1–60 |
| `shop` | string \| null | 是 | 店名快照；`null` = 未记店名（不是"没有店"） |
| `shopId` | string \| null | 是 | 店铺实体 id；新写入建议都带 |
| `city` | string \| null | 是 | 城市名（不含省）；`null` = 未记；可能是字典外表外值 |
| `district` | string \| null | 是 | 区/县；历史字段，表单不采集，可空 |
| `rating` | integer | 否 | `0` = 未评；`1–5` 星级 |
| `at` | string | 否 | `YYYY-MM-DDTHH:mm` 本地墙钟 |
| `tzOffset` | string \| null | 是 | `±HH:mm`，缺省按 `+08:00` |
| `eatenAtUtc` | string | 否 | RFC3339 UTC，排序/游标口径 |
| `note` | string \| null | 是 | ≤ 200 |
| `photo` | string \| null | 是 | 展示用图（约 1080w），https URL；`null` = 用预置配图 |
| `photoThumb` | string \| null | 是 | 列表缩略图（约 400w），可空（为空时前端用 `photo`） |
| `photoId` | string \| null | 是 | 照片实体 id，编辑/删除时用 |
| `photos` | Array<{photoId, photo, photoThumb}> | 否 | **全部照片**（有序，0–5 张）；`photos[0]` 即封面 |
| `version` | integer | 否 | 乐观锁版本，每次写 +1 |
| `createdAt` / `updatedAt` | string | 否 | RFC3339 UTC |

> **封面口径（多图）**：`photo` / `photoThumb` / `photoId` 这三个旧字段 **= 封面 = `photos[0]`**，
> 老客户端只认这三个字段也能继续工作（兼容期保留，不废弃）。
> `photos` 为**空数组**时表示「这条记录没有自定义照片 → 用预置配图」，此时
> `photo` / `photoThumb` / `photoId` **全部为 `null`**。
> `photos` **恒存在**（不是可选字段），长度 0–5，**顺序即用户选择顺序**，服务端不做排序也不做随机。
> 封面三字段取「剔除软删照片后」的第一张；剔除后为空 → `photos: []` 且三字段为 `null`。
> `photos[].photo` = 1080w 展示图；`photos[].photoThumb` = 400w 缩略图。

**与前端 `FoodRecord` 的差异**：`FoodRecord` 原有 9 个字段（`id/eat/shop/city/district/rating/at/note/photo`），其余为新增字段；多图改造后前端又新增了 `photos?: string[]`（有序 URL 数组，空 = 用预置配图）。前端渲染所需字段完全被覆盖，因此**改接口不需要改墙/详情/店铺的渲染代码**。

### 4.3 店铺、照片、统计对象

见对应接口（§6.5、§6.6、§6.3）中的响应示例。

---

## 5. 接口总表

> 路径均相对 `/v1`。P0 = 第一版必须；P1 = 上线前建议；P2 = 后续迭代。
> ⚠ 路由注册顺序：`/records/random`、`/records/cities`、`/records/months` 必须先于 `/records/{id}` 注册，否则会被当成 id；同理 `/shops/by-name` 必须先于 `/shops/{shopId}` 注册。
> 共 23 个接口，与 `openapi.yaml` 一致。「前端调用点」指 `photo-wall-mp/packages/ui-taro/src/api/` 的封装。

| # | 方法 | 路径 | 用途 | 优先级 | 前端调用点 |
| --- | --- | --- | --- | --- | --- |
| 1 | POST | `/auth/wechat/login` | 小程序静默登录（code 换 token） | P0 | `src/api/client.ts` 冷启动登录 |
| 2 | POST | `/auth/anonymous` | H5 / 开发环境匿名登录 | P1 | `src/api/client.ts` |
| 3 | POST | `/auth/refresh` | 刷新 accessToken | P0 | `src/api/client.ts` 401 自愈 |
| 4 | GET | `/me` | 当前用户信息与总量 | P1 | 统计页脚/设置 |
| 5 | GET | `/records` | 记录列表（游标分页 + 城市筛选） | P0 | `pages/wall`、`pages/shop` |
| 6 | GET | `/records/{id}` | 单条记录 | P0 | `pages/detail`、`pages/compose`（编辑初始化） |
| 7 | POST | `/records` | 新建（贴一张） | P0 | `pages/compose` 提交 |
| 8 | PATCH | `/records/{id}` | 局部更新（编辑） | P0 | `pages/compose` 提交（编辑态） |
| 9 | DELETE | `/records/{id}` | 删除（软删、幂等） | P0 | `pages/detail` 删除 |
| 10 | POST | `/records/{id}/restore` | 撤销删除（软删恢复） | P1 | `src/api/index.ts` `restoreRecord` |
| 11 | GET | `/records/random` | 随机一道（可排除上一条） | P0 | `wall` 的 `rollRandom` |
| 12 | GET | `/records/cities` | 全量城市计数 + 省分组 | P0 | `wall` 的 CityPicker |
| 13 | GET | `/records/months` | 月份列表与每月条数（前端月轴待接） | P2 | `src/api/index.ts` `listMonths` |
| 14 | GET | `/stats` | 墙统计（六行数字） | P0 | `components/StatsSheet` |
| 15 | GET | `/shops/{shopId}` | 店铺档案 + 该店记录 | P1 | `pages/shop` |
| 16 | GET | `/shops/by-name` | 按店名查店铺（过渡兼容） | P1 | `src/api/index.ts` `getShopByName` |
| 17 | POST | `/photos` | 上传照片（multipart） | P0 | `pages/compose` 选图 |
| 18 | DELETE | `/photos/{photoId}` | 删除照片（未被引用时） | P2 | 换图/清理 |
| 19 | GET | `/geo/cities` | 城市字典（省→市） | P1 | `src/api/index.ts` `getGeoCities`（前端仍可沿用内置表） |
| 20 | GET | `/healthz` | 健康检查 | P0 | 运维 |
| 21 | POST | `/records/{id}/share` | 开启分享（生成/复用 shareToken） | P1 | `src/api/index.ts` `openShare`（§6.7.1） |
| 22 | DELETE | `/records/{id}/share` | 撤销分享（旧链接立即失效） | P1 | §6.7.2 |
| 23 | GET | `/share/records/{id}?token=` | 免鉴权匿名读一条分享 | P1 | `src/api/index.ts` `readSharedRecord`（§6.7.3） |

---

## 6. 接口详情

### 6.1 认证

#### 6.1.1 `POST /auth/wechat/login` — 小程序静默登录（P0）

**用途**：小程序冷启动时用 `wx.login` 的 `code` 换会话，自动注册/登录，**不弹授权窗**（只取 openid，不取昵称头像）。
**前端**：新增。`app.tsx` 或请求封装层初始化时调用；`code` 5 分钟内有效、只能消费一次。

**请求**

```http
POST /v1/auth/wechat/login
Content-Type: application/json

{
  "code": "081Abc...",
  "clientRequestId": "9f1c2a3e-..."   // 可选，幂等
}
```

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `code` | string | 是 | `Taro.login()` 返回的临时登录凭证 |
| `clientRequestId` | string | 否 | 防重复建号（弱网重试） |

**响应 200**

```json
{
  "accessToken": "eyJhbGciOi...",
  "refreshToken": "rt_01J9Z8...",
  "expiresIn": 7200,
  "tokenType": "Bearer",
  "userId": "usr_01J9Z8ZK3M4N5P6Q7R8S9T0V",
  "isNewUser": true,
  "user": { "id": "usr_...", "createdAt": "2026-10-09T04:30:00Z", "recordCount": 0 }
}
```

**实现要点**
- 服务端调 `https://api.weixin.qq.com/sns/jscode2session` 换 `openid`（`appid`/`secret` 只存在服务端）；**`session_key` 绝不下发**。
- 以 `openid` 查/建用户；`isNewUser=true` 时可初始化示例数据。
- 失败：微信侧错误映射为 `401 WECHAT_CODE_INVALID`（新增码，见 §3.3 可自行扩展，但需同步前端映射表）。

#### 6.1.2 `POST /auth/anonymous` — 匿名设备登录（P1）

**用途**：H5 版本与开发者工具没有微信 code，用设备标识换匿名账号。
**请求**：`{ "deviceId": "d_9f1c2a3e...", "clientRequestId": "..." }`；`deviceId` 为客户端生成的 UUID，存 localStorage。
**响应**：同 6.1.1。
同一 `deviceId` 重复调用返回同一 `userId`（幂等）；该接口限流更严（防刷号）。

#### 6.1.3 `POST /auth/refresh` — 刷新令牌（P0）

```http
POST /v1/auth/refresh
{ "refreshToken": "rt_01J9Z8..." }
```

**响应 200**：`{ "accessToken": "...", "refreshToken": "...", "expiresIn": 7200 }`（refreshToken 轮换，旧的立即失效）。
**失败**：`401 TOKEN_INVALID` → 前端清除本地 token，重新走登录。

#### 6.1.4 `GET /me` — 当前用户（P1）

**用途**：设置页/统计页脚展示；也用于"是否新用户"判断。
**响应 200**：

```json
{
  "id": "usr_...",
  "createdAt": "2026-10-09T04:30:00Z",
  "recordCount": 22,
  "photoCount": 20,
  "lastRecordAt": "2026-10-09T12:30"
}
```

---

### 6.2 记录

#### 6.2.1 `GET /records` — 记录列表（墙 / 分页）（P0）

**用途**：墙的首屏与触底加载；店铺页也可复用（带 `shopId`）。
**前端**：`pages/wall/index.tsx:72-88`（首屏 + `useReachBottom`）、`data/store.ts:125-150`（接缝 `fetchOlderPage`）。

**Query 参数**

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `limit` | integer | 否 | 10 | 1–50；前端 `PAGE_SIZE=10` |
| `cursor` | string | 否 | — | 上一页返回的 `nextCursor`；不传 = 第一页（最新） |
| `cursorInclusive` | boolean | 否 | false | `false` = 严格 `< cursor`（翻页，不重不漏）；`true` = `<= cursor`（**从这条开始**，配 `months.firstCursorInclusive` 做月轴跳转） |
| `city` | string | 否 | — | 城市名精确匹配（`(r.city \|\| '') === city`）；**URL 编码** |
| `cityMissing` | boolean | 否 | false | `true` = 只看"未记城市"（等价前端 `filterCity === ''`），与 `city` 互斥 |
| `province` | string | 否 | — | 按省筛选（服务端用城市字典展开为城市集合）；当前 UI 未用，留给 P1 |
| `shopId` | string | 否 | — | 按店铺筛选（店铺页） |
| `q` | string | 否 | — | 菜名模糊搜索（P2，可先不实现） |

**排序契约（硬约束）**

- 按 `eatenAtUtc DESC, id DESC` 返回（即 `at` 倒序；同一分钟用 id 兜底）。
- 分页为 keyset 游标，**不重不漏**；新增记录不影响已翻页的游标。

**响应 200**

```json
{
  "items": [
    {
      "id": "rec_01J9Z8ZK3M4N5P6Q7R8S9T0V",
      "eat": "甜水面",
      "shop": "马旺子川小馆",
      "shopId": "shp_01J9Z8ZK3M4N5P6Q7R8S9T0V",
      "city": "成都",
      "district": null,
      "rating": 5,
      "at": "2026-10-09T12:30",
      "tzOffset": "+08:00",
      "eatenAtUtc": "2026-10-09T04:30:00Z",
      "note": "面条筋道，甜辣刚好。",
      "photo": "https://cdn.xshifu.example.com/p/r/01J9....-1080.jpg",
      "photoThumb": "https://cdn.xshifu.example.com/p/r/01J9....-400.jpg",
      "photoId": "pho_01J9Z8ZK3M4N5P6Q7R8S9T0V",
      "version": 1,
      "createdAt": "2026-10-09T04:31:02Z",
      "updatedAt": "2026-10-09T04:31:02Z"
    }
  ],
  "nextCursor": "eyJhdCI6IjIwMjYtMTAtMDlUMDQ6MzA6MDBaIiwiaWQiOiJyZWNfMDFKOSJ9",
  "hasMore": true,
  "total": 22
}
```

**实现要点**
- 只返回 `userId = 当前用户` 的记录。
- `city` 与 `cityMissing` 同时传 → `400`。
- 游标编码 `(eaten_at_utc, id)`；解码失败 → `400 BAD_REQUEST`。
- 空列表返回 `{"items":[],"nextCursor":null,"hasMore":false,"total":0}`（前端空态：`墙还是空的。` / `这个城市还没有照片。`）。
- **首屏可放大 `limit`**：墙要"一屏铺满"（原型有首屏补批逻辑），客户端首屏可取 `limit=20`；`limit` 上限 50，不要靠"多请求几次"补。
- **不要**在列表里返回布局坐标/块型/统计值。

#### 6.2.2 `GET /records/{id}` — 单条记录（P0）

**用途**：详情页、编辑页初始化。
**前端**：`pages/detail/index.tsx:23-32`、`pages/compose/index.tsx:30-34`。

**响应 200**：单个 Record（同 6.2.1 的 item）。
**失败**：不存在或不属于本人 → `404 NOT_FOUND`。前端详情页展示「这一条已经不在了」；编辑页需降级为 404 提示（当前前端会静默变新建，接后端时要改，见 §8）。

#### 6.2.3 `POST /records` — 新建（贴一张 / 多图）（P0）

**前端**：`pages/compose/index.tsx:148-177`（`addRecord`）。
**请求**

```http
POST /v1/records
Content-Type: application/json
Idempotency-Key: 9f1c2a3e-6b2b-4f1a-9a1e-3c5d7e9f0a1b

{
  "eat": "甜水面",
  "shop": "马旺子川小馆",
  "shopId": null,
  "city": "成都",
  "district": null,
  "rating": 5,
  "note": "面条筋道，甜辣刚好。",
  "photoIds": ["pho_01J9Z8ZK3M4N5P6Q7R8S9T0V", "pho_01J9Z8ZK3M4N5P6Q7R8S9T0W"],
  "at": "2026-10-09T12:30",
  "tzOffset": "+08:00"
}
```

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `eat` | string | **是** | 1–60，`trim` 后非空；否则 `422`，`fields.eat` |
| `shop` | string \| null | 否 | ≤ 80；空串归一 `null` |
| `shopId` | string \| null | 否 | 与 `shop` 同传时以 `shopId` 为准，`shop` 由服务端回填店名 |
| `city` | string \| null | 否 | ≤ 40；**不校验字典** |
| `district` | string \| null | 否 | ≤ 40 |
| `rating` | integer | 否 | 0–5，缺省 0 |
| `note` | string \| null | 否 | ≤ 200 |
| `photoId` | string \| null | 否 | **旧字段（兼容期保留）**：先调 `POST /photos` 获得；必须属于当前用户 |
| `photoIds` | string[] | 否 | **最多 5 张**：先调 `POST /photos` 获得；顺序即用户选择顺序。缺省 = 无照片；`[]` = 无照片 |
| `at` | string | 否 | `YYYY-MM-DDTHH:mm`；不传 = 服务端当前时间（对齐 `stampNow()`） |
| `tzOffset` | string | 否 | `±HH:mm`；不传取 `X-Timezone-Offset`，再缺省 `+08:00`。非法值 → `422`（请求头非法则是 `400`，见 §3.4） |
| `eatenAt` | string | 否 | RFC3339；与 `at` 二选一，优先 |
| `clientRequestId` | string | 否 | 与 `Idempotency-Key` 等价 |

**响应 201**：完整 Record（前端提交成功后立即回墙，靠重新拉列表刷新；不需要额外返回聚合值）。

**实现要点**
- 服务端生成 `id`、`eatenAtUtc`、`createdAt`、`updatedAt`、`version=1`。
- 若 `shop` 非空且 (name, city) 无对应店铺 → 创建 `Shop` 并回填 `shopId`（推荐）；若本期不做店铺表，`shopId` 返 `null` 也可，店铺页走 `/shops/by-name`。
- 幂等：同 `Idempotency-Key` 24h 内重放返回首次结果（201 + `Idempotent-Replayed: true`）。

**照片字段口径（`photoIds` 与 `photoId`）**
- `photoIds` **缺省** = 没有自定义照片；`photoIds: []` = 显式无照片（与缺省等价）。两者都不带照片的记录，回落**预置配图**（响应 `photos: []`，`photo/photoThumb/photoId` 全 `null`）。
- **兼容优先级**：`photoIds` 出现时**旧字段 `photoId` 被忽略**（**不报错**，也不校验它）；只有 `photoIds` **未出现**时 `photoId` 才生效，等价于 `photoIds: [photoId]`。`photoId: null` = 清除照片（等价 `photoIds: []`）。
- **校验失败 → `422 VALIDATION_FAILED`，`fields.photoIds`**：
  - 超过 5 张（`photoIds.length > 5`）→ `fields.photoIds`，文案「最多 5 张照片」；
  - 有重复 id → `fields.photoIds`，文案「照片不能重复」；
  - 某个 id 不存在 / 不属于本人 / 已软删 / 未通过审核 → `fields.photoIds`，文案「照片不存在」。
- 旧字段 `photoId` 触发校验时，`fields` 键用 `photoId`（保持旧行为）。
- `photoIds` 里的 id **顺序保留**，服务端不做去重、不做排序。

#### 6.2.4 `PATCH /records/{id}` — 局部更新（编辑）（P0）

**前端**：`pages/compose/index.tsx:155-174`（`updateRecord`，发送全部可编辑字段）。

**语义**
- 仅更新出现的字段；未出现字段保持不变。
- `photoId: null` = 清除自定义照片（回到预置配图）；`photoId: "pho_..."` = 换成新图。
- **`at` 可改**（类型上 `RecordPatch` 允许；当前 UI 不发）。
- `id`、`createdAt` 不可改；服务端更新 `updatedAt`、`version += 1`。
- 记录不存在 → `404`；可选 `If-Match: <version>` → 版本不符 `409 CONFLICT`。

**照片字段口径（`photoIds` 与 `photoId`）**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `photoIds` | string[] | 否 | **最多 5 张**；出现即**整体替换**该记录的照片集合（**不是追加**）；`[]` = 清空全部照片（回到预置配图） |
| `photoId` | string \| null | 否 | **旧字段（兼容期保留）**：仅当 `photoIds` **未出现**时生效，等价 `photoIds: [photoId]`；`null` = 清空全部 |

- `photoIds` **不传** = 照片不动（其余字段照常局部更新）。
- `photoIds` 出现 = **整体替换**（不是追加）；`photoIds: []` = 清空（响应 `photos: []`，`photo/photoThumb/photoId` 全 `null`，回落预置配图）。
- **兼容优先级**：两者同传 → `photoIds` 优先，`photoId` **被忽略**（**不报错**）。
- 校验失败 → `422 VALIDATION_FAILED`，`fields.photoIds`（旧字段 `photoId` 触发校验时键用 `photoId`）：超过 5 张 / 有重复 id / id 不存在或不属于本人。

**请求示例**

```http
PATCH /v1/records/rec_01J9Z8ZK3M4N5P6Q7R8S9T0V
Content-Type: application/json
If-Match: 1

{
  "eat": "甜水面（加辣）",
  "rating": 4,
  "note": null,
  "city": "成都",
  "photoIds": ["pho_01J9Z8ZK3M4N5P6Q7R8S9T0V", "pho_01J9Z8ZK3M4N5P6Q7R8S9T0W"]
}
```

**响应 200**：更新后的完整 Record。

#### 6.2.5 `DELETE /records/{id}` — 删除（P0）

**前端**：`pages/detail/index.tsx:54-75`（确认弹窗后删除；同时删本地照片文件）。

**响应**：`204 No Content`。语义（与 §3.5 一致，以此为准）：
- 删本人**存在**的记录 → `204`；
- 重复删本人**已删除**的记录 → `204`（幂等，前端重试不报错）；
- 删**不存在**的 id 或**别人的**记录 → `404 NOT_FOUND`（不泄露存在性，绝不 403）。
**实现要点**
- 软删（`deleted_at`）实现；列表 / 聚合全部带 `deleted_at is null`，删除后立刻不可见，同时为「删除后 5 秒撤销」保留恢复能力。
- 级联：按记录上每张照片判定 —— 某张 `photoId` 不再被任何未删除记录引用 → 标记"待回收"，后台任务延迟 30 天删除。
- 无回收站能力（P2 可加，见 §10）。

#### 6.2.6 `GET /records/random` — 随机一道（P0）

**用途**：底部"随机一道"与浮窗"换一个"。
**前端**：`pages/wall/index.tsx:92-115`（现在本地 `Math.random()` 从当前筛选 list 抽，避开上一次）。

**Query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `city` | string | 否 | 同列表，限定城市 |
| `cityMissing` | boolean | 否 | 只看未记城市 |
| `province` | string | 否 | 按省 |
| `excludeId` | string | 否 | 排除上一次结果（前端 `lastRandomId`）；当候选 > 1 时**必须**返回不同的一条 |

**响应 200**

```json
{ "record": { "id": "rec_...", "eat": "冰粉", "at": "2026-10-09T13:10", "...": "同 Record" } }
```

- 候选为空 → `404 NOT_FOUND`（`error.code = "NO_RECORD"`，前端应提示"这个范围里还没有照片"）。
- 必须 `Cache-Control: no-store`；随机算法要求**均匀**（`ORDER BY RANDOM() LIMIT 1` 在数据量大时改为随机 offset/采样）。
- 排除后若无候选但总候选为 1 → 返回那一条（前端也允许重复）。
- **不要**在服务端"记住上次结果"；排除由客户端传 `excludeId` 完成（无状态、可重试）。

#### 6.2.7 `POST /records/{id}/restore` — 撤销删除（P1）

**用途**：H5 原型里删除后有 5 秒"撤销"（`photo-wall-h5` 的 toast + Undo，原型已删除）。服务端以软删实现本接口，恢复窗口内可撤销；前端 `src/api/index.ts` 的 `restoreRecord` 已接入，删除后的撤销交互由各端 UI 决定。
**请求**：无 body；`POST /v1/records/{id}/restore`。
**响应**：`200` 恢复后的 Record（`id`、`at` 保持原值，回到墙的原位置）。
**失败**：`404`（不存在/不属于本人）；超过撤销窗口（建议 30 天）→ `410 GONE`（可自定义码并同步前端映射）。
不做撤销交互时本接口可不实现，但**软删字段需保留**，物理清理交给后台任务。

---

### 6.3 聚合

#### 6.3.1 `GET /records/cities` — 城市计数 + 省分组（P0）

**用途**：墙顶栏城市筛选卡片：全部/省/市/未记 + 计数。
**前端**：`pages/wall/index.tsx:167-174`（`countByCity` + `groupCitiesByProvince`）、`components/CityPicker`。

**响应 200**

```json
{
  "total": 22,
  "uncityCount": 15,
  "cityCounts": [
    { "city": "成都", "count": 3 },
    { "city": "乐山", "count": 2 },
    { "city": "北京", "count": 2 }
  ],
  "provinces": [
    {
      "province": "四川",
      "count": 5,
      "cities": [
        { "city": "成都", "count": 3 },
        { "city": "乐山", "count": 2 }
      ]
    },
    {
      "province": "北京",
      "count": 2,
      "cities": [{ "city": "北京", "count": 2 }]
    }
  ],
  "generatedAt": "2026-10-09T04:31:02Z"
}
```

**口径（与客户端一致，服务端全量聚合）**
- `total`：当前用户**全部**记录数（**不受城市筛选影响**，对应前端 `records.length`）。
- `uncityCount`：`city` 为空（null）的记录数；城市计数里未记单独成桶（前端 `cityRows.find(([city]) => !city)`）。
- `cityCounts` 排序：`count DESC`，同数按城市名 `localeCompare(..., 'zh-Hans-CN')`（前端 `countByCity`，`packages/core/src/records.ts:188-195`）。
- `provinces`：用城市→省字典分组；表外城市归 `"其他"`；省内城市 `count DESC`，同数按**码点序**；省 `count DESC`，同数按**码点序**（前端 `groupCitiesByProvince`，`packages/core/src/geo.ts:137-158`）。**未记城市不参与省分组**。
  - **省归属去行政后缀**：城市名先剥掉行政后缀（正则 `/(特别行政区|自治区|自治州|地区|省|市|县|区)$/u`，与前端 `geo.ts` 的 `ADMIN_SUFFIX` 逐字一致）再查字典，因此「厦门市」归 `福建`、`内蒙古自治区` 归 `内蒙古`。后端 `provinceOf()`（`services/filters.ts`）是这条规则的唯一实现，聚合（`services/aggregates.ts`）与筛选（`other` 作用域）共用，避免两处漂移。
  - 城区 `cities` 数组**保留原始城市名**（「厦门市」不改成「厦门」）；去后缀只影响省归属，不影响展示名（与前端 `countByCity` 一致）。
  - `test/aggregate-parity.test.ts` 用真实前端 `core` 与后端 `AggregateService` 跑同一份合成数据，断言省分组、计数、`avgRating`、`repeated`、月份桶完全一致；前端源码不可用时跳过。
- 字典见 `GET /geo/cities`；服务端若不下发字典，也必须使用与前端一致的 208 城表（见附录 A）。
- 空数据：`{"total":0,"uncityCount":0,"cityCounts":[],"provinces":[],"generatedAt":"..."}`。
- **不变量**：`sum(cityCounts.count) + uncityCount === total`；`sum(provinces.count) + uncityCount === total`。`cityCounts` 与 `provinces` **不含**未记桶。

#### 6.3.2 `GET /records/months` — 月份列表（P2）

**用途**：右缘月份轴（前端交互待接）；分页后客户端无法得知未加载页的月份，故由服务端提供。
**响应 200**：

```json
{
  "items": [
    { "month": "2026-10", "count": 5,
      "firstCursor": "eyJ2IjoxLCJhdCI6...",
      "firstCursorInclusive": "eyJ2IjoxLCJhdCI6..." },
    { "month": "2026-09", "count": 4,
      "firstCursor": "eyJ2IjoxLCJhdCI6...",
      "firstCursorInclusive": "eyJ2IjoxLCJhdCI6..." },
    { "month": "2026-08", "count": 2, "firstCursor": null, "firstCursorInclusive": null },
    { "month": "2026-07", "count": 1, "firstCursor": null, "firstCursorInclusive": null }
  ]
}
```

- `month` = `at.slice(0,7)`；按 `month DESC`；可选 `city` / `cityMissing` / `province` 参数，口径与列表一致。
- `firstCursor`（可选）：该月**最新一条（第一条）**记录的游标。⚠ 分页 keyset 是**严格 `< cursor`**（见 §3.3），所以拿 `firstCursor` 调 `GET /records?cursor=` 得到的是"该月第一条**之后**"的记录 —— **该月第一条本身会漏掉**。保留该字段仅为兼容旧调用方。
- `firstCursorInclusive`（推荐）：与 `firstCursor` 是同一串游标值，但**语义上要求配 `GET /records?cursor=<它>&cursorInclusive=true`** 使用，这样该月最新一条会被**包含**进结果。月轴"点/拖跳到某月"应使用这一对：
  ```
  GET /records?cursor=<firstCursorInclusive>&cursorInclusive=true
  ```
  等价替代方案：`GET /records?from=<YYYY-MM>-01&to=<月末>` 取整月区间，同样不漏条。
- 中文月名（「十月」）由客户端生成，接口不下发文案。

#### 6.3.3 `GET /stats` — 墙统计（P0）

**用途**：统计浮层六行数字。
**前端**：`components/StatsSheet`（`statRows(computeStats(records))`）；口径 = **全量记录，不吃城市筛选**（`pages/wall/index.tsx:315-320`）。

**Query 参数**（全部可选；不传 = 全量）

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `city` / `cityMissing` / `province` | — | P2 支持按筛选统计（当前 UI 不用，但接口预留，口径与列表一致） |
| `from` / `to` | `YYYY-MM-DD` | 时间范围（P2） |

**响应 200**

```json
{
  "scope": { "city": null, "cityMissing": false, "from": null, "to": null },
  "total": 22,
  "fiveCount": 3,
  "firstFiveEat": "甜水面",
  "cities": 9,
  "shops": 20,
  "dishCount": 21,
  "avgRating": 4.32,
  "ratedCount": 20,
  "avgRatingRated": 4.75,
  "repeated": [
    { "eat": "冰粉", "count": 2 },
    { "eat": "生煎包", "count": 2 }
  ],
  "generatedAt": "2026-10-09T04:31:02Z"
}
```

**字段口径（逐条可复现，来自 `packages/core/src/stats.ts:51-70`）**

| 字段 | 定义 | 易错点 |
| --- | --- | --- |
| `total` | 记录条数（不是"照片张数"；无照片但有预置图也算一条） | UI 文案「N 张照片」沿用记录数 |
| `fiveCount` | `rating === 5` 的条数 | 严格等于 5；4.9/字符串不算 |
| `firstFiveEat` | **按时间倒序**第一条 `rating === 5` 的 `eat`；无则 `""` | 依赖排序；服务端必须按 `eatenAtUtc DESC` 取 |
| `cities` | `distinct(city)`，排除 null/空串 | "成都市"与"成都"算两座（不做归一） |
| `shops` | `distinct(shop)`，排除 null/空串 | 同名不同店会合并；同店不同写法算两家 |
| `avgRating` | `Σ(rating) / total`，**`rating=0` 计入分母**；`total=0` → `0` | 与常见"只算已评"相反，这是前端既有口径（`stats.test.ts:55-60`） |
| `ratedCount` | `rating > 0` 的条数 | 新增辅助字段 |
| `avgRatingRated` | `Σ(rating>0) / ratedCount`，无评分 → `0` | 新增辅助字段；店铺页均分用的是这个口径 |
| `dishCount` | `distinct(eat)` 的数量 | 新增辅助字段 |
| `repeated` | 按 `eat` 精确分组，筛 `count ≥ 2`，按 `count DESC`、同数按 `eat` 的 `zh-Hans-CN` 排序；**返回全部**，前端只取前 3 | 不要在服务端截断（前端 `slice(0,3)`） |

> 六行量词（`张照片/道/座城市/家店/均分/次`）由客户端拼，接口只给数字；`avgRating=0` 时前端显示 `—`。
> 本接口默认**全量**口径；P2 的 `city` 参数可满足筛选口径。

---

### 6.4 店铺

#### 6.4.1 `GET /shops/{shopId}` — 店铺档案 + 记录（P1）

**用途**：店铺页：店名、城市、去过次数/点过几道/均分/五分、第一次/最近、照片格。
**前端**：`pages/shop/index.tsx:27-40`（现在按店名 `filter(r.shop === name)` 本地聚合）。

**Query**：`limit`（默认 100，最大 200）、`cursor`（记录多时翻页；当前 UI 一次展示全部）。
**响应 200**

```json
{
  "shop": {
    "id": "shp_01J9Z8ZK3M4N5P6Q7R8S9T0V",
    "name": "四季民福",
    "cities": ["北京"],
    "createdAt": "2026-09-30T10:00:00Z"
  },
  "stats": {
    "visitCount": 2,
    "dishCount": 2,
    "cityCount": 1,
    "avgRating": 5.0,
    "ratedCount": 2,
    "fiveCount": 2,
    "firstAt": "2026-09-30T18:00",
    "lastAt": "2026-10-09T12:30"
  },
  "records": [ { "id": "rec_...", "eat": "北京烤鸭", "...": "同 Record" } ],
  "nextCursor": null,
  "hasMore": false
}
```

**口径**
- `visitCount` = 该店记录数；`dishCount` = `distinct(eat)`；`cityCount` = `distinct(city)`（排除空）。
- `avgRating` = **只对 `rating > 0` 的记录求平均**（与墙统计不同！`pages/shop/index.tsx:31-33`）；`fiveCount` = `rating === 5` 条数，0 时前端不显示该行。
- `firstAt` = `min(at)`，`lastAt` = `max(at)`；前端显示为 `YYYY.MM.DD`。
- `records` 按 `at DESC`；`shop.id` 不存在/不属于本人 → `404`。

#### 6.4.2 `GET /shops/by-name` — 按店名查（P1，过渡兼容）

**用途**：兼容按店名进入店铺页的路由 `/pages/shop/index?name=<店名>`；新代码优先用 `GET /shops/{shopId}`。
**Query**：`name`（必填，URL 编码）、`city`（可选，用于区分同名跨城店）。
**响应 200**：同 6.4.1。若同名命中多家店（不同城市）：
- `shop.city` 无法唯一确定时，`shop` 字段返回 `null` 并给 `candidates: [{id,name,cities}]`；聚合口径 = **所有同名店的记录合并**（与客户端一致）。
**失败**：无记录 → `404 NOT_FOUND`。

> 迁移建议：新代码一律用 `shopId`。前端在详情页拿 `record.shopId` 优先，回退 `record.shop` 走 by-name。

---

### 6.5 照片

#### 6.5.1 `POST /photos` — 上传照片（P0）

**用途**：贴一张/编辑页选图后，先上传拿 URL，再把 `photoId`（多图时是 `photoIds` 数组）写进记录。
**前端**：`pages/compose/index.tsx:58-128`（现在 `chooseMedia` → `saveFile` 存本地）。

**请求**（`multipart/form-data`）

```http
POST /v1/photos
Authorization: Bearer <accessToken>
Content-Type: multipart/form-data; boundary=...

--boundary
Content-Disposition: form-data; name="file"; filename="IMG_0001.jpg"
Content-Type: image/jpeg
<binary>
--boundary
Content-Disposition: form-data; name="scene"
record
--boundary--
```

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `file` | binary | 是 | 单文件；jpeg/png/webp；≤ 10 MiB（`saveFile` 配额）；建议 ≥ 200×200 |
| `scene` | string | 否 | `record`（默认）；预留 `avatar`/`share` |

**响应 201**

```json
{
  "photoId": "pho_01J9Z8ZK3M4N5P6Q7R8S9T0V",
  "url": "https://cdn.xshifu.example.com/p/o/01J9....jpg",
  "photo": "https://cdn.xshifu.example.com/p/r/01J9....-1080.jpg",
  "photoThumb": "https://cdn.xshifu.example.com/p/r/01J9....-400.jpg",
  "width": 1600,
  "height": 1200,
  "size": 482133,
  "mime": "image/jpeg",
  "status": "approved",
  "createdAt": "2026-10-09T04:31:02Z"
}
```

**实现要点**
- 鉴权：`Authorization` 头（`Taro.uploadFile` 支持 header；响应必须是 JSON）。
- 服务端处理：EXIF 方向校正 → 生成 `1080w`（`photo`，墙/详情展示）与 `400w`（`photoThumb`，列表缩略）→ 原图存档（`url`）。
- **内容安全**：小程序必须接微信 `imgSecCheck`（或自有审核），未通过返回 `422 IMAGE_REJECTED`，前端提示"换一张"；审核结果与照片元数据一起入库。
  - 同步接口 `wxa/img_sec_check` **上限 1MB**：超限必须**拒绝**（`422`），不得放行 —— 放行等于大图可完全绕过审核。
  - 另有异步接口 `wxa/media_check_async` 支持更大文件，但结果靠**微信回调**返回，
    需要公网回调端点 + 验签 + 审核中状态机。仅在确实需要大图直传时才评估。
  - 前端上传前应先压缩（`compressImage`），使常态体积落在限额内。
- 存储：对象存储 + CDN；URL 不可猜测但**不要**依赖保密（分享场景需要公网可达）。
- 限制：超 10 MiB → `413 FILE_TOO_LARGE`；类型不支持 → `415`；频率 20/min → `429`。
- 上传成功后客户端 `photoId` 到记录提交之间，允许先"暂存"（24h 未引用自动清理）。
- **多图**：一次只传一张。**一条记录最多 5 张**（`MAX_PHOTOS = 5`），因此前端最多调 **5 次** `POST /photos`，
  把 5 次返回的 `photoId` 按用户选择顺序组成 `photoIds` 数组，一次性提交给 `POST /records` / `PATCH /records/{id}`（见 §6.2.3 / §6.2.4）。
  上传失败的那张从本次提交里剔除（记录照写）；若最终 `photoIds` 为空数组，表示"没有自定义照片 → 用预置配图"。

#### 6.5.2 `DELETE /photos/{photoId}` — 删除照片（P2）

**用途**：换图后清理旧图（前端现在 `Taro.removeSavedFile`，`pages/compose/index.tsx:112-119`）。
**响应**：`204`；被记录引用 → `409 PHOTO_IN_USE`；不存在/非本人 → `404`。
**多图口径**：只要被**任意**记录（未删除）的**任意一张**照片引用 → `409 PHOTO_IN_USE`（一张照片可以被多条记录共用）。
删记录时由服务端自动回收照片（见 6.2.5），客户端不需要调本接口。

---

### 6.6 字典

#### 6.6.1 `GET /geo/cities` — 城市字典（P1）

**用途**：表单「城市只选不填」与墙的城市分组；多端一致、可运营（加城市不用发版）。
**前端**：`components/CityPicker`、`packages/core/src/geo.ts`（当前内置 208 城 / 34 省）。

**响应 200**

```json
{
  "version": "2026-10-01",
  "updatedAt": "2026-10-01T00:00:00Z",
  "provinces": [
    {
      "province": "北京",
      "cities": ["北京"]
    },
    {
      "province": "四川",
      "cities": ["成都", "乐山", "绵阳", "德阳", "宜宾"]
    }
  ]
}
```

**口径**
- 省按**码点序**升序；省内城市按**码点序**升序（对齐 `provinceCatalogue()`，`packages/core/src/geo.ts:165-178`）。
- 直辖市省名 = 市名（北京/上海/天津/重庆），前端点一下省即落定。
- 表外城市：字典可以不含，记录仍允许存（`city` 不做字典校验）；墙分组时服务端把表外城市归 `"其他"`。
- 支持 `If-None-Match` → `304`；`Cache-Control: public, max-age=86400`。
- 兼容：前端内置表可先保留，接口下发后以服务端为准（P1 切换）。

---

### 6.7 分享（token 门控的匿名只读）

单条记录的分享需要"没登录过的人也能打开"，但**不能让 id 本身成为公开凭据**
（id 一旦贴到群里就永久可读、收不回来）。所以用 shareToken 门控。

#### 6.7.1 `POST /records/{id}/share` — 开启分享（P1）

**请求**：无 body。需鉴权，只能对自己的记录操作。
**响应 200**：
```json
{ "shareToken": "sh_e906da9c7de2cafbaedb3c210fecb6406d5781fd49d194932d62ee894cdeba5d",
  "sharedAt": 1793182500000 }
```
- **幂等**：已分享过则复用原 token —— 否则用户发出去的旧卡片会失效。
- 令牌是 32 字节随机 hex，**不可由 id/时间推导**。
- 他人的记录 → `404`（不泄露存在性）。

#### 6.7.2 `DELETE /records/{id}/share` — 撤销分享（P1）

**请求**：无 body。**响应**：`204`。旧链接立即失效；对未分享的记录也返回 204（幂等）。

#### 6.7.3 `GET /share/records/{id}?token=` — 匿名读一条分享（P1）

**请求**：**免鉴权**（这是分享落地页的唯一入口）。`token` 必填。
**响应 200**：
```json
{ "record": { "id": "rec_...", "eat": "龙抄手", "at": "2026-10-09T12:30", "photo": "https://...", "...": "完整 Record 形状" },
  "shared": true }
```
**口径与安全边界**
- `token` 与记录上的 `shareToken` 严格相等才返回；**不匹配或缺 token 一律 404**，且响应与"记录不存在"完全相同（不泄露存在性）。
- 记录被软删 → 立即 404（**删除即断链**）。`restore` **不会**恢复 `shareToken`，要重新分享。
- 只读：写操作仍走需鉴权的 `/records/*`。
- `Cache-Control: no-store`（记录编辑后分享页要立刻更新）。
- 单独限流，避免成为按 id 枚举的通道。

**前端落地**：卡片路径 `pages/detail/index?id=<id>&share=<token>`；落地页带 `share` 参数时走本接口渲染，并**隐藏编辑/删除**（那是别人的记录且未登录）。

---

### 6.8 运维

#### 6.7.1 `GET /healthz`

```json
{ "status": "ok", "version": "1.0.0", "time": "2026-10-09T04:31:02Z" }
```

无鉴权；不查数据库或用轻量 ping，避免探活打满连接池。

---

## 7. 后端实现参考

### 7.1 建议表结构

```sql
-- 用户
users(
  id            text primary key,            -- usr_<ulid>
  wechat_openid text unique,                 -- 小程序
  device_id     text unique,                 -- H5 匿名
  created_at    timestamptz not null,
  updated_at    timestamptz not null
);

-- 记录
records(
  id            text primary key,            -- rec_<ulid>；禁止 ^g.*_
  user_id       text not null references users(id),
  eat           text not null,               -- 1..60
  shop          text,                        -- 店名快照
  shop_id       text references shops(id),
  city          text,
  district      text,
  rating        smallint not null default 0 check (rating between 0 and 5),
  at_local      char(16) not null,           -- 'YYYY-MM-DDTHH:mm' 直接给前端
  tz_offset     text not null default '+08:00',
  eaten_at_utc  timestamptz not null,        -- 排序 / 游标 / 月份
  note          text,
  photo_ids     text[] not null default '{}',   -- 有序，0..5 个 photo id；封面 = photo_ids[0]
  version       integer not null default 1,
  created_at    timestamptz not null,
  updated_at    timestamptz not null,
  deleted_at    timestamptz                  -- 软删可选
);
create index records_user_time_idx on records(user_id, eaten_at_utc desc, id desc);
create index records_user_city_idx on records(user_id, city, eaten_at_utc desc);
create index records_user_shop_idx on records(user_id, shop_id, eaten_at_utc desc);
create index records_user_eat_idx  on records(user_id, eat);   -- 反复吃 / dishCount

-- 店铺
shops(
  id text primary key,                        -- shp_<ulid>
  user_id text not null references users(id),
  name text not null,
  city text,
  created_at timestamptz not null,
  unique (user_id, name, city)
);

-- 照片
photos(
  id text primary key,                        -- pho_<ulid>
  user_id text not null references users(id),
  url text not null,                          -- 原图
  photo_url text not null,                    -- 1080w
  thumb_url text not null,                    -- 400w
  width int, height int, size int, mime text,
  status text not null default 'approved',    -- approved / rejected
  created_at timestamptz not null,
  deleted_at timestamptz
);

-- 幂等键
idempotency_keys(key text primary key, user_id text, response jsonb, created_at timestamptz);
```

> **多图的存储取舍**：`photo_ids` 用 Postgres 数组（`text[]`）存有序 id 列表，**不能**带外键约束
> （数组元素不支持 FK）——这是有意取舍，引用完整性由**应用层**校验保证
> （`photoIds` 写入前逐个校验存在 / 属于本人 / 未软删 / 已过审）。
> 迁移期可保留旧列 `photo_id` 仅供读取（旧数据 `photo_id` → `photo_ids = [photo_id]`），之后不再写入。
> 用 JSON 存储（如 SQLite 的 `TEXT` 存 JSON 数组）时，读写用 `JSON.stringify` / `JSON.parse`，语义等价。

### 7.2 游标分页（不重不漏）

```sql
-- 第一页
select * from records
where user_id = $1 and deleted_at is null
  and ($city is null or city = $city)
  and ($cityMissing is false or city is null)
order by eaten_at_utc desc, id desc
limit $limit + 1;              -- 多取 1 条判断 hasMore

-- 后续页：cursor 解码为 (c_at, c_id)
select * from records
where user_id = $1 and deleted_at is null
  and (eaten_at_utc, id) < ($c_at, $c_id)      -- 元组比较即 keyset
  and ...同筛选...
order by eaten_at_utc desc, id desc
limit $limit + 1;
```

- `cursor` = base64url(`{"at":"<iso>","id":"<id>"}`)，解码失败 → 400。
- `hasMore` = 取到 `limit+1` 条；返回前 `limit` 条。
- `total` 单独 `count(*)`（同筛选条件）；数据量大时可用近似值或前端不展示。

### 7.3 聚合口径的实现

```sql
-- 城市计数（含未记桶，不含省）
select city, count(*) from records
where user_id=$1 and deleted_at is null
group by city;

-- 墙统计（全量）
select
  count(*) as total,
  count(*) filter (where rating = 5) as five_count,
  count(distinct city) filter (where city is not null and city <> '') as cities,
  count(distinct shop) filter (where shop is not null and shop <> '') as shops,
  count(distinct eat) as dish_count,
  coalesce(sum(rating),0)::numeric / nullif(count(*),0) as avg_rating_all,     -- 0 计入分母
  coalesce(sum(rating) filter (where rating > 0),0)::numeric
    / nullif(count(*) filter (where rating > 0),0) as avg_rating_rated;
-- firstFiveEat：按 eaten_at_utc desc 取第一条 rating=5 的 eat
-- repeated：group by eat having count(*) >= 2 order by count desc, eat collate "zh-Hans-CN"
```

- `avg_rating_all` 对应响应 `avgRating`（前端口径）；`avg_rating_rated` 对应 `avgRatingRated`。
- `repeated` 的 `zh-Hans-CN` 排序：PostgreSQL 可 `collate "zh-Hans-CN-x-icu"`；MySQL 用 `utf8mb4_zh_0900_as_cs`。**若数据库没有中文 collation**：先按 `count DESC` 排，再用应用层 `Intl.Collator('zh-Hans-CN')` 稳定排序（Node/Java/Go 均可），不要用码点序糊弄——前端就是拼音序。
- 省份分组在城市计数之后做：`CITY_PROVINCE` 表（208 城 / 34 省，见附录 A 来源）→ 表外归 `"其他"`；排序规则见 6.3.1。
- 随机：`order by random() limit 1`；带 `excludeId` 时先 `count(*)`，>1 时加 `and id <> $excludeId`。

### 7.4 一致性要求（关键）

1. **列表、城市计数、统计、店铺聚合必须来自同一份记录**（同一 `user_id`、同一删除口径）。
2. 写操作后客户端"写后重拉列表 + 计数 + 统计"；服务端无需推送，但读接口必须强一致（主库读，或读己之写）。
3. 删除/更新后，`/records`、`/records/cities`、`/stats`、`/shops/*` 必须同一次请求内看到新结果（P0 不做缓存即可满足）。
4. 时间：排序/分页游标用 `eaten_at_utc`；**月份聚合（`/records/months`）必须按 `at_local` 归桶**（`to_char(at_local,'YYYY-MM')`），与前端 `at.slice(0,7)` 一致，否则 `+08:00` 时区会把 `2026-11-01T00:00` 误归到 10 月（AC-34）。`at_local` 同时用于展示。`at` 仅用于展示与分组；若历史数据只有 `at`，按 `+08:00` 补 `eaten_at_utc`。

---

## 8. 接口与实现的对应

### 8.1 读写通路对应

| 能力 | 前端 | 后端接口 |
| --- | --- | --- |
| 列表 / 分页 | `src/api/` + `src/data/store-*` | `GET /records?cursor&limit` |
| 单条 / 详情 | 详情页请求态（加载 / 404 空态） | `GET /records/{id}` |
| 新建 / 编辑 / 删除 | `POST`/`PATCH`/`DELETE /records`，成功后重拉列表、计数、统计 | 同左，失败回滚并提示 |
| 随机一道 | `GET /records/random?city&cityMissing&excludeId=` | 同左，`404` 显示空态 |
| 城市计数 / 统计 | `GET /records/cities`、`GET /stats` | 服务端全量聚合 |
| 照片 | `chooseMedia`（最多 5 张）→ `POST /photos` ×N → `photoIds[]` | `POST /photos` 返回 https URL |
| 店铺页 | `GET /shops/{shopId}`，回退 `/shops/by-name?name=` | 店铺聚合 |
| 鉴权 | 冷启动登录；401 时 refresh 重放一次 | `POST /auth/wechat/login`、`POST /auth/refresh` |
| 加载 / 错误态 | 骨架屏、上传中、失败重试、空态 | 幂等键与明确错误码 |

### 8.2 可保留在客户端

- 布局算法 `packages/core/src/layout.ts`（块型 / 坐标、月份分组、中文月名）。
- 统计六行文案的量词（接口只给数字）。
- `photoOf()` 三级回落（`photo = null` 时继续用包内置图）。
- 城市字典（可改用 `GET /geo/cities` 下发）。
- **新用户示例数据**：由服务端为新用户初始化（12 条契约种子），前端不再以 `REAL_RECORDS` 兜底；不对已存在用户重复灌入。

### 8.3 联调核对顺序

1. 登录 + `GET /records`（读通路）→ 墙可翻真数据。
2. `POST/PATCH/DELETE` + `GET /records/{id}`（写通路）→ 贴一张 / 编辑 / 删除可用。
3. `POST /photos` → 照片可跨设备 / 分享。
4. `/records/cities`、`/stats`、`/records/random` → 数字与随机正确。
5. `/shops/*`、`/geo/cities` → 店铺页与字典收口。
6. 新用户示例数据与"删光不回灌"（§8.2）、分享与撤销删除（§6.2.7 / §6.7）。

---

## 9. 接口验收用例

完整用例见 [acceptance.md](./acceptance.md)（AC-01 ~ AC-38）。

---

## 10. 非目标与后续迭代

**本版不做**（接口已预留字段 / 参数位）：

| 能力 | 说明 | 优先级 |
| --- | --- | --- |
| 收藏 / 想去 | 属新功能 | P2 |
| 离线优先同步（变更集/冲突合并） | 在线优先 + 本地缓存，写操作失败重试；离线**写**已明确禁止 | P2 |
| 数据导出 / 年度报告 | 统计已有口径 | P2 |
| 菜名/店名联想、热门城市 | `q` 参数预留 | P2 |
| 评论/点赞/多用户社交 | 非产品方向 | 非目标 |
| 埋点/增长 | 独立体系 | 非目标 |

---

## 11. 待确认问题（后端/产品拍板，前端已给建议）

| # | 问题 | 建议默认 |
| --- | --- | --- |
| 1 | 账号体系：只有微信小程序，还是 H5 也要上线？ | 小程序微信静默登录（P0）+ H5 匿名设备（P1）；不做手机号 / 昵称授权 |
| 2 | 部署形态 | 自建 REST（契约即本文档）或微信云开发（需把接口映射成云函数） |
| 3 | 限流 / 配额 | 普通 60 req/min、上传 20/min；照片总量与存储配额待定 |

---

## 附录 A：城市字典（208 城 / 34 省）

- 唯一事实来源：`photo-wall-mp/packages/core/src/geo.ts` 的 `CITY_PROVINCE`（城市名 → 省名）；由 `server/scripts/gen-data.mjs` 抽取到 `server/src/data/geo-cities.ts`，两端逐字一致。
- 规模：208 个城市条目、34 个省级单位（含北京/上海/天津/重庆 4 个直辖市，省名=市名）；表外城市归 `OTHER_PROVINCE = '其他'`。
- 行政后缀归一：`/(特别行政区|自治区|自治州|地区|省|市|县|区)$/u` 去掉后再查一次（`geo.ts:105`），例如「厦门市」→ 福建、「闽侯县」→ 福建。
- 后端：启动时加载该表，`GET /geo/cities` 按码点序下发；新增城市只改数据，不改接口。
- 记录里**不存省**；`province` 参数由服务端用该表展开。

## 附录 B：前端 `FoodRecord` ↔ 接口 `Record` 字段映射

| 前端字段（`packages/core/src/types/domain.ts:12-26`） | 接口字段 | 处理 |
| --- | --- | --- |
| `id` | `id` | 原样；服务端生成后前端只做等值匹配 |
| `eat` | `eat` | 原样；必填校验 |
| `shop` | `shop` | 原样；`null` = 未记 |
| — | `shopId` | 新增；前端详情「这家店」优先用它 |
| `city` | `city` | 原样；`null` = 未记 |
| `district` | `district` | 原样；历史字段 |
| `rating` | `rating` | 原样；`0` = 未评 |
| `at` | `at` | **格式必须一致** `YYYY-MM-DDTHH:mm` |
| `note` | `note` | 原样；≤200 |
| `photo` | `photo` | 本地路径 → https URL；`null` 时前端回落预置图 |
| `photos`（新增） | `photos` | 前端是**有序 URL 数组**（`string[]`，空 = 用预置配图）；接口是**对象数组**（`{photoId, photo, photoThumb}`）。前端适配层按下标一一对应取 URL |
| — | `photoThumb` / `photoId` / `tzOffset` / `eatenAtUtc` / `version` / `createdAt` / `updatedAt` | 新增；前端可忽略 |
| —（写接口） | `photoIds` | 前端把 `photos` 数组的 `photoId` 组成 `photoIds[]` 提交；PATCH **整体替换**（不传 = 照片不动，`[]` = 清空） |

## 附录 C：交付文件

| 文件 | 内容 |
| --- | --- |
| `docs/api/photo-wall-api.md` | 本文档（契约正文，冲突时以此为准） |
| `docs/api/openapi.yaml` | OpenAPI 3.1 契约，可导入 Apifox/Postman/生成 SDK |
| `docs/api/acceptance.md` | 逐条验收用例（请求/期望/对应前端行为） |
| `docs/api/README.md` | 索引、快速开始 |
