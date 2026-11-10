// @ts-check
/** 临时：把某个 spec 复制到 Playwright 工程（默认本包）里跑（复用已装的浏览器）。 */
import { existsSync, mkdirSync, copyFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(HERE, '..');

/**
 * Playwright 所在工程 —— 自动探测，不写死绝对路径。
 * 候选顺序：PW_HOME > 本包 > 仓库根（workspaces 提升）。
 */
function resolvePwHome() {
  if (process.env.PW_HOME) return process.env.PW_HOME;
  const candidates = [
    PKG,
    resolve(PKG, '..', '..'),
  ].filter((c) => existsSync(c));
  for (const c of candidates) {
    if (existsSync(join(c, 'node_modules', '@playwright', 'test'))) return c;
  }
  return PKG;
}

const PW_HOME = resolvePwHome();
const H5_PORT = Number(process.env.E2E_PORT ?? 5195);
const API = process.env.E2E_API ?? 'http://127.0.0.1:8792/v1';
const SPEC = process.argv[2] ?? 'e2e/expired-session.spec.js';

const tmpDir = join(PW_HOME, '_taro-e2e-tmp');
rmSync(tmpDir, { recursive: true, force: true });
mkdirSync(tmpDir, { recursive: true });
copyFileSync(join(PKG, SPEC), join(tmpDir, 'app.spec.js'));

const configPath = join(tmpDir, 'playwright.config.mjs');
writeFileSync(
  configPath,
  `import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: '.', fullyParallel: false, workers: 1, timeout: 90_000,
  reporter: [['list']],
  use: { baseURL: 'http://127.0.0.1:${H5_PORT}/', viewport: { width: 390, height: 844 } },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
`,
  'utf8',
);

const res = spawnSync('npx', ['playwright', 'test', '-c', configPath], {
  cwd: PW_HOME,
  stdio: 'inherit',
  env: { ...process.env, E2E_API: API, E2E_BASE: `http://127.0.0.1:${H5_PORT}/` },
  shell: process.platform === 'win32',
});
rmSync(tmpDir, { recursive: true, force: true });
process.exit(res.status ?? 1);
