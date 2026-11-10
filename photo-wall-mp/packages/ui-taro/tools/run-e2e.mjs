#!/usr/bin/env node
/**
 * 跑 ui-taro 的 H5 E2E（自包含：Playwright 装在本包 devDependencies 里）。
 *
 * 背景：历史上曾借用兄弟工程 `photo-wall-h5` 装好的 `@playwright/test`，
 * 但 `photo-wall-h5` 原型已删除，不能再依赖它。现由本包自己持有 E2E：
 *   · `@playwright/test` 已是本包 devDependency（npm 安装时一并装好）；
 *   · 浏览器首次跑前用 `npm run e2e:install` 下载（npx playwright install chromium）；
 *   · spec 源码仍在本包内维护（e2e/ 下），单一事实来源。
 *
 * 做法：把 e2e/ 下的 spec 与配置临时复制到 Playwright 所在工程（默认就是本包）
 * 里跑，跑完删掉。这样：
 *   · 不往工程留垃圾（try/finally 保证清理）；
 *   · spec 源码仍然在本包内维护（单一事实来源）。
 *
 * 用法：
 *   npm run e2e              # 默认连 8789（E2E 专用后端）
 *   E2E_API=http://127.0.0.1:8787/v1 npm run e2e   # 连别的后端（注意有限流）
 *
 * 前置（脚本会检查并给出明确提示）：
 *   1. dist-web 已构建（npm run build:h5）
 *   2. E2E 后端已启动（cd ../../photo-wall-api/server && node scripts/e2e-server.mjs）
 *   3. 有一个静态服务托管 dist-web（默认复用 5195；没有则自动起一个）
 *   4. Playwright 已可用（默认本包；或用 PW_HOME=<装有 @playwright/test 的工程> 指定）
 */
import { existsSync, mkdirSync, copyFileSync, rmSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(HERE, '..');

/**
 * Playwright 所在工程（E2E 借用它装好的 @playwright/test）。
 *
 * 候选顺序（不写死绝对路径，历史上写死绝对路径导致搬目录后静默失效）：
 *   1. 环境变量 PW_HOME（显式指定优先，用于复用别的已装 Playwright 的工程）
 *   2. 本包自己（推荐：@playwright/test 已是本包 devDependency）
 *   3. 仓库根的 node_modules（npm workspaces 会把它提到这里）
 */
function resolvePwHome() {
  if (process.env.PW_HOME) return process.env.PW_HOME;
  const candidates = [
    // 本包：<repo>/packages/ui-taro
    PKG,
    // 仓库根：<repo>（npm workspaces 可能把依赖提升到这里）
    resolve(PKG, '..', '..'),
  ].filter((c) => existsSync(c));
  for (const c of candidates) {
    if (existsSync(join(c, 'node_modules', '@playwright', 'test'))) return c;
  }
  /* 都没找到：返回本包，好让下面的报错信息带上真实路径 */
  return PKG;
}

const PW_HOME = resolvePwHome();

/**
 * 后端工程（photo-wall-api/server）所在目录 —— 自动探测。
 * 同样不写死：仓库整体搬过家，写死的路径在报错信息里是错的，比不给更糟。
 */
function resolveApiServerDir() {
  const candidates = [
    resolve(PKG, '..', '..', '..', 'photo-wall-api', 'server'),
  ];
  for (const c of candidates) {
    if (existsSync(join(c, 'scripts', 'e2e-server.mjs'))) return c;
  }
  return candidates[0];
}
/** 临时目录名（在 PW_HOME 里，跑完删） */
const TMP = '_taro-e2e-tmp';
const H5_PORT = Number(process.env.E2E_PORT ?? 5195);
const API = process.env.E2E_API ?? 'http://127.0.0.1:8789/v1';

function fail(msg) {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

/* ---- 前置检查 ---- */
if (!existsSync(join(PKG, 'dist-web', 'index.html'))) {
  fail('dist-web 未构建。先跑：npm run build:h5');
}
if (!existsSync(join(PW_HOME, 'node_modules', '@playwright', 'test'))) {
  fail(
    `找不到 Playwright（${join(PW_HOME, 'node_modules', '@playwright', 'test')}）。\n` +
      '  用 PW_HOME=<装有 @playwright/test 的工程> 指定，或先 npx playwright install。',
  );
}
if (!existsSync(join(PKG, 'e2e', 'app.spec.js'))) {
  fail('缺少 e2e/app.spec.js');
}

/* ---- 后端可达性 ----
   ⚠ 不只是"能不能连上"，还要确认**连的是不是我们的后端**。
   端口被别的程序占着时（比如上次的 E2E 实例没退干净），fetch 一样可能
   拿到 200 —— 但那是个不相干的服务，E2E 会跑去测它，
   失败信息还会指向测试代码而不是环境问题。
   所以这里检查响应体里有没有我们自己的标识。 */
const healthRes = await fetch(`${API}/healthz`).catch(() => null);
const healthOk = healthRes?.ok === true;
if (!healthOk) {
  fail(
    `E2E 后端不可达：${API}/healthz\n` +
      `  启动方式：cd ${resolveApiServerDir()} && node scripts/e2e-server.mjs 8789\n` +
      '  （不要用 8787 那个联调实例：它有限流，E2E 会大量新建用户而触发 429）',
  );
}
const healthBody = await healthRes.text();
if (!healthBody.includes('"status":"ok"')) {
  fail(
    `${API}/healthz 返回的不是照片墙后端（HTTP ${healthRes.status}，body=${healthBody.slice(0, 120)}）\n` +
      `  端口 ${API.replace(/\/v1$/, '').split(':').pop()} 很可能被**别的程序**占着。\n` +
      '  先停掉占用进程，或用 E2E_API=http://127.0.0.1:8790/v1 换端口。',
  );
}

/* ---- 准备临时目录 ---- */
const tmpDir = join(PW_HOME, TMP);
rmSync(tmpDir, { recursive: true, force: true });
mkdirSync(tmpDir, { recursive: true });

/* Playwright 默认往**工作目录**写 `test-results/`（失败截图、trace）。
   我们在 PW_HOME 里跑，所以它会在那边留下这个目录。
   跑完（无论成败）都清掉——除非显式要保留现场。 */
const resultsDir = join(PW_HOME, 'test-results');
const KEEP_ARTIFACTS = process.env.E2E_KEEP_ARTIFACTS === '1';
/** 跑完后决定是否保留现场（失败时置 true，见文件末尾） */
let keepResults = KEEP_ARTIFACTS;

const cleanup = () => {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* 忽略清理失败 */
  }
  if (!keepResults) {
    try {
      rmSync(resultsDir, { recursive: true, force: true });
    } catch {
      /* 忽略 */
    }
  }
};
process.on('exit', cleanup);
process.on('SIGINT', () => {
  cleanup();
  process.exit(130);
});

/* 把整个 e2e/ 复制过去（不只 app.spec.js，过期会话等补充用例也一起跑） */
function copyE2e(srcDir, dstDir) {
  mkdirSync(dstDir, { recursive: true });
  for (const name of readdirSync(srcDir)) {
    const src = join(srcDir, name);
    const dst = join(dstDir, name);
    if (statSync(src).isDirectory()) {
      copyE2e(src, dst);
    } else {
      copyFileSync(src, dst);
    }
  }
}
copyE2e(join(PKG, 'e2e'), tmpDir);

/* 配置也放临时目录（Playwright 从配置所在目录解析 testDir） */
const configPath = join(tmpDir, 'playwright.config.mjs');
writeFileSync(
  configPath,
  `// 自动生成（npm run e2e），跑完即删
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:${H5_PORT}/',
    viewport: { width: 390, height: 844 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
`,
  'utf8',
);

/* ---- 确保静态服务在跑 ----
   优先用 `serve`（多进程、支持并发/范围请求），而不是 python -m http.server
   （单线程，E2E 并发加载大量 chunk + 图片时容易排队，表现为随机的
   "元素没渲染出来" —— 排查了很久才发现是静态服务在排队，不是应用的问题）。 */
const h5Up = await fetch(`http://127.0.0.1:${H5_PORT}/`).then((r) => r.ok).catch(() => false);
let server = null;
if (!h5Up) {
  console.log(`· 起静态服务 :${H5_PORT}（serve，托管 dist-web）`);
  server = spawn(
    'npx',
    ['--no-install', 'serve', '-l', String(H5_PORT), '--no-clipboard', join(PKG, 'dist-web')],
    { cwd: PKG, stdio: 'ignore', shell: process.platform === 'win32' },
  );
  /* 等它起来（最多 20s） */
  let up = false;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500));
    up = await fetch(`http://127.0.0.1:${H5_PORT}/`).then((r) => r.ok).catch(() => false);
    if (up) break;
  }
  if (!up) fail(`静态服务没起来（端口 ${H5_PORT} 被占用？换 E2E_PORT=xxxx 再试）`);
} else {
  /* 已有服务：确认它托管的是**当前** dist-web，而不是别处的旧产物。
     做法：取 index.html 里引用的 js 文件名，与本地 dist-web/index.html 对比。 */
  const [servedHtml, localHtml] = await Promise.all([
    fetch(`http://127.0.0.1:${H5_PORT}/`).then((r) => r.text()),
    (await import('node:fs/promises')).readFile(join(PKG, 'dist-web', 'index.html'), 'utf8'),
  ]);
  const jsOf = (h) => (h.match(/\/js\/[A-Za-z0-9_.-]+\.js/g) ?? []).sort().join(',');
  if (jsOf(servedHtml) !== jsOf(localHtml)) {
    fail(
      `端口 ${H5_PORT} 上的静态服务托管的是**旧产物**（与 dist-web 不一致）。\n` +
        `  可能是之前起的 python http.server 还占着这个端口。\n` +
        `  处理：停掉它，或用 E2E_PORT=5196 npm run e2e 让脚本自己起一个。`,
    );
  }
}

/* ---- 跑测试 ---- */
console.log(`· E2E 后端 ${API}`);
console.log(`· H5  http://127.0.0.1:${H5_PORT}/`);
const res = spawnSync('npx', ['playwright', 'test', '-c', configPath], {
  cwd: PW_HOME,
  stdio: 'inherit',
  env: { ...process.env, E2E_API: API, E2E_BASE: `http://127.0.0.1:${H5_PORT}/` },
  shell: process.platform === 'win32',
});

const passed = (res.status ?? 1) === 0;

/* 失败时**保留现场**（截图/trace 是排障第一手材料）；成功时清掉，避免在
   兄弟工程里积攒无用目录。exit 钩子会按 keepResults 决定是否删。 */
if (!passed && existsSync(resultsDir)) {
  keepResults = true;
  console.log(`\n· 失败现场已保留：${resultsDir}`);
  console.log(`  看图/看 trace：npx playwright show-trace "<用例目录>/trace.zip"`);
  console.log('  （设 E2E_KEEP_ARTIFACTS=1 可在成功时也保留）');
}

if (server) server.kill();
cleanup();
process.exit(res.status ?? 1);
