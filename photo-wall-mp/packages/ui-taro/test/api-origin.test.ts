/* ================================================================
   运行时后端覆盖白名单（P1-6）的单元测试。

   背景：H5 的 `?api=` 会把值写进 localStorage 并用于后续所有请求，
   若不校验，一条外部链接就能把 Bearer/refreshToken 导向攻击者主机。
   这些用例钉住"哪些地址允许、哪些必须拒绝"。
   ================================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isAllowedRuntimeOrigin } from '../src/utils/api-origin.ts';

test('本机地址允许（E2E / 本机联调）', () => {
  for (const origin of [
    'http://localhost:8789',
    'http://127.0.0.1:8789',
    'https://localhost',
    'http://[::1]:8789',
  ]) {
    assert.equal(isAllowedRuntimeOrigin(origin), true, origin);
  }
});

test('私有网段允许（真机联调）', () => {
  for (const origin of [
    'http://192.168.1.17:8787',
    'http://10.0.0.2:8787',
    'http://172.16.0.1:8787',
    'http://172.31.255.254:8787',
  ]) {
    assert.equal(isAllowedRuntimeOrigin(origin), true, origin);
  }
});

test('非私有网段 / 公网域名拒绝（核心安全用例）', () => {
  for (const origin of [
    'https://attacker.example',
    'http://evil.example/?api=http://localhost',
    'https://127.0.0.1.evil.example',
    'https://localhost.evil.example',
    'http://172.32.0.1:8787',
    'http://8.8.8.8',
    '//attacker.example',
  ]) {
    assert.equal(isAllowedRuntimeOrigin(origin), false, origin);
  }
});

test('同源允许（H5 与后端部署在同一域名）', () => {
  assert.equal(
    isAllowedRuntimeOrigin('https://wall.example.com', 'https://wall.example.com'),
    true,
  );
  assert.equal(
    isAllowedRuntimeOrigin('https://api.example.com', 'https://wall.example.com'),
    false,
  );
  assert.equal(
    isAllowedRuntimeOrigin('https://wall.example.com:8443', 'https://wall.example.com'),
    false,
  );
});

test('协议与形态校验', () => {
  assert.equal(isAllowedRuntimeOrigin('ftp://localhost'), false);
  assert.equal(isAllowedRuntimeOrigin('javascript:alert(1)'), false);
  assert.equal(isAllowedRuntimeOrigin('not a url'), false);
  assert.equal(isAllowedRuntimeOrigin(''), false);
  assert.equal(isAllowedRuntimeOrigin('http://user:pass@localhost:8787'), false);
});
