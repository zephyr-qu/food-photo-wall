# 照片墙接口 · 验收用例（v1.1）

> 配套 [photo-wall-api.md](./photo-wall-api.md) 与 [openapi.yaml](./openapi.yaml)。
> 共 38 条用例（AC-01 ~ AC-38）；提测前至少跑完 P0 组（AC-01 ~ AC-20）。

约定：
- `{BASE}` = 环境 base url（如 `https://dev-api.xshifu.example.com/v1`）。
- 所有请求默认带 `Authorization: Bearer <token>`。
- "前端可观察行为"用于联调时人工核对（小程序模拟器/真机）。

---

## 一、账号与鉴权（P0）

### AC-01 微信静默登录（新用户）
- 前置：微信 openid 未注册。
- 请求：`POST /auth/wechat/login`，body `{ "code": "<wx.login 的 code>" }`。
- 期望：`200`；`accessToken`/`refreshToken` 非空；`isNewUser=true`；`user.recordCount=0`。
- 前端：冷启动无感，不弹授权窗；墙展示空态「墙还是空的。」（若启用示例数据则展示示例记录）。

### AC-02 同一 code 重复消费
- 请求：同一 `code` 连续调两次登录。
- 期望：第二次 `401 WECHAT_CODE_INVALID`（微信 code 一次性）。
- 前端：自动重新 `Taro.login()` 取新 code 后重试一次。

### AC-03 token 过期与刷新
- 前置：构造 `accessToken` 过期（或等待）。
- 请求：`GET /records` 携带过期 token。
- 期望：`401` + `error.code=TOKEN_EXPIRED`。
- 请求：`POST /auth/refresh` 携 `refreshToken`。
- 期望：`200` 新 token；用新 token 重放 `GET /records` 成功。
- 前端：用户无感，只重放一次；refresh 失败则清 token 重新登录，**不得进入 401 循环**。

### AC-04 越权访问他人记录
- 前置：用户 A、B 各一条记录。
- 请求：用户 B 请求 `GET /records/{A 的 id}`、`PATCH`、`DELETE`。
- 期望：全部 `404 NOT_FOUND`（不是 403）。
- 前端：详情页空态「这一条已经不在了」。

---

## 二、列表与分页（P0）

### AC-05 空数据首屏
- 请求：新账号 `GET /records`。
- 期望：`200`；`items=[]`；`hasMore=false`；`nextCursor=null`；`total=0`。
- 前端：墙空态「墙还是空的。 / 贴一张试试。」。

### AC-06 分页不重不漏
- 前置：造 25 条记录，`at` 为 25 个连续日期（如 `2026-09-01` 起每天 +1 天，每条取同日不同时刻以拉开 id），全部由近到远倒序可定位。
- 请求：连续请求 `GET /records?limit=10`，每次带上一页 `nextCursor`。
- 期望：第 1 页 10 条、第 2 页 10 条、第 3 页 5 条且 `hasMore=false`；三页 id 无重复、无遗漏；所有条目严格 `at` 倒序。
- 前端：触底加载 3 次后停止请求；墙面总高度随记录增加。

### AC-07 同分钟多条（id 兜底）
- 前置：3 条记录 `at` 完全相同，`limit=2`。
- 期望：翻两页拿全 3 条，不重不漏（`(eaten_at_utc, id)` keyset）。
- 前端：无 React duplicate key 告警，墙上 3 块。

### AC-08 翻页期间新增记录
- 前置：已翻到第 2 页。
- 请求：新增 1 条最新记录后，继续用第 2 页的 cursor 取第 3 页。
- 期望：第 3 页不重复第 1/2 页内容；新记录不在旧 cursor 的结果里（下次刷新才出现）。
- 前端：不需要特殊处理；下拉刷新后新记录出现在顶部。

### AC-09 非法游标 / 非法 limit
- 请求：`GET /records?cursor=not-base64` → `400 BAD_REQUEST`。
- 请求：`GET /records?limit=0` / `limit=51` → `400 BAD_REQUEST`（`limit` 1–50）。
- 前端：提示"加载失败，请重试"，不崩。

### AC-10 城市筛选三种语义
- 前置：记录含 `city=成都`、`city=乐山`、`city=null`。
- 请求：① 无参数 → 全部；② `?city=成都` → 只含成都；③ `?cityMissing=true` → 只含 null。
- 期望：三种结果条数与 `/records/cities` 的 `total / cityCounts / uncityCount` 对应一致。
- 额外：`?city=成都&cityMissing=true` → `400`。
- 前端：顶栏城市按钮文字「成都」/「未记」/「城市」；墙原地重排并回到顶部。

---

## 三、创建 / 编辑 / 删除（P0）

### AC-11 最小字段创建
- 请求：`POST /records`，body `{ "eat": "甜水面" }`。
- 期望：`201`；`id` 非空且服务端生成；`rating=0`；`shop/city/district/note/photo/photoThumb/shopId=null`；`at` 为当前时刻 `YYYY-MM-DDTHH:mm`；`version=1`；`createdAt/updatedAt` 存在。
- 前端：toast「贴上了」→ 回墙，新记录在首位（若是最新时间）。

### AC-12 菜名校验
- 请求：`{"eat":"   "}`、`{"eat":""}`、缺 `eat`、`eat` 61 个字符。
- 期望：全部 `422 VALIDATION_FAILED`，`error.fields.eat` 有文案。
- 前端：字段标红，文案「吃了什么是必填」；不提交。

### AC-13 空串归一为 null
- 请求：`{"eat":"冰粉","shop":"","city":"","note":"","district":""}`。
- 期望：`201`；响应中 `shop/city/note/district` 均为 `null`（不是 `""`）。
- 前端：墙图注回落「没记店名」；统计店铺去重不受影响。

### AC-14 评分边界
- 请求：`rating` 分别传 `-1`、`6`、`2.5`、`"3"`。
- 期望：`-1/6/2.5` → `422`（整数 0–5）；`"3"` 建议 `422`（类型严格）或服务端转 3，**需在联调前定死**（建议 422）。
- 前端：只能点 0–5 圆点，正常不会触发。

### AC-15 时间：默认与补记
- 请求 A：不传 `at` → 期望 `at` = 服务端当前本地（时区 `+08:00`）。
- 请求 B：传 `at="2026-01-02T03:04"` → 期望 `201`，响应 `at` 原样，`eatenAtUtc` 对应换算；列表按该时间参与排序。
- 请求 C：传 `at="2030-01-01T00:00"`（未来）→ `422`（`fields.at`）。
- 请求 D：传 `at="2026/01/02 03:04"`（错误格式）→ `422`。
- 前端：当前 UI 不传 `at`（走 A）；B/D 供后续补记功能。

### AC-16 创建幂等
- 请求：同一 `Idempotency-Key: k1` 连发两次相同 body。
- 期望：第一次 `201`（`Idempotent-Replayed` 不出现）；第二次 `201` + `Idempotent-Replayed: true`，`id` 与第一次相同；数据库只有 1 条。
- 前端：弱网自动重试不产生重复照片块。

### AC-17 编辑局部更新
- 前置：一条 `eat=甜水面, rating=5, note="x", at="2026-10-09T12:30", version=1`。
- 请求：`PATCH /records/{id}` body `{"note": null, "rating": 4}`。
- 期望：`200`；`note=null`、`rating=4`；`eat`、`at`、`createdAt` 不变；`version=2`、`updatedAt` 变化。
- 前端：详情页返回后自动显示新值（页面栈未卸载，前端用订阅/重拉）。

### AC-18 编辑照片
- 请求：`PATCH` body `{"photoId": "pho_new"}` → 响应 `photo/photoThumb/photoId` 均更新。
- 请求：`PATCH` body `{"photoId": null}` → 响应三者均 `null`（前端回落预置图）。
- 请求：`PATCH` body `{"photoId": "pho_别人的"}` → `422 fields.photoId`。

### AC-19 编辑不存在的记录
- 请求：`PATCH /records/rec_not_exist` → `404 NOT_FOUND`。
- 前端：编辑页应提示"这条记录不在了"并返回（当前前端会变空白表单，需改）。

### AC-20 删除与级联
- 请求：`DELETE /records/{id}` → `204`。
- 再次 `DELETE` 同 id → `204`（幂等）。
- 请求 `GET /records/{id}` → `404`。
- 期望：列表少一条；`/records/cities` 计数减 1；`/stats` total 减 1；该记录照片若不再被引用，30 天内被清理（可查 `photos.deleted_at` 或对象存储生命周期）。
- 前端：确认弹窗「删除这一条？」→ toast「已删除」→ 返回墙。

---

## 四、聚合（P0）

### AC-21 城市计数与省分组
- 前置：记录分布 成都×3、乐山×2、北京×2、景德镇×1（注：景德镇在字典内，归「江西」，不是表外）、未记×1（共 9 条）。
- 请求：`GET /records/cities`。
- 期望：
  - `total=9`、`uncityCount=1`；
  - `cityCounts` 按 count 降序，同数按拼音序；含 `成都:3`、`乐山:2`、`北京:2`、`景德镇:1`（均不计未记桶）；
  - `provinces` 中「四川」count=5（成都 3 / 乐山 2）、「北京」count=2、「江西」count=1（景德镇）；未记**不出现**在 provinces；
  - 省/市排序分别在 count 降序后按码点序。
- **不变量**（可写成自动化断言）：
  - `sum(cityCounts.count) + uncityCount === total`（cityCounts 不含未记桶）；
  - `sum(provinces.count) + uncityCount === total`；
  - 对任意城市 `c`：`cityCounts[c]` 等于 `GET /records?city=c` 的 `total`（`cityMissing=true` 对应 `uncityCount`）。
- 前端：城市卡片一级「全部 9 / 四川 5 / 北京 2 / 江西 1 / 未记 1」，点四川进二级见成都/乐山。

### AC-22 统计口径（重点）
- 前置：造 4 条：`(rating=5, eat=甜水面, city=成都)`、`(rating=5, eat=甜水面, city=成都)`、`(rating=0, eat=冰粉, city=null)`、`(rating=4, eat=烤鸭, city=北京)`。
- 请求：`GET /stats`。
- 期望：
  - `total=4`、`fiveCount=2`、`firstFiveEat="甜水面"`（最新一条五分）；
  - `cities=2`（成都、北京；null 不计）、`shops` 按字段算、`dishCount=3`；
  - `avgRating = (5+5+0+4)/4 = 3.5`（**0 分计入分母**）；`ratedCount=3`、`avgRatingRated=14/3≈4.67`；
  - `repeated=[{"eat":"甜水面","count":2}]`（≥2，次数降序；不做 top3 截断）。
- 前端：统计浮层显示 `4 张照片 / 2 道（甜水面）/ 2 座城市 / N 家店 / 3.5 / 重复行`。

### AC-23 统计不受城市筛选影响
- 前置：同 AC-22，墙上切到「成都」。
- 请求：`GET /stats`（无参数）。
- 期望：数字与 AC-22 完全一致（全量口径）。
- 前端：统计浮层数字不随城市筛选变化（与 Taro 现状一致）。

### AC-24 随机一道
- 前置：6 条记录，2 条成都、4 条其他。
- 请求：`GET /records/random` 连续 50 次。
- 期望：每次 `200`；返回记录属于当前用户；分布大致均匀（非确定性，用统计粗验）。
- 请求：`GET /records/random?excludeId=<上一条>` 连续 20 次 → **不返回 excludeId**（候选 >1 时）。
- 请求：`GET /records/random?city=成都&excludeId=<成都唯一一条>` → 只有 1 条候选时允许返回它。
- 请求：`GET /records/random?city=不存在的城市` → `404`，`error.code=NO_RECORD`。
- 响应头：`Cache-Control: no-store`。
- 前端：点「随机一道」浮窗出现；「换一个」不出现同一道；空候选提示空态。

---

## 五、店铺（P1）

### AC-25 店铺聚合（按名）
- 前置：记录 `(shop=四季民福, city=北京, rating=5, at=2026-09-30T18:00)`、`(shop=四季民福, city=北京, rating=4, at=2026-10-09T12:30)`。
- 请求：`GET /shops/by-name?name=四季民福`。
- 期望：`visitCount=2`、`dishCount=2`、`avgRating=4.5`（只算已评）、`fiveCount=1`、`firstAt=2026-09-30T18:00`、`lastAt=2026-10-09T12:30`、`records` 倒序。
- 前端：店铺页显示「去过 2 次 / 点过 2 道 / 均分 4.5 / 五分 1 / 第一次 2026.09.30 / 最近 2026.10.09」。

### AC-26 同名跨城店
- 前置：北京「老张面馆」、上海「老张面馆」。
- 请求：`GET /shops/by-name?name=老张面馆`。
- 期望：合并聚合（与客户端口径一致），`candidates` 给两家店 id/cities；不报错。
- 请求：`GET /shops/by-name?name=老张面馆&city=北京` → 只聚合北京那家。

### AC-27 店铺无记录
- 请求：`GET /shops/by-name?name=不存在` → `404`。
- 前端：空态「这家店还没有记录」。

---

## 六、照片（P0）

### AC-28 正常上传
- 请求：`POST /photos` multipart，传一张 1600×1200 JPEG（500KB）。
- 期望：`201`；`photoId` 非空；`url`/`photo`/`photoThumb` 三个 https URL 都可匿名访问（200）；`width=1600`、`height=1200`；`status=approved`。
- 前端：选图后缩略图立即显示（先用本地临时路径），提交成功后墙上用 CDN URL。

### AC-29 图片限制
- 11 MiB JPEG → `413 FILE_TOO_LARGE`。
- `.gif` / `.pdf` → `415 UNSUPPORTED_MEDIA_TYPE`。
- 无 `file` 字段 → `422 VALIDATION_FAILED`。
- 前端：提示"照片太大了/格式不支持"，不进入提交。

### AC-30 内容安全
- 前置：构造会被审核拒绝的图片（测试环境 mock `imgSecCheck` 返回失败）。
- 期望：`422 IMAGE_REJECTED`；照片不入库或状态 `rejected`，不可被记录引用。
- 前端：提示"这张图没通过审核，换一张"。

### AC-30b 内容安全：大图不得绕过审核
- 前置：上传一张**结构合法**但 >1MB 的图（同步审核接口的上限）。
- 期望：`422 IMAGE_REJECTED`，且**原因明确指向体积上限**（而非"图片损坏"）；
  照片不入库；**不得**因为超限而放行（否则大图可完全绕过审核）。
- 对照：结构合法且 ≤1MB 的图不应被这条规则拦下（走正常审核路径）。

### AC-31 照片引用校验
- 请求：`POST /records` 带 `photoId` 属于其他用户 → `422 fields.photoId`。
- 请求：`POST /records` 带不存在的 `photoId` → `422 fields.photoId`。

---

## 七、字典与运维（P1）

### AC-32 城市字典
- 请求：`GET /geo/cities`。
- 期望：省 34 个（含 4 直辖市）、城市 208 个；省/市均码点序；响应带 `ETag`。
- 请求：带 `If-None-Match: <上一步 ETag>` → `304`（无 body）。
- 前端：表单城市选择器显示「省 → 市」，直辖市点一下就落定。

### AC-33 健康检查
- 请求：`GET /healthz` → `200 {"status":"ok",...}`，无需鉴权，响应 < 100ms。

### AC-34 月份桶与时区边界（P2）
- 前置：两条记录 `at="2026-10-31T23:59"`、`at="2026-11-01T00:00"`，时区均 `+08:00`。
- 请求：`GET /records/months`。
- 期望：分别落入 `2026-10` 与 `2026-11` 两个桶，各 count=1。重点：`at="2026-11-01T00:00"`（+08:00）的 UTC 是 `2026-10-31T16:00`，若服务端**按 UTC 归桶**会错误地把它归到 `2026-10`；正确实现必须按 `at_local`（`at` 直接 `slice(0,7)`）归桶，仍是 `2026-11`。
- 请求：`GET /records/months` 返回的 `firstCursor` 传给 `GET /records?cursor=` → 返回该月第一条**之后**的列表（因 keyset 严格 `<`，该月第一条会漏）。
- 请求：`GET /records?cursor=<months.firstCursorInclusive>&cursorInclusive=true` → **必须包含该月最新一条**，且它排在结果第一位。这是月轴跳转的正确用法。
  - 期望 `firstCursorInclusive === firstCursor`（同一串游标值，语义由请求参数决定）。
  - 反例（必须不通过）：只传 `cursor` 而不传 `cursorInclusive` → 结果里**不含**该条。
- 前端：月轴点/拖某月时用 `firstCursorInclusive + cursorInclusive=true` 定位（或 `from/to` 整月区间）。

### AC-35 撤销删除（P1）
- 前置：一条记录，`DELETE` 成功。
- 请求：`POST /records/{id}/restore`。
- 期望：`200`；返回记录 `id`、`at` 与删除前一致；`GET /records` 中回到原时间位置（不是排到最前）。
- 再次 `restore` 同一条（已恢复）→ `200` 幂等或 `409`，需在联调前定死（建议 200 幂等）。
- 超过撤销窗口（30 天）→ `410`。
- 前端：（Taro 当前无撤销）

---

## 八、多图（P0）

> 一条记录**至多 5 张**照片（`MAX_PHOTOS = 5`）。响应新增 `photos[]`（有序），封面 = `photos[0]`；
> 旧字段 `photo` / `photoThumb` / `photoId` 继续返回**封面**，兼容期保留。
> 写接口用 `photoIds[]`；`photos` 为空数组 = 没有自定义照片 → 用预置配图。

### AC-36 记录支持至多 5 张照片
- 前置：已上传 6 张属于当前用户的照片（`pho_1` … `pho_6`）。
- 请求：`POST /records`，body `{ "eat": "甜水面", "photoIds": ["pho_1","pho_2","pho_3","pho_4","pho_5"] }`。
- 期望：`201`；响应 `photos` 长度 = 5，**顺序与提交一致**（`photos[0].photoId = "pho_1"` … `photos[4].photoId = "pho_5"`）；
  `photo` / `photoThumb` / `photoId` 三字段 = `photos[0]`（即 `pho_1` 的图）；`photos[].photo` 是 1080w、`photos[].photoThumb` 是 400w。
- 请求：body `photoIds` 传 **6** 个 → `422 VALIDATION_FAILED`，`error.fields.photoIds` 有文案（如「最多 5 张照片」）。
- 请求：body `photoIds` 传**重复** id（如 `["pho_1","pho_1"]`）→ `422`，`error.fields.photoIds`（如「照片不能重复」）。
- 请求：body `photoIds` 里含**别人的** photoId → `422`，`error.fields.photoIds`（如「照片不存在」）；不泄露该 id 是否存在。
- 请求：body **不传** `photoIds` → `201`，`photos = []`，`photo` / `photoThumb` / `photoId` 均为 `null`（用预置配图）；
  传 `photoIds: []` 同样得到 `photos = []`。
- 前端：详情页可在 5 张之间切换；墙上该条随机显示其中一张。

### AC-37 编辑照片集合
- 前置：一条记录，当前有 3 张照片（`photos` 长度 3），`version = 1`。
- 请求：`PATCH /records/{id}` body `{ "photoIds": ["pho_9","pho_8"] }`（2 张）。
- 期望：`200`；`photos` **整体替换**为这 2 张（长度 2，顺序 = 提交顺序），**不是追加**（原 3 张不再出现）；
  `photo` / `photoThumb` / `photoId` = `photos[0]`；`version` +1。
- 请求：`PATCH` body `{ "photoIds": [] }` → `200`；`photos = []`；`photo` / `photoThumb` / `photoId` **全部为 `null`**（回到预置配图）。
- 请求：`PATCH` body **不带** `photoIds`（只改 `note`）→ `200`；`photos` **不变**（仍 3 张，顺序不变），照片不动。
- 请求：`PATCH` body `{ "photoId": "pho_7" }`（旧字段，单独使用）→ `200`；等价 `photoIds: ["pho_7"]`，`photos` 长度 1。
- 请求：`PATCH` body `{ "photoIds": ["pho_9"], "photoId": "pho_7" }`（两者同传）→ `200`；**`photoIds` 优先**，`photoId` 被忽略（不报错），`photos` = `["pho_9"]`。
- 请求：`PATCH` body `{ "photoIds": ["pho_别人的"] }` → `422`，`error.fields.photoIds`。
- 前端：编辑页保存后返回详情页，图片集合与墙上显示同步。

### AC-38 照片引用与级联按多张
- 前置：记录 A 有 3 张照片（`pho_a1`/`pho_a2`/`pho_a3`）；记录 B 单独引用 `pho_a2`。
- 请求：`DELETE /records/{A 的 id}` → `204`。
- 期望：A 的 3 张照片**全部级联软删**（标记待回收，30 天内清理）；其中 `pho_a2` 因仍被记录 B 引用 → **不删**；
  `pho_a1` / `pho_a3` 被软删；`GET /records/{A 的 id}` → `404`。
- 请求：`DELETE /photos/pho_a2`（仍被 B 引用）→ `409 PHOTO_IN_USE`。
- 请求：`DELETE /photos/pho_a1`（已随 A 级联软删、无其他引用）→ `204`（或与回收策略一致的等价结果）。
- 前端：删除一条多图记录后，墙上该条消失；被其他记录共用的照片不会被误清（详情页仍能显示）。

---

## 九、非功能（P0/P1）

| # | 项 | 期望 |
| --- | --- | --- |
| N-01 | 响应时间 | 所有读接口 P95 < 300ms（不含图片 CDN）；写接口 P95 < 500ms |
| N-02 | 限流 | 60 req/min/用户；超限 `429` + `Retry-After` |
| N-02b | 限流不可被伪造头绕过 | 未登录请求**每次换一个伪造的 `X-Forwarded-For`** 连续打 N 次：超限后仍必须 `429`（不得因 key 变化而全部放行）。已登录请求按 `userId` 分组，与代理头无关；反代部署时按 `X-Forwarded-For` 的**最右一跳**分组。 |
| N-03 | 并发写同一条 | 两个 PATCH 同时到达：串行化，`version` 单调递增，不丢失更新（或后到者 409） |
| N-04 | 字符与编码 | 中文/emoji 菜名（如「🍜 拉面」）正确存储与返回；URL query 编码正确 |
| N-05 | 长文本 | `note` 200 字（含换行）完整返回；超 200 → 422 |
| N-06 | 日志与排障 | 响应带 `X-Request-Id`；错误体含 `requestId`；日志可按 userId/requestId 检索 |
| N-07 | 数据隔离 | 任何接口都不能跨用户泄漏（含随机、聚合、店铺、照片） |
| N-08 | 幂等与重试 | 弱网下重复提交同 key 不产生重复数据；重复 DELETE 不报错 |

---

## 十、前端联调核对清单（人工）

- [ ] 冷启动静默登录，无授权弹窗
- [ ] 首屏 10 条、触底加载、到底不再请求（无"空转"）
- [ ] 墙上图片全部显示（CDN URL 可访问，无 404/白块）
- [ ] 城市筛选：全部/省/市/未记；计数不随筛选变
- [ ] 日期开关：按月分组、中文月名、副行「年份 · N 张」
- [ ] 统计浮层数字与 AC-22 口径一致；不随筛选变
- [ ] 随机一道：「换一个」不重复；空候选有提示
- [ ] 贴一张：菜名必填；照片上传中/fail 有状态；成功后回墙可见
- [ ] 编辑：字段回填、保存后详情与墙同步
- [ ] 删除：确认弹窗、删除后墙/统计/计数同步
- [ ] 详情分享路径带 id；他人打开（P1）能读到或给出合理提示
- [ ] 店铺页：从详情「这家店」进入，统计与照片格正确
- [ ] 弱网/断网：有错误提示与重试，不白屏
