#!/usr/bin/env node
/**
 * E2E 专用后端：起一个**关限流 + 空库**的实例，给 Playwright 用。
 *
 * 为什么必须单独起：
 *   · 真实后端 `RATE_LIMIT_AUTH=10/min`，E2E 每个用例都要新建用户，
 *     连续跑十几条就会 `429 RATE_LIMITED` —— 那不是被测代码的问题；
 *   · E2E 会大量造记录，不该污染本地持久库（联调现场的数据）。
 *
 * 用法：
 *   node scripts/e2e-server.mjs [port]     # 默认 8789
 *   然后 E2E_API=http://127.0.0.1:8789/v1 npx playwright test
 *
 * ⚠ 只给测试用。它关掉了限流、用纯内存库、新用户空墙。
 */
process.env.STORAGE = 'memory';          // 纯内存，退出即丢
process.env.RATE_LIMIT_ENABLED = 'false'; // 关限流
process.env.SEED_DEMO_RECORDS = 'false';  // 新用户空墙（AC-01）
process.env.STORAGE_DIR = 'var/e2e-uploads';
process.env.SERVE_DOCS = 'false';

const port = Number(process.argv[2] ?? process.env.PORT ?? 8789);

/**
 * 端口占用检查（为什么必须有这一步 —— 实测踩过的坑）：
 *
 * `@hono/node-server` 的 `serve()` **不监听 server 的 'error' 事件**，
 * 而 Node 的 `net.Server.listen` 在端口被占用时，在这台 Windows 上会
 * "静默复用已有的那个 server"：**既不抛错，也不打警告**。
 *
 * 实测（先用 0.0.0.0:8805 占了端口，再起本脚本）：
 *   · 日志照样打印 "E2E server ... on http://127.0.0.1:8805/v1"  ← 误导！
 *   · 进程不退出、探活 HTTP 200
 *   · 但**实际在服务的是占用端口的那个程序**（响应体是它的 'x'，
 *     不是本应用的 healthz JSON）
 *
 * 这比直接崩溃更坏：E2E 会连着一个完全不相干的服务跑，
 * 失败信息还会指向测试代码而不是环境问题。
 *
 * 所以做两道检查：
 *   1. 启动前先探端口，占用就**明确报错退出**（可读原因）；
 *   2. 启动后**回读自己的 healthz**，确认这个端口后面确实是本应用。
 */
async function assertPortFree() {
  const { createServer } = await import('node:net');
  await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', (e) => {
      const code = e.code;
      if (code === 'EADDRINUSE') {
        reject(
          new Error(
            `端口 ${port} 已被占用。\n` +
              `  请先停掉占用它的进程，或换一个端口：node scripts/e2e-server.mjs 8790\n` +
              `  （占用者不一定是本项目 —— 别被日志里的"启动成功"骗了。）`,
          ),
        );
      } else {
        reject(e);
      }
    });
    probe.listen(port, '0.0.0.0', () => probe.close(() => resolve()));
  });
}

await assertPortFree();

const { createApp } = await import('../dist/src/app.js');
const { serve } = await import('@hono/node-server');

const { app, close } = await createApp();
const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`E2E server (no rate limit, empty db) on http://127.0.0.1:${info.port}/v1`);
  /* 启动后自检：确认这个端口后面真的是**我们**，不是碰巧在监听的那个。 */
  void (async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${info.port}/v1/healthz`, {
        signal: AbortSignal.timeout(3000),
      });
      const body = await res.text();
      if (!res.ok || !body.includes('"status":"ok"')) {
        console.error(
          `[e2e-server] 自检失败：${info.port} 返回的不是本应用的 healthz（HTTP ${res.status}）。\n` +
            `  端口被别的程序占用了，请换端口。`,
        );
        process.exit(1);
      }
      console.log('[e2e-server] 自检通过：端口确认由本应用提供');
    } catch (e) {
      console.error('[e2e-server] 自检失败：', e);
      process.exit(1);
    }
  })();
});

const shutdown = async (sig) => {
  console.log(`\n${sig} → closing`);
  try {
    server.close();
    await close();
  } finally {
    process.exit(0);
  }
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
