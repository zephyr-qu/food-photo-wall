/** 服务入口：@hono/node-server + 优雅退出（落盘） */
import { createServer } from 'node:net';
import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { validateProduction } from './config.js';
import { resolvePresetAssetDir } from './lib/preset-assets.js';

const { app, services, close } = await createApp();
const cfg = services.cfg;

/* 生产自检必须在 listen 之前 —— 有问题就别起服务，而不是起来之后再告警。
   开发/测试环境 validateProduction() 恒返回空数组，行为不变。 */
const problems = validateProduction(cfg);
if (problems.length > 0) {
  console.error('\n✗ 生产环境配置自检失败，拒绝启动：\n');
  problems.forEach((p, i) => console.error(`  ${i + 1}. ${p}\n`));
  console.error('  参考 server/.env.example；NODE_ENV=production 时这些项都是必填的。\n');
  process.exit(1);
}

/**
 * 端口占用检查 —— **必须在 listen 之前**，否则会出现最难查的那种故障。
 *
 * 背景（实测）：`@hono/node-server` 的 `serve()` 不监听 server 的 'error'
 * 事件，而 Node 的 `net.Server.listen` 在端口被占用时，在这台 Windows 上
 * 会**静默复用已有的那个 server** —— 不抛错、不打警告，日志照样打印
 * "服务已启动"。实测表现：
 *   · 日志显示 API 已启动、探活 HTTP 200；
 *   · 但真正在服务的是**占用端口的那个程序**（响应体是它的，不是我们的）。
 *
 * 对生产来说这意味着：本进程收不到任何流量，而运维看日志一切正常 ——
 * 直到用户报"接口没反应"，而日志里根本没有我们的请求。
 *
 * 所以这里显式探一次端口：被占就**明确报错退出**，让人去处理，
 * 而不是让两个进程叠在一起。
 */
async function assertPortFree(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const probe = createServer();
    probe.once('error', (e) => {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'EADDRINUSE') {
        reject(
          new Error(
            `端口 ${port} 已被占用。\n` +
              `  可能上一个实例还活着，或有别的程序占用。\n` +
              `  处理：停掉占用进程，或改 PORT 再启动。`,
          ),
        );
      } else {
        reject(e);
      }
    });
    probe.listen(port, '0.0.0.0', () => probe.close(() => resolve()));
  });
}

try {
  await assertPortFree(cfg.port);
} catch (e) {
  console.error(`\n✗ 拒绝启动：${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
}

if (cfg.jwtSecret.includes('dev-only')) {
  console.warn('⚠  JWT_SECRET 使用默认值（仅开发环境可接受；生产会拒绝启动）');
}
if (cfg.wechat.appId && cfg.wechat.secret) {
  console.log('✓ 微信登录：真实 jscode2session');
} else {
  console.log('ℹ 微信登录：开发模式（未配置 WECHAT_APPID/SECRET，code 直接映射 openid）');
}

/** 预置图回退目录（启动时定一次，见 lib/preset-assets.ts） */
const presetDir = resolvePresetAssetDir();

const server = serve({ fetch: app.fetch, port: cfg.port }, (info) => {
  const base = `http://localhost:${info.port}`;
  console.log(`▲ 照片墙 API 已启动`);
  console.log(`   API       ${base}/v1`);
  console.log(`   healthz   ${base}/v1/healthz`);
  console.log(`   openapi   ${base}/v1/openapi.yaml`);
  console.log(`   swagger   ${base}/v1/docs`);
  console.log(`   存储目录  ${cfg.storageDir}`);
  console.log(`   存储后端  ${cfg.storage}${cfg.storage === 'sqlite' ? ` (${cfg.sqliteFile})` : '（纯内存）'}`);
  /* 预置图目录：找不到时说明部署后只服务上传文件 —— 前端若把
     TARO_APP_ASSET_BASE 指到本服务，12 张预置菜品图会 404，所以要说清楚。 */
  console.log(
    presetDir
      ? `   预置图    ${presetDir}`
      : '   预置图    （未找到；/v1/files 只服务上传文件，见 PRESET_ASSET_DIR）',
  );
});

/* 后台回收：软删记录/孤儿照片过了保留期就物理删除。
   启动即跑一次（清掉上次进程留下的），之后每小时一次。
   默认保留期 = restoreWindowDays（撤销窗口内绝不能删，否则 restore 会失败）。 */
const stopMaintenance = services.maintenance.start();

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal}：正在落盘并退出…`);
  stopMaintenance();
  try {
    server.close(); // 先停收新请求
    await close();
  } finally {
    process.exit(0);
  }
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
