/* ================================================================
   字典、运维、CORS 与路由顺序（契约 §5 / §6.6 / AC-32、AC-33、D-17）
   ================================================================ */
/* global fetch */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { resetStore, seedRecordCount, withServer } from './helpers.js';

let srv;

before(async () => {
  srv = await withServer();
  resetStore();
});

after(() => srv.close());

describe('AC-33 健康检查', () => {
  it('200 且无需鉴权，带 status/version/time', async () => {
    const started = Date.now();
    const res = await fetch(`${srv.url}/healthz`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'ok');
    assert.equal(body.version, '1.0.0');
    assert.match(body.time, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    assert.ok(Date.now() - started < 1000);
  });
});

describe('AC-32 城市字典', () => {
  it('34 省 / 208 城；省与省内城市均码点序；带 ETag', async () => {
    const res = await fetch(`${srv.url}/v1/geo/cities`);
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.equal(body.provinces.length, 34, '省数量应与 core CITY_PROVINCE 一致');
    const cityTotal = body.provinces.reduce((s, p) => s + p.cities.length, 0);
    assert.equal(cityTotal, 208, '城市数量应与 core CITY_PROVINCE 一致');

    const etag = res.headers.get('etag');
    assert.ok(etag, '必须带 ETag');
    assert.match(res.headers.get('cache-control') || '', /max-age=86400/);

    // 省按码点序
    const provNames = body.provinces.map((p) => p.province);
    assert.deepEqual(provNames, [...provNames].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    // 省内城市按码点序
    for (const p of body.provinces) {
      assert.deepEqual(p.cities, [...p.cities].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    }
    // 直辖市：省名 = 市名
    for (const m of ['北京', '上海', '天津', '重庆']) {
      const g = body.provinces.find((p) => p.province === m);
      assert.ok(g, `应有直辖市 ${m}`);
      assert.deepEqual(g.cities, [m]);
    }
  });

  it('If-None-Match 命中 → 304 无 body', async () => {
    const first = await fetch(`${srv.url}/v1/geo/cities`);
    const etag = first.headers.get('etag');
    const second = await fetch(`${srv.url}/v1/geo/cities`, {
      headers: { 'If-None-Match': etag },
    });
    assert.equal(second.status, 304);
    assert.equal(await second.text(), '');
  });
});

describe('CORS（H5 联调必需）', () => {
  it('OPTIONS 预检 204 且允许所有 origin', async () => {
    const res = await fetch(`${srv.url}/v1/records`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:10086',
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'authorization,content-type',
      },
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    const allowHeaders = (res.headers.get('access-control-allow-headers') || '').toLowerCase();
    assert.ok(allowHeaders.includes('authorization'));
    assert.ok(allowHeaders.includes('idempotency-key'));
  });

  it('普通响应也带 Allow-Origin', async () => {
    const res = await fetch(`${srv.url}/healthz`, { headers: { Origin: 'http://x.dev' } });
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
  });
});

describe('路由顺序（§5 警示）', () => {
  it('/records/random、/records/cities、/records/months 不被当成 {id}', async () => {
    const H = { Authorization: 'Bearer dev-access-token' };
    for (const [path, expectKey] of [
      ['/v1/records/random', 'record'],
      ['/v1/records/cities', 'cityCounts'],
      ['/v1/records/months', 'items'],
    ]) {
      const res = await fetch(`${srv.url}${path}`, { headers: H });
      assert.equal(res.status, 200, `${path} 不应被 /records/{id} 吃掉`);
      const body = await res.json();
      assert.ok(expectKey in body, `${path} 应返回 ${expectKey}`);
      assert.ok(!body.error);
    }
  });

  it('/shops/by-name 不被当成 {shopId}', async () => {
    const res = await fetch(`${srv.url}/v1/shops/by-name?name=${encodeURIComponent('马旺子川小馆')}`, {
      headers: { Authorization: 'Bearer dev-access-token' },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.stats);
  });
});

describe('缓存头', () => {
  it('个人数据接口一律 no-store；random 也是 no-store', async () => {
    const H = { Authorization: 'Bearer dev-access-token' };
    for (const path of ['/v1/records', '/v1/records/cities', '/v1/stats', '/v1/records/random', '/v1/me']) {
      const res = await fetch(`${srv.url}${path}`, { headers: H });
      assert.equal(res.headers.get('cache-control'), 'no-store', `${path} 应 no-store`);
    }
  });
});

describe('错误体形状（§3.3）', () => {
  it('未知路由 → 404 且是统一错误体', async () => {
    const res = await fetch(`${srv.url}/v1/nope`, {
      headers: { Authorization: 'Bearer dev-access-token' },
    });
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.error.code, 'NOT_FOUND');
    assert.ok(body.error.message);
    assert.match(body.error.requestId, /^req_/);
  });

  it('JSON 解析失败 → 400 BAD_REQUEST', async () => {
    const res = await fetch(`${srv.url}/v1/records`, {
      method: 'POST',
      headers: { Authorization: 'Bearer dev-access-token', 'Content-Type': 'application/json' },
      body: '{not json',
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, 'BAD_REQUEST');
  });
});

describe('测试可重置性', () => {
  it('resetStore() 让数据回到种子态（用例之间隔离）', async () => {
    const H = { Authorization: 'Bearer dev-access-token' };
    await fetch(`${srv.url}/v1/records`, {
      method: 'POST',
      headers: { ...H, 'Content-Type': 'application/json' },
      body: JSON.stringify({ eat: '临时' }),
    });
    let res = await fetch(`${srv.url}/v1/records?limit=50`, { headers: H });
    assert.equal((await res.json()).total, seedRecordCount() + 1);

    resetStore();
    res = await fetch(`${srv.url}/v1/records?limit=50`, { headers: H });
    assert.equal((await res.json()).total, seedRecordCount());
  });
});
