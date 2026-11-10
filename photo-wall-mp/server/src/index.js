/* ================================================================
   入口：起 HTTP 服务

   用法：
      node server/src/index.js          # 默认 8788
      PORT=9000 node server/src/index.js
      npm run server                    # 根 package.json 的快捷方式

    打印 listen 地址是硬要求 —— 联调同学要知道连哪个端口。

    ---------- 为什么默认端口从 8787 改成 8788 ----------
    8787 是**契约端口**：`docs/api` 的示例、`server/src/config.ts`（Hono 真后端）
    的默认 PORT 都是它。这个 mock 以前也占 8787，于是「谁先起谁占坑」：
    前端 config 指向 8787，实际连到的可能是 mock —— 而 mock 会给每个新用户
    灌 101 条演示数据（`SEED_NEW_USERS=1`），界面看着很满，但契约 AC-01
    要求新用户 `recordCount=0`。这种「看着对、其实是假数据」比连不上更难查。

    现在把 8787 让给真后端，mock 退到 8788，只做**离线演示 / 纯前端联调**。
    要指定别的端口：`PORT=9000 npm run server`。
    ================================================================ */
/* global process, console */

import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { createApp, createRouter } from './http.js';
import { defineRoutes } from './routes.js';
import { resetStore } from './store.js';

/** 演示端口。8787 属真后端（契约默认），别再抢。 */
export const DEFAULT_PORT = 8788;

export function buildServer({ rateLimitPerMin = 0 } = {}) {
  const router = createRouter();
  defineRoutes(router);
  const handle = createApp({ router, rateLimitPerMin });
  return createServer(handle);
}

/** 起服务并返回 { server, port, url }（测试用 port=0 拿随机端口） */
export function startServer({ port = DEFAULT_PORT, host = '127.0.0.1', rateLimitPerMin = 0 } = {}) {
  const server = buildServer({ rateLimitPerMin });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const addr = server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : port;
      resolve({ server, port: actualPort, url: `http://${host}:${actualPort}` });
    });
  });
}

/* 直接运行（不是被 import）时才自动启动 —— 测试里 import 不会误起服务。
   用 pathToFileURL 比较，别手拼 `file://` —— Windows 的盘符与反斜杠会拼错，
   结果就是「启动后立刻以 exit 0 退出、什么都不打印」。 */
const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const port = Number(process.env.PORT) || DEFAULT_PORT;
  const host = process.env.HOST || '127.0.0.1';
  if (process.env.RESET === '1') resetStore();
  const { url } = await startServer({ port, host, rateLimitPerMin: Number(process.env.RATE_LIMIT) || 0 });
  const { allOf, SEED_USER_ID } = await import('./store.js');
  const count = allOf(SEED_USER_ID).length;
  console.log(`photo-wall mock server 已启动`);
  console.log(`  listen   ${url}`);
  console.log(`  healthz  ${url}/healthz`);
  console.log(`  api      ${url}/v1/records`);
  console.log(`  种子数据 ${count} 条（种子用户 ${SEED_USER_ID}）`);
  console.log(`  提示：联调用 POST ${url}/v1/auth/wechat/login {"code":"dev"} 换 token`);
}
