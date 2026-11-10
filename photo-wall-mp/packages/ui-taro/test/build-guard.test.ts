/* ================================================================
   构建期守卫的单测（P1-7）。

   `config/index.js` 顶部的 RELEASE 守卫决定"能不能把包发出去"：
   设了 RELEASE=1 却没有 TARO_APP_API_ORIGIN 时必须直接抛错，
   否则产物会把 http://localhost:8787 内联进去，真机全站连不上。
   这里用子进程加载真实构建配置，钉住三种情况。
   ================================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(HERE, '..');

/** 在包根目录用指定环境变量加载一次构建配置 */
function loadConfig(env: Record<string, string>) {
  const merged = { ...process.env, ...env };
  delete merged.TARO_APP_API_ORIGIN;
  if (env.TARO_APP_API_ORIGIN !== undefined) merged.TARO_APP_API_ORIGIN = env.TARO_APP_API_ORIGIN;
  return spawnSync(process.execPath, ['-e', "require('./config/index.js')"], {
    cwd: PKG,
    env: merged,
    encoding: 'utf8',
  });
}

test('RELEASE=1 且没有 TARO_APP_API_ORIGIN 时构建配置必须抛错（P1-7）', () => {
  const r = loadConfig({
    NODE_ENV: 'production',
    TARO_ENV: 'weapp',
    RELEASE: '1',
    TARO_APP_API_ORIGIN: '',
  });
  assert.notEqual(r.status, 0, r.stdout);
  assert.match(String(r.stderr), /RELEASE=1 但没有设置 TARO_APP_API_ORIGIN/);
});

test('RELEASE=1 且配置了合法 origin 时构建配置通过', () => {
  const r = loadConfig({
    NODE_ENV: 'production',
    TARO_ENV: 'weapp',
    RELEASE: '1',
    TARO_APP_API_ORIGIN: 'https://api.example.com',
  });
  assert.equal(r.status, 0, String(r.stderr));
});

test('日常构建 / E2E 构建（不带 RELEASE）不强制要求 origin', () => {
  const r = loadConfig({
    NODE_ENV: 'production',
    TARO_ENV: 'h5',
    RELEASE: '',
    TARO_APP_API_ORIGIN: '',
  });
  assert.equal(r.status, 0, String(r.stderr));
});
