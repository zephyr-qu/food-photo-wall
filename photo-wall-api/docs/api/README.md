# 照片墙 · 后端接口文档

「X师傅美食记 · 照片墙」前端与真后端之间的接口契约。

后端 `/v1/openapi.yaml` 与 `/v1/docs`（Swagger UI）直接读本目录的 `openapi.yaml`，部署时需一并分发。

## 文件

| 文件 | 用途 |
| --- | --- |
| [photo-wall-api.md](./photo-wall-api.md) | 主文档：约束、资源模型、23 个接口详情、统计口径、非目标、待确认问题 |
| [openapi.yaml](./openapi.yaml) | OpenAPI 3.1 契约（23 个 operation） |
| [acceptance.md](./acceptance.md) | 39 条验收用例（AC-01 ~ AC-38，含 AC-30b） |
| [../../server/](../../server/README.md) | Hono 实现（102 个测试覆盖 AC-01~38，自带 Swagger） |

## 从哪儿读起

1. 主文档 **§2 接口设计约束** 和 **§5 接口总表**，这两节可避免大部分误读。
2. 拿 `acceptance.md` 的 **P0 组（AC-01 ~ AC-20）** 自测。
3. 口径有争议以主文档文字为准；OpenAPI 与主文档冲突时改 OpenAPI。

## 预置图托管（`/v1/files/:name`）

契约之外的便利路由，供自托管部署使用。契约中 `photo` 恒为 https URL，本路由不改变这一点。取文件按顺序回退两处：

1. `STORAGE_DIR` 里的上传文件（`pho_<id>.<ext>`，同一个文件充当三档尺寸）；
2. 预置图目录 —— 前端把 `TARO_APP_ASSET_BASE` 指向本服务时才会命中。

`resolveAssetUrl()` 会把 `/static/img/kaoya.jpg` 拍平成 `<base>/kaoya.jpg`，所以两种 URL 形态都成立：`/v1/files/kaoya.jpg` 和 `/v1/files/static/img/kaoya.jpg`。

预置图目录依次探测 `PRESET_ASSET_DIR` → `<server>/static/img` → `photo-wall-mp/packages/ui-taro/src/static/img` → `photo-wall-mp/server/static/img`（见 `server/src/lib/preset-assets.ts`），启动日志会打印选中的那个。

## 契约要点

1. **`at` 格式**：`YYYY-MM-DDTHH:mm`，本地墙钟，不带时区、不带秒。多写一个 `Z` 或偏移量不会报错，只会静默算错。
2. **排序**：`eatenAtUtc` 倒序，`id` 兜底；游标是 `(eatenAtUtc, id)`，每页默认 10 条。
3. **聚合在服务端算**：城市计数、统计、随机、店铺页。分页之后客户端不再持有全量数据，无法自行计算。
4. **统计默认全量**；`avgRating` 的分母含未评分（0），另给一个 `avgRatingRated`。
5. **`photo` 是 https URL**，`photo = null` 表示用预置配图。一条记录**至多 5 张**：响应里 `photos[]` 有序，`photos[0]` 就是封面；写接口用 `photoIds[]`，`POST` 缺省或 `[]` 表示无照片，`PATCH` 是整体替换（不传 = 不动，`[]` = 清空）。旧字段 `photo` / `photoThumb` / `photoId` 恒等于封面，兼容期保留。
6. **空值统一归一为 `null`**；`rating=0` 表示未评；`id` 不透明，禁止 `^g.*_` 形态。

## 版本

- v1.0（2026-10-27）：20 个接口，35 条验收用例。
- v1.1（2026-10-29）：多图，至多 5 张；新增 `photos[]` / `photoIds[]`，验收用例增至 38 条。
- v1.2（2026-11）：软删恢复、分享三接口、顶栏概数；§5 总表与 OpenAPI operation 增至 23 个，验收用例 39 条。
- 破坏性变更升 `/v2`。新增可选字段或接口，只往版本记录里追加。
