# X师傅美食记

微信小程序 + H5 的照片墙，配一套可独立运行的 RESTful 后端。两边都不必等对方就位：后端不配数据库时纯内存运行，前端不连后端时有 mock 兜底。

## 目录结构

| 目录 | 内容 | 技术栈 |
| --- | --- | --- |
| `photo-wall-api/docs/api/` | 接口契约：主文档、OpenAPI 3.1、39 条验收用例（AC-01 ~ AC-38，其中 AC-30b 是 AC-30 的补充） | Markdown / YAML |
| `photo-wall-api/server/` | 真后端：23 个接口、JWT 鉴权、游标分页、多图、分享、内容审核、102 个测试 | Hono 4 + zod + better-sqlite3（可选）+ tsx |
| `photo-wall-mp/packages/core/` | 纯 TS 逻辑层：数据模型、masonry 布局、城市字典、统计 | TypeScript + node:test |
| `photo-wall-mp/packages/ui-taro/` | 前端：微信小程序 + H5 | Taro 4.3 + React 18 |
| `photo-wall-mp/server/` | 离线 mock 后端（端口 8788） | Node 原生 ESM |

契约放在 `docs/api`，前后端各写一份实现。两边说法不一致时看契约，不看代码。

## 快速开始

### 真后端

```bash
cd photo-wall-api/server
npm install
npm run dev            # http://localhost:8787/v1
npm test               # 102 个验收测试
```

### 前端

```bash
cd photo-wall-mp
npm install
cp packages/ui-taro/.env.example packages/ui-taro/.env
npm run dev:weapp      # 微信小程序
npm run build:h5       # H5 构建
npm test
```

`.env` 默认指向 `localhost:8787`，即上一节的后端。只想看界面、不启动后端时，改指向 mock 的 8788。

## 缘起

这个想法来自一位“美食家”：一张照片，一家店，一座城，一顿值得记住的饭。

## License

Apache License 2.0 — 见 [LICENSE](./LICENSE)。Copyright (c) 2026 photo-wall contributors.
