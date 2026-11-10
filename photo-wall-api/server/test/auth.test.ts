/** 验收：账号与鉴权（AC-01 ~ AC-05 相关） */
import test from 'node:test';
import assert from 'node:assert/strict';
import { sign } from 'hono/jwt';
import { call, login, makeApp } from './helpers.js';

const SECRET = 'test-secret-for-jwt';

test('AC-01 微信静默登录：新用户零记录，发双 token', async (t) => {
  const { app, close } = await makeApp();
  t.after(close);

  const res = await call(app, '/v1/auth/wechat/login', { method: 'POST', body: { code: 'c-1' } });
  assert.equal(res.status, 200);
  assert.ok(res.body.accessToken);
  assert.ok(res.body.refreshToken);
  assert.equal(res.body.tokenType, 'Bearer');
  assert.equal(res.body.expiresIn, 7200);
  assert.equal(res.body.isNewUser, true);
  assert.equal(res.body.user.recordCount, 0);
  assert.match(res.body.userId, /^usr_/);
  // 新用户空墙
  const list = await call(app, '/v1/records', { token: res.body.accessToken });
  assert.deepEqual(list.body, { items: [], nextCursor: null, hasMore: false, total: 0 });
});

test('AC-02 同一微信 code 重复消费 → 401 WECHAT_CODE_INVALID（严格模式）', async (t) => {
  const { app, close } = await makeApp({ strictWechatCodes: true });
  t.after(close);

  const first = await call(app, '/v1/auth/wechat/login', { method: 'POST', body: { code: 'once' } });
  assert.equal(first.status, 200);

  const second = await call(app, '/v1/auth/wechat/login', { method: 'POST', body: { code: 'once' } });
  assert.equal(second.status, 401);
  assert.equal(second.body.error.code, 'WECHAT_CODE_INVALID');
});

test('AC-03 令牌：缺失 / 过期 / 刷新轮换', async (t) => {
  const { app, close } = await makeApp({ jwtSecret: SECRET });
  t.after(close);

  // 缺失 → TOKEN_MISSING
  const missing = await call(app, '/v1/records');
  assert.equal(missing.status, 401);
  assert.equal(missing.body.error.code, 'TOKEN_MISSING');

  // 伪造/乱码 → TOKEN_INVALID
  const bad = await call(app, '/v1/records', { token: 'not-a-jwt' });
  assert.equal(bad.status, 401);
  assert.equal(bad.body.error.code, 'TOKEN_INVALID');

  // 过期（同 secret 签一个 exp 过去的 token）→ TOKEN_EXPIRED
  const loginRes = await call(app, '/v1/auth/wechat/login', { method: 'POST', body: { code: 'c-3' } });
  const userId = loginRes.body.userId as string;
  const past = Math.floor(Date.now() / 1000) - 60;
  const expired = await sign({ sub: userId, typ: 'access', iat: past - 7200, exp: past }, SECRET, 'HS256');
  const expiredRes = await call(app, '/v1/records', { token: expired });
  assert.equal(expiredRes.status, 401);
  assert.equal(expiredRes.body.error.code, 'TOKEN_EXPIRED');

  // 刷新：拿到新 token，旧 refresh 立即失效（轮换）
  const oldRefresh = loginRes.body.refreshToken as string;
  const refreshed = await call(app, '/v1/auth/refresh', { method: 'POST', body: { refreshToken: oldRefresh } });
  assert.equal(refreshed.status, 200);
  assert.ok(refreshed.body.accessToken);
  assert.notEqual(refreshed.body.refreshToken, oldRefresh);

  const replay = await call(app, '/v1/auth/refresh', { method: 'POST', body: { refreshToken: oldRefresh } });
  assert.equal(replay.status, 401);
  assert.equal(replay.body.error.code, 'TOKEN_INVALID');

  // 新 token 可用
  const ok = await call(app, '/v1/records', { token: refreshed.body.accessToken });
  assert.equal(ok.status, 200);
});

test('AC-04 越权访问他人记录：一律 404（绝不 403）', async (t) => {
  const { app, close } = await makeApp();
  t.after(close);

  const a = await login(app, 'user-a');
  const b = await login(app, 'user-b');

  const created = await call(app, '/v1/records', {
    method: 'POST',
    token: a,
    body: { eat: '甜水面', city: '成都' },
  });
  assert.equal(created.status, 201);
  const id = created.body.id as string;

  for (const [method, path] of [
    ['GET', `/v1/records/${id}`],
    ['PATCH', `/v1/records/${id}`],
    ['DELETE', `/v1/records/${id}`],
  ] as const) {
    const res = await call(app, path, {
      method,
      token: b,
      body: method === 'PATCH' ? { note: 'hacked' } : undefined,
    });
    assert.equal(res.status, 404, `${method} 应该是 404，实际 ${res.status}`);
    assert.equal(res.body.error.code, 'NOT_FOUND');
  }

  // 原记录未被动过
  const mine = await call(app, `/v1/records/${id}`, { token: a });
  assert.equal(mine.status, 200);
  assert.equal(mine.body.note, null);
});

test('匿名登录幂等：同一 deviceId 返回同一 userId', async (t) => {
  const { app, close } = await makeApp();
  t.after(close);

  const one = await call(app, '/v1/auth/anonymous', { method: 'POST', body: { deviceId: 'd-1' } });
  const two = await call(app, '/v1/auth/anonymous', { method: 'POST', body: { deviceId: 'd-1' } });
  assert.equal(one.body.userId, two.body.userId);
  assert.equal(one.body.isNewUser, true);
  assert.equal(two.body.isNewUser, false);
});
