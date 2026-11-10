# @photo-wall/ui-taro

小程序 + H5 端（Taro 4.3 + React 18）。一套代码出 `dist/`（小程序）与 `dist-web/`（H5），共享逻辑在 `@photo-wall/core`。

## 1. 跑起来

```bash
# 小程序（project.config.json 的 miniprogramRoot 是 dist/）
npm run build:weapp          # 或 dev:weapp 持续构建

# H5
npm run build:h5
npx serve -l 5195 dist-web   # http://127.0.0.1:5195/
```

后端默认 `http://localhost:8787/v1`。

用微信开发者工具打开本目录即可（`miniprogramRoot` 指向 `dist/`，`urlCheck` 已关）。
仓库里的 `appid` 是 `touristappid`（游客模式：能看界面，不能预览/上传/调真机接口）——
换成你自己的小程序 AppID，**改完别提交**（本项目公开仓库刻意不携带真实 AppID）。

## 2. 常用命令

| 命令 | 作用 |
| --- | --- |
| `npm run build:weapp` | 构建小程序到 `dist/` |
| `npm run build:h5` | 构建 H5 到 `dist-web/` |
| `npm run typecheck` | `tsc --noEmit`（strict） |
| `npm test` | 单测（`node --test`，67 条） |
| `npm run e2e` | H5 端到端（Playwright，16 条） |
| `npm run size` | 主包体积门禁（超预算退出码 1） |
| `npm run sync:contract` | 同步 `openapi.yaml` 快照到 `test/fixtures/` |
| `npm run compress:img` | 压缩 `src/static/img` 预置配图 |

## 3. 后端地址配置

构建期：`packages/ui-taro/.env`（只有 `TARO_APP_` 前缀会内联进产物）

```ini
TARO_APP_API_PORT=8787        # 契约默认端口
TARO_APP_API_ORIGIN=          # 填了它完全接管（正式环境用 https 域名）
TARO_APP_LAN_HOST=            # 真机联调的局域网 IP
```

个人差异写 `.env.local`（已 gitignore）。

运行时覆盖（仅 H5，刷新即生效）：

```
http://127.0.0.1:5195/?api=http://127.0.0.1:8789
```

写入 `localStorage['photo-wall:api-origin']`。只接受本机 / 局域网 / 同源地址（`localhost`、`127.0.0.1`、`10.*`、`172.16–31.*`、`192.168.*` 或同 origin），其它拒绝并清除 —— 防止 `?api=` 链接导走会话令牌。

### 发版构建

```bash
RELEASE=1 TARO_APP_API_ORIGIN=https://api.example.com npm run build:weapp
```

`RELEASE=1` 时缺 `TARO_APP_API_ORIGIN` 直接构建失败，防止把 localhost 发到真机。本地 verify / E2E 不要带该标记。同时在微信后台「开发管理 → 服务器域名」配置 request / uploadFile 合法域名。

> 8787 = 真后端，8788 = 零依赖 mock（离线演示用，会给新用户灌 101 条演示数据）。

## 4. 端到端测试

```bash
# 1) 起关限流 + 空库的专用后端（E2E 不要打 8787，有限流会 429）
cd ../../photo-wall-api/server && node scripts/e2e-server.mjs 8789

# 2) 构建 H5 并跑
cd packages/ui-taro && npm run build:h5 && npm run e2e
```

16 条用例覆盖空态/有数据、日期分组与月轴跳月、删除+5 秒撤销、编辑回显、城市两级筛选、分享落地页、离线只读、运行时后端白名单、过期会话自愈。

- spec 在 `e2e/app.spec.js`，配置由 `tools/run-e2e.mjs` 动态生成；浏览器用 `npm run e2e:install` 首次下载，或用 `PW_HOME` 复用其它工程。
- 成功时清理临时目录与 `test-results/`，失败保留现场；`E2E_KEEP_ARTIFACTS=1` 可强制保留。
- 用例通过 `page.addInitScript` 在页面脚本执行前写入 token 与 api-origin —— 应用首次求值 `getApiBaseUrl()` 时就决定后端，先 goto 再 evaluate 会打到构建期默认地址。
- e2e 不在 CI 跑（需 Playwright + 独立后端）。

## 5. 包体与配图

主包上限 2 MB，当前 `dist/` ≈ 1.25 MiB（62%），其中 `dist/static/` 占 64%（12 张预置菜图 ≈ 657 KB + 2 张分享封面 ≈ 153 KB）。

- **体积门禁**：`npm run size` 超 `SIZE_FAIL_BYTES`（默认 1,650,000 B）退出码 1，verify 与 CI 都带。
- **配图压缩已接近极限**：progressive JPEG + 4:2:0 + q78，再压只省 ~40 KB 且伤画质。
- **CDN 开关**：`TARO_APP_ASSET_BASE=https://cdn.example.com/photo-wall` 后 `/static/img/*` 走该 base，且构建不再拷图进产物 —— 主包少 ~820 KB（62% → 约 23%）。启用前必须先把 `src/static/img/` 按同样相对路径上传，否则预置图裂。

预置配图保持 600px 原分辨率（hero 位在 3x 屏需约 507px）。分享封面在 CDN 开关下变 https URL，微信卡片支持网络图。

## 6. CI 与门禁

`.github/workflows/verify.yml` 在 push / PR 跑：

```
npm ci → npm run typecheck → npm test → build:weapp + npm run size → build:h5
```

`npm test` 覆盖契约快照（前端调用 ⊆ openapi）、运行时后端白名单、RELEASE 构建守卫、多图槽位、API 端点封装、请求层状态机（401 刷新重放 / 单飞 / 429 退避）、本地模式筛选·计数·统计·月份分桶、贴一张页纯逻辑。

`src/data/` 拆法（状态只有一份在 `store-state.ts`）：`store-cache` 本地存储与缓存 · `store-local` 本地模式纯函数 · `store-paging` 首屏/分页/筛选/跳月 · `store-aggregates` 城市计数+统计+月份 · `store-refresh` 整体刷新 · `store-writes` 写操作 · `store-detail` 单条/分享/随机/店铺 · `store-errors` 错误文案 · `store-hooks` React 绑定 · `store.ts` 只做门面。

`src/pages/compose/`：`index.tsx` 表单状态与 JSX，`helpers.ts` 纯函数（长度校验、日期比较、照片回填、未保存判定），`pick-photos.ts` 选图。

## 7. 目录

```
src/      页面、组件、数据层、API、工具、静态资源
e2e/      Playwright 用例
tools/    构建与测试编排
```

## 8. 容易踩的坑

1. **内联 style 里的 rpx 不会被转换**：H5 当 px 算，必须过 `Taro.pxTransform`。
2. **hooks 不能放在早退 return 之后**：hook 数量不一致会让整页渲染成空。
3. **分享封面路径要带 `img/` 段**：copy 规则是 `src/static/img/` → `dist/static/img/`。
4. **离线禁止写**：没有回传队列；只读降级（缓存 + 「离线」角标）可用。
5. **月轴跳月必须用 `cursorInclusive=true`**：keyset 严格 `<`，否则漏掉当月最新一张。
