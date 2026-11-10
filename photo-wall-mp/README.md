# photo-wall-mp monorepo

X师傅美食记 · 照片墙。

```
photo-wall-mp/
└── packages/
    ├── core/     纯 TS 逻辑 + 单测
    └── ui-taro/  Taro 4.3 · 微信小程序 + H5
```

## 快速开始

```bash
npm install          # 首次

npm run verify       # lint + typecheck + test + build:weapp + build:h5 一条龙
npm run build:weapp  # 只构建小程序
npm run build:h5     # 只构建 H5
npm run test         # 只跑单测
npm run lint         # ESLint
```

用微信开发者工具打开 `packages/ui-taro`（需先 build）。

## packages/core

纯逻辑层，不依赖任何 UI 框架。

| 文件 | 内容 |
|---|---|
| `src/types/domain.ts` | `FoodRecord` / `LayoutTile` / `WallSection` 等数据形状 |
| `src/records.ts` | 预置数据、照片映射、日期工具、`parseAt`（iOS 兼容） |
| `src/layout.ts` | **4 列 masonry 布局**（填最矮列 + 3 行块型节奏，数据 → 坐标，纯函数） |
| `src/photo-path.ts` | 照片地址分类：本机文件 / 云 URL / 包内静态 / 空（纯函数） |
| `src/persistence.ts` | 冷启动该用 storage 还是预置数据（纯函数） |
| `src/index.ts` | 统一出口 |
| `test/` | 102 个 `node:test` 单测 |

规则：**core 里不许 import React / Taro / react-native**。

### 布局算法：填最矮列 + 3 行块型节奏

- 经典 masonry —— 每个块放进当前最矮的列；
- 块型由「3 行一循环」的节奏决定：`hero`(2×2) / `wide`(2×1) / `tall`(1×2) / `small`(1×1)，12 条记录正好铺满 4 列，**默认视图（连续墙）实测空洞为 0**。

## packages/ui-taro

微信小程序 + H5。

| | 产物目录 |
|---|---|
| weapp | `dist/` |
| h5 | `dist-web/` |

两个目录互不影响：`outputRoot` 随 `TARO_ENV` 切换。

### 隐私授权 / 分享 / 照片上云

| 事 | 代码位置 | 现状 | 上线前的外部配置 |
|---|---|---|---|
| 隐私授权 | `src/utils/privacy.ts` + `src/components/PrivacyGate/` | 已注册 `onNeedPrivacyAuthorization`，弹纸色「隐私保护提示」，同意按钮是 `open-type="agreePrivacyAuthorization"` | 小程序后台「设置 → 服务内容声明 → 用户隐私保护指引」里声明相册、摄像头用途（否则真机仍会拦） |
| 转发 / 朋友圈 | `src/utils/share.ts` | 墙页转发 + 朋友圈（封面 `static/img/share-cover.jpg` / `share-timeline.jpg`）；**单条记录已开启**（`RECORD_SHARE_ENABLED = true`，详情页 `onShareAppMessage`，分享落地页免登录只读） | 无 |
| 照片上云 | `src/utils/photo.ts` + `src/api` | 选图 → `compressImage` → `saveFile`（本机预览）→ 提交时 `POST /photos` 拿 `photoId` + https URL；上传失败**不阻断提交**，降级本机路径并提示；换图/放弃编辑会清孤儿文件 | 小程序后台配置 `uploadFile` 合法域名（照片走 `/v1/photos`） |

### 数据层（docs/api 契约）

`src/data/store.ts` 是**远程数据层**；页面只认 `FoodRecord`，接口形状在 `src/data/adapters.ts` 转换。

| 关注点 | 做法 |
|---|---|
| 列表 | `GET /records`（`FIRST_PAGE_SIZE=20` 首屏 / `PAGE_SIZE=10` 翻页，keyset 游标 + `hasMore`）；`city` / `cityMissing` 表达筛选 |
| 聚合 | `GET /records/cities` + `GET /stats` **服务端算** |
| 随机 | `GET /records/random`（池子是全库，带 `excludeId`） |
| 店铺 | `GET /shops/by-name`（过渡；有 `shopId` 后切 `/shops/{id}`） |
| 写 | `POST/PATCH/DELETE /records`；`POST` 带 `Idempotency-Key`，写成功后 `refreshAll()` 让墙/计数/统计同源 |
| 会话 | `wx.login` → `POST /auth/wechat/login`（H5 走 `/auth/anonymous`）；401 刷新一次并只重放一次 |
| 降级 | 网络失败回落到本机 storage 缓存，顶栏显示「离线」；首屏骨架、失败重试、到底提示都已补 |

配置在 `src/config.ts`：`API_BASE_URL`（默认 `http://127.0.0.1:8787/v1`，契约默认端口）、`USE_REMOTE_DATA`（硬编码 `true` = 远程模式；`false` 回纯本地演示）。

本地跑通全链路：

```bash
npm run server      # 零依赖 mock 后端，127.0.0.1:8788（8787 留给真后端）
npm run build:weapp # 开发者工具打开 packages/ui-taro（urlCheck 已关）
npm run server:test # 89 条契约测试
```

## 工程约定

- `core` 新增逻辑配单测
- 样式里不要混写 `px`，一律 `rpx`
- 颜色只用 `styles/_tokens.scss` 里的语义令牌；文字对比度需满足 WCAG AA（4.5:1）

- `photo-wall-mp/package-lock.json` 必须含**各平台**原生包条目（`@swc/core-*`、`@tarojs/binding-*`、
  `@tarojs/plugin-doctor-*`、`@esbuild/*`、`@parcel/watcher-*`）。只在某一个平台上增量生成的 lock
  会漏掉其它平台的原生包，Linux 上 `npm ci` 后 `taro build` 就报 `Bindings not found` 或
  `Cannot find module '@tarojs/plugin-doctor-linux-x64-gnu'`。
  遇到时删掉 lock 重新 `npm install` 生成完整的，并确认 CI 的构建步骤通过。

## 已知待办

- [x] 小程序隐私授权：`onNeedPrivacyAuthorization` + 隐私弹窗（`PrivacyGate`），选图失败分 cancel / privacy / 权限三类处理
- [x] 分享：墙页转发 + 朋友圈 + 自定义封面；详情页单条转发已开（`RECORD_SHARE_ENABLED`，分享落地页免登录只读，e2e 覆盖分享/撤回两条路径）
- [x] 照片：压缩后 `saveFile`、换图/放弃编辑清孤儿文件、提交时上传换 https URL
- [x] 接后端：`store.ts` 改为远程数据层（真分页 / 服务端聚合 / 随机 / 店铺 / 写通路），mock 后端 `server/` 按 `docs/api` 契约落地，89 条契约测试
- [ ] 上线前在小程序后台声明隐私保护指引（相册/摄像头）、配置 `request`/`uploadFile` 合法域名，并在真机验一次首装选图
- [ ] `tsconfig` 仍是 `strict: false`，逐步收紧（`strictNullChecks` 已开，剩 `strictFunctionType`/`noImplicitAny` 等）
