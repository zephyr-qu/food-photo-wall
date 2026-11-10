/* ================================================================
   账号与鉴权（契约 §6.1 / 验收 AC-01~AC-04、D-18）
   ================================================================ */
/* global fetch */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { api, resetStore, seedRecordCount, withServer } from './helpers.js';
import { expireAccessToken, findAccessToken } from '../src/store.js';

let srv;
let request;

before(async () => {
  srv = await withServer();
  request = api(srv.url);
});

after(() => srv.close());

// 账号用例断言的是「新用户 = 空数据」（AC-01 的 recordCount=0），故显式关掉示例数据初始化
beforeEach(() => resetStore({ seedNewUsers: false }));

const post = (path, body) =>
  fetch(`${srv.url}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('AC-01 微信静默登录（新用户）', () => {
  it('200；token 非空；isNewUser=true；user.recordCount=0', async () => {
    const res = await post('/v1/auth/wechat/login', { code: 'wx-code-1' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.accessToken);
    assert.ok(body.refreshToken);
    assert.equal(body.expiresIn, 7200);
    assert.equal(body.tokenType, 'Bearer');
    assert.match(body.userId, /^usr_/);
    assert.equal(body.isNewUser, true);
    assert.equal(body.user.id, body.userId);
    assert.equal(body.user.recordCount, 0);
    assert.ok(body.user.createdAt);
  });

  it('同一 code 重复登录 → 401 WECHAT_CODE_INVALID', async () => {
    const first = await post('/v1/auth/wechat/login', { code: 'wx-code-dup' });
    assert.equal(first.status, 200);
    const second = await post('/v1/auth/wechat/login', { code: 'wx-code-dup' });
    assert.equal(second.status, 401);
    const body = await second.json();
    assert.equal(body.error.code, 'WECHAT_CODE_INVALID');
  });

  it('缺 code → 401', async () => {
    const res = await post('/v1/auth/wechat/login', {});
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error.code, 'WECHAT_CODE_INVALID');
  });
});

describe('AC-03 / D-18 token 过期与刷新', () => {
  it('过期 accessToken → 401 TOKEN_EXPIRED；refresh 后原请求可重放成功', async () => {
    const login = await post('/v1/auth/wechat/login', { code: 'wx-refresh-1' });
    const { accessToken, refreshToken } = await login.json();

    // 构造过期（直接改 store 里的过期时间，等价于等待 2 小时）
    assert.ok(findAccessToken(accessToken));
    expireAccessToken(accessToken);

    const expired = await fetch(`${srv.url}/v1/records`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    assert.equal(expired.status, 401);
    assert.equal((await expired.json()).error.code, 'TOKEN_EXPIRED');

    // refresh
    const refreshed = await post('/v1/auth/refresh', { refreshToken });
    assert.equal(refreshed.status, 200);
    const tokens = await refreshed.json();
    assert.ok(tokens.accessToken);
    assert.ok(tokens.refreshToken);
    assert.equal(tokens.expiresIn, 7200);

    // 用新 token 重放原请求
    const replay = await fetch(`${srv.url}/v1/records`, {
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
    });
    assert.equal(replay.status, 200);

    // 旧 refreshToken 轮换后立即失效
    const reuse = await post('/v1/auth/refresh', { refreshToken });
    assert.equal(reuse.status, 401);
    assert.equal((await reuse.json()).error.code, 'TOKEN_INVALID');
  });

  it('无效 refreshToken → 401 TOKEN_INVALID', async () => {
    const res = await post('/v1/auth/refresh', { refreshToken: 'rt_bogus' });
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error.code, 'TOKEN_INVALID');
  });
});

describe('鉴权失败码', () => {
  it('缺 Authorization → 401 TOKEN_MISSING', async () => {
    const res = await fetch(`${srv.url}/v1/records`);
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error.code, 'TOKEN_MISSING');
  });

  it('格式/签名错 → 401 TOKEN_INVALID', async () => {
    const res = await fetch(`${srv.url}/v1/records`, {
      headers: { Authorization: 'Bearer not-a-real-token' },
    });
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error.code, 'TOKEN_INVALID');
  });

  it('错误体统一带 requestId，且回显 X-Request-Id', async () => {
    const res = await fetch(`${srv.url}/v1/records`, { headers: { 'X-Request-Id': 'req_fixed_1' } });
    const body = await res.json();
    assert.equal(body.error.requestId, 'req_fixed_1');
    assert.equal(res.headers.get('x-request-id'), 'req_fixed_1');
  });
});

describe('匿名登录（H5 / 开发环境）', () => {
  it('同一 deviceId 幂等返回同一 userId', async () => {
    const a = await post('/v1/auth/anonymous', { deviceId: 'd_abc' });
    const b = await post('/v1/auth/anonymous', { deviceId: 'd_abc' });
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal((await a.json()).userId, (await b.json()).userId);
  });

  it('缺 deviceId → 400', async () => {
    const res = await post('/v1/auth/anonymous', {});
    assert.equal(res.status, 400);
  });
});

describe('GET /me', () => {
  it('返回当前用户与记录数', async () => {
    const login = await post('/v1/auth/wechat/login', { code: 'wx-me-1' });
    const { accessToken } = await login.json();

    await fetch(`${srv.url}/v1/records`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ eat: 'A' }),
    });

    const res = await fetch(`${srv.url}/v1/me`, { headers: { Authorization: `Bearer ${accessToken}` } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.recordCount, 1);
    assert.equal(body.photoCount, 0);
    assert.ok(body.lastRecordAt);
  });
});

describe('种子数据', () => {
  /* 契约 §2.4 逐字断言的是「12 条契约数据」本身 —— 钉死 demo 关闭，
     演示数据（demo-records）的覆盖放在 seed-new-user.test.js 的
     「演示数据层」describe 里单独测。 */
  beforeEach(() => resetStore({ seedNewUsers: false, demo: false }));

  it('种子用户用固定 dev token 可直接访问，且 12 条记录', async () => {
    const res = await request('GET', '/v1/records?limit=50');
    assert.equal(res.status, 200);
    assert.equal(res.body.total, 12);
    // 种子按 at 倒序
    const ats = res.body.items.map((r) => r.at);
    assert.deepEqual(ats, [...ats].sort().reverse());
    // photo 一律 null（= 用包内预置图）
    assert.ok(res.body.items.every((r) => r.photo === null));
    // id 不是 g..._... 形态
    assert.ok(res.body.items.every((r) => !/^g.*_/.test(r.id)));
  });

  it('种子数据与 core REAL_RECORDS 逐字一致（条数/菜名/时间）', async () => {
    const res = await request('GET', '/v1/records?limit=50');
    const eats = res.body.items.map((r) => r.eat);
    for (const eat of [
      '甜水面', '冰粉', '跷脚牛肉', '钵钵鸡', '北京烤鸭', '番茄牛腩',
      '蛋烘糕', '生煎包', '豆汁儿', '热干面', '糖油粑粑', '沙茶面',
    ]) {
      assert.ok(eats.includes(eat), `种子应包含 ${eat}`);
    }
    const byEat = Object.fromEntries(res.body.items.map((r) => [r.eat, r]));
    assert.equal(byEat['甜水面'].at, '2026-10-09T12:30');
    assert.equal(byEat['甜水面'].shop, '马旺子川小馆');
    assert.equal(byEat['甜水面'].city, '成都');
    /* 区县：core 的 REAL_RECORDS 后来按城市补上了真实区/县
       （packages/core/src/demo.ts 「区县为真实存在的区/县，按城市补上」），
       种子数据是按 core 生成的，这里以前还钉着 null —— 断言过期，不是数据漂移。 */
    assert.equal(byEat['甜水面'].district, '锦江区');
    assert.equal(byEat['甜水面'].rating, 5);
    assert.equal(byEat['番茄牛腩'].shop, null);
    assert.equal(byEat['番茄牛腩'].city, null);
  });

  it('resetStore() 后数据回到种子态', async () => {
    await request('POST', '/v1/records', { body: { eat: '新增的' } });
    let res = await request('GET', '/v1/records?limit=50');
    assert.equal(res.body.total, 13, '本用例 beforeEach 钉了 demo:false（12 条），新增 1 条 = 13');
    resetStore(); // 无参 = 恢复环境默认（演示数据开 → 12+89 条）
    res = await request('GET', '/v1/records?limit=50');
    assert.equal(res.body.total, seedRecordCount());
  });
});
