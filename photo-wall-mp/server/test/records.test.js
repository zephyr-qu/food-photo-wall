/* ================================================================
   记录读写与游标分页（契约 §6.2 / 验收 D-01~D-09、D-19、D-20）
   ================================================================ */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { api, createRecord, loginFresh, resetStore, withServer } from './helpers.js';

let srv;
let request;
let token;

before(async () => {
  srv = await withServer();
  request = api(srv.url);
});

after(() => srv.close());

beforeEach(async () => {
  // 关掉「新用户自动灌示例数据」：这些用例断言的是分页/CRUD，需要从空数据起
  resetStore({ seedNewUsers: false });
  // 每个用例用全新用户，避免种子数据干扰分页断言
  ({ token } = await loginFresh(srv.url, `code-${Math.random().toString(36).slice(2)}`));
});

describe('D-01 新用户空数据', () => {
  it('items=[]、hasMore=false、nextCursor=null、total=0', async () => {
    const res = await request('GET', '/v1/records', { token });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.items, []);
    assert.equal(res.body.hasMore, false);
    assert.equal(res.body.nextCursor, null);
    assert.equal(res.body.total, 0);
  });
});

describe('D-02 造 25 条翻 3 页', () => {
  it('三页不重不漏，顺序严格 at 倒序，第 3 页 hasMore=false', async () => {
    for (let i = 0; i < 25; i++) {
      const day = String(i + 1).padStart(2, '0');
      const { status } = await createRecord(srv.url, token, {
        eat: `菜${i}`,
        at: `2026-09-${day}T12:00`,
      });
      assert.equal(status, 201);
    }

    const seen = [];
    let cursor = null;
    let pages = 0;
    let hasMore = true;
    while (hasMore) {
      const q = cursor ? `?limit=10&cursor=${encodeURIComponent(cursor)}` : '?limit=10';
      const res = await request('GET', `/v1/records${q}`, { token });
      assert.equal(res.status, 200);
      assert.equal(res.body.total, 25);
      pages += 1;
      seen.push(...res.body.items);
      hasMore = res.body.hasMore;
      cursor = res.body.nextCursor;
      if (hasMore) assert.ok(cursor, 'hasMore=true 时必须给 nextCursor');
    }

    assert.equal(pages, 3);
    assert.equal(seen.length, 25);
    assert.equal(new Set(seen.map((r) => r.id)).size, 25, '不能有重复');

    // 严格 eatenAtUtc DESC（同时间再按 id DESC）
    for (let i = 1; i < seen.length; i++) {
      const prev = seen[i - 1];
      const cur = seen[i];
      const cmp =
        prev.eatenAtUtc === cur.eatenAtUtc
          ? prev.id.localeCompare(cur.id)
          : prev.eatenAtUtc.localeCompare(cur.eatenAtUtc);
      assert.ok(cmp > 0, `第 ${i} 条排序错乱: ${prev.at} vs ${cur.at}`);
    }
  });
});

describe('D-03 同分钟 3 条（id 兜底）', () => {
  it('limit=2 翻两页拿全 3 条，不重不漏', async () => {
    for (let i = 0; i < 3; i++) {
      const { status } = await createRecord(srv.url, token, {
        eat: `同分钟${i}`,
        at: '2026-09-15T12:30',
      });
      assert.equal(status, 201);
    }

    const first = await request('GET', '/v1/records?limit=2', { token });
    assert.equal(first.body.items.length, 2);
    assert.equal(first.body.hasMore, true);
    const second = await request(
      'GET',
      `/v1/records?limit=2&cursor=${encodeURIComponent(first.body.nextCursor)}`,
      { token },
    );
    assert.equal(second.body.items.length, 1);
    assert.equal(second.body.hasMore, false);

    const ids = [...first.body.items, ...second.body.items].map((r) => r.id);
    assert.equal(new Set(ids).size, 3);
  });
});

describe('D-04 只传 eat 的最小创建', () => {
  it('201；rating=0、其余可空字段为 null、at 为当前时间、出现在列表首位', async () => {
    const { status, body } = await createRecord(srv.url, token, { eat: '甜水面' });
    assert.equal(status, 201);
    assert.match(body.id, /^rec_[0-9A-Z]{26}$/);
    assert.ok(!/^g.*_/.test(body.id), 'id 不能是 g..._... 形态（前端会当本地假数据）');
    assert.equal(body.rating, 0);
    assert.equal(body.shop, null);
    assert.equal(body.shopId, null);
    assert.equal(body.city, null);
    assert.equal(body.district, null);
    assert.equal(body.note, null);
    assert.equal(body.photo, null);
    assert.equal(body.photoThumb, null);
    assert.equal(body.photoId, null);
    assert.equal(body.version, 1);
    assert.match(body.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, 'at 必须无秒无时区');
    assert.match(body.eatenAtUtc, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    assert.ok(body.createdAt && body.updatedAt);

    const list = await request('GET', '/v1/records', { token });
    assert.equal(list.body.items[0].id, body.id);
  });
});

describe('D-05 eat 校验', () => {
  it('空串 / 纯空白 / 缺失 / 61 字 → 422 且 fields.eat', async () => {
    const cases = ['', '   ', undefined, 'x'.repeat(61)];
    for (const eat of cases) {
      const { status, body } = await createRecord(srv.url, token, eat === undefined ? {} : { eat });
      assert.equal(status, 422, `eat=${JSON.stringify(eat)} 应 422`);
      assert.equal(body.error.code, 'VALIDATION_FAILED');
      assert.ok(body.error.fields.eat, '必须有 fields.eat');
      assert.ok(body.error.requestId);
    }
  });
});

describe('D-06 / D-19 创建幂等', () => {
  it('同一 Idempotency-Key 连发两次只生成一条，第二次带 Idempotent-Replayed', async () => {
    const key = 'k-idem-1';
    const payload = { eat: '冰粉', rating: 4 };

    const first = await request('POST', '/v1/records', {
      token,
      body: payload,
      headers: { 'Idempotency-Key': key },
    });
    assert.equal(first.status, 201);
    assert.equal(first.headers.get('idempotent-replayed'), null);

    const second = await request('POST', '/v1/records', {
      token,
      body: payload,
      headers: { 'Idempotency-Key': key },
    });
    assert.equal(second.status, 201);
    assert.equal(second.headers.get('idempotent-replayed'), 'true');
    assert.equal(second.body.id, first.body.id);

    const list = await request('GET', '/v1/records', { token });
    assert.equal(list.body.total, 1, '弱网重试不能产生两条');
  });

  it('clientRequestId 与 Idempotency-Key 等价', async () => {
    const a = await request('POST', '/v1/records', { token, body: { eat: 'A', clientRequestId: 'cr-1' } });
    const b = await request('POST', '/v1/records', { token, body: { eat: 'A', clientRequestId: 'cr-1' } });
    assert.equal(b.body.id, a.body.id);
    const list = await request('GET', '/v1/records', { token });
    assert.equal(list.body.total, 1);
  });
});

describe('D-07 PATCH 局部更新', () => {
  it('只改 note；at/createdAt 不变；version+1；updatedAt 变化', async () => {
    const created = await createRecord(srv.url, token, {
      eat: '甜水面',
      rating: 5,
      note: 'x',
      at: '2026-10-09T12:30',
    });
    const before = created.body;

    const res = await request('PATCH', `/v1/records/${before.id}`, {
      token,
      body: { note: null, rating: 4 },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.note, null, 'null 是"清除"，不是"没传"');
    assert.equal(res.body.rating, 4);
    assert.equal(res.body.eat, '甜水面', '未出现的字段保持不变');
    assert.equal(res.body.at, '2026-10-09T12:30');
    assert.equal(res.body.createdAt, before.createdAt);
    assert.equal(res.body.version, before.version + 1);
    assert.notEqual(res.body.updatedAt, before.updatedAt);
  });

  it('PATCH 可改 at，eatenAtUtc 随之重算', async () => {
    const created = await createRecord(srv.url, token, { eat: 'A', at: '2026-10-09T12:30' });
    const res = await request('PATCH', `/v1/records/${created.body.id}`, {
      token,
      body: { at: '2026-08-01T08:00' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.at, '2026-08-01T08:00');
    assert.equal(res.body.eatenAtUtc, '2026-08-01T00:00:00Z');
  });

  it('If-Match 版本不符 → 409 CONFLICT', async () => {
    const created = await createRecord(srv.url, token, { eat: 'A' });
    const res = await request('PATCH', `/v1/records/${created.body.id}`, {
      token,
      body: { eat: 'B' },
      headers: { 'If-Match': '99' },
    });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'CONFLICT');
  });
});

describe('D-08 越权 / 不存在 → 404（绝不 403）', () => {
  it('GET/PATCH/DELETE 别人的 id 全部 404', async () => {
    const other = await loginFresh(srv.url, 'code-other-user');
    const mine = await createRecord(srv.url, token, { eat: '我的' });

    for (const [method, path, body] of [
      ['GET', `/v1/records/${mine.body.id}`, undefined],
      ['PATCH', `/v1/records/${mine.body.id}`, { eat: '改了' }],
      ['DELETE', `/v1/records/${mine.body.id}`, undefined],
    ]) {
      const res = await request(method, path, { token: other.token, body });
      assert.equal(res.status, 404, `${method} 越权必须 404`);
      assert.equal(res.body.error.code, 'NOT_FOUND');
    }
  });

  it('不存在的 id 也是 404（不泄露存在性）', async () => {
    const res = await request('GET', '/v1/records/rec_not_exist', { token });
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'NOT_FOUND');
  });

  it('删除后 GET 也是 404', async () => {
    const created = await createRecord(srv.url, token, { eat: '要删的' });
    await request('DELETE', `/v1/records/${created.body.id}`, { token });
    const res = await request('GET', `/v1/records/${created.body.id}`, { token });
    assert.equal(res.status, 404);
  });
});

describe('D-09 DELETE 幂等', () => {
  it('同一条删两次 → 204 / 204', async () => {
    const created = await createRecord(srv.url, token, { eat: '删两次' });
    const id = created.body.id;

    const first = await request('DELETE', `/v1/records/${id}`, { token });
    assert.equal(first.status, 204);
    assert.equal(first.text, '');

    const second = await request('DELETE', `/v1/records/${id}`, { token });
    assert.equal(second.status, 204, '重复删除必须 204 幂等');
  });

  it('删除后列表/统计/城市计数同一次请求内立刻少一条', async () => {
    await createRecord(srv.url, token, { eat: '成都菜', city: '成都' });
    const doomed = await createRecord(srv.url, token, { eat: '要删的', city: '成都' });
    const beforeStats = await request('GET', '/v1/stats', { token });
    const beforeCities = await request('GET', '/v1/records/cities', { token });

    await request('DELETE', `/v1/records/${doomed.body.id}`, { token });

    const afterStats = await request('GET', '/v1/stats', { token });
    const afterCities = await request('GET', '/v1/records/cities', { token });
    assert.equal(afterStats.body.total, beforeStats.body.total - 1);
    assert.equal(afterCities.body.total, beforeCities.body.total - 1);
    const chengdu = afterCities.body.cityCounts.find((c) => c.city === '成都');
    assert.equal(chengdu.count, 1);
  });
});

describe('D-20 limit 边界', () => {
  it('60 条 limit=50 → hasMore=true 且 nextCursor 可用；limit=51 → 400', async () => {
    for (let i = 0; i < 60; i++) {
      const d = new Date(Date.UTC(2026, 0, 1) + i * 86400000);
      const at = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(
        d.getUTCDate(),
      ).padStart(2, '0')}T12:00`;
      await createRecord(srv.url, token, { eat: `批量${i}`, at });
    }

    const page = await request('GET', '/v1/records?limit=50', { token });
    assert.equal(page.status, 200);
    assert.equal(page.body.items.length, 50);
    assert.equal(page.body.hasMore, true);
    assert.equal(page.body.total, 60);
    assert.ok(page.body.nextCursor);

    const next = await request(
      'GET',
      `/v1/records?limit=50&cursor=${encodeURIComponent(page.body.nextCursor)}`,
      { token },
    );
    assert.equal(next.status, 200);
    assert.equal(next.body.items.length, 10);
    assert.equal(next.body.hasMore, false);
    assert.equal(next.body.nextCursor, null);

    for (const bad of ['0', '51', '-1', 'abc']) {
      const res = await request('GET', `/v1/records?limit=${bad}`, { token });
      assert.equal(res.status, 400, `limit=${bad} 应 400`);
      assert.equal(res.body.error.code, 'BAD_REQUEST');
    }
  });

  it('非法 cursor → 400 BAD_REQUEST', async () => {
    const res = await request('GET', '/v1/records?cursor=not-base64', { token });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'BAD_REQUEST');
  });

  it('limit 缺省为 10', async () => {
    for (let i = 0; i < 12; i++) {
      const day = String(i + 1).padStart(2, '0');
      await createRecord(srv.url, token, { eat: `默认${i}`, at: `2026-08-${day}T12:00` });
    }
    const res = await request('GET', '/v1/records', { token });
    assert.equal(res.body.items.length, 10);
  });
});

describe('AC-13 空串归一为 null', () => {
  it('shop/city/note/district 的空串全部返回 null，不是 ""', async () => {
    const { status, body } = await createRecord(srv.url, token, {
      eat: '冰粉',
      shop: '',
      city: '',
      note: '',
      district: '',
    });
    assert.equal(status, 201);
    for (const k of ['shop', 'city', 'note', 'district', 'photo']) {
      assert.equal(body[k], null, `${k} 应为 null 而不是空串`);
    }
  });
});

describe('AC-14 评分边界', () => {
  it('-1 / 6 / 2.5 / "3" → 422 fields.rating；0 与 5 合法', async () => {
    for (const rating of [-1, 6, 2.5, '3']) {
      const { status, body } = await createRecord(srv.url, token, { eat: 'x', rating });
      assert.equal(status, 422, `rating=${JSON.stringify(rating)} 应 422`);
      assert.ok(body.error.fields.rating);
    }
    for (const rating of [0, 1, 5]) {
      const { status, body } = await createRecord(srv.url, token, { eat: `r${rating}`, rating });
      assert.equal(status, 201);
      assert.equal(body.rating, rating);
    }
  });
});

describe('AC-15 时间', () => {
  it('不传 at = 服务端当前；未来 5 分钟以上 / 错误格式 → 422', async () => {
    const now = await createRecord(srv.url, token, { eat: '现在' });
    assert.equal(now.status, 201);
    assert.match(now.body.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);

    const future = await createRecord(srv.url, token, { eat: '未来', at: '2030-01-01T00:00' });
    assert.equal(future.status, 422);
    assert.ok(future.body.error.fields.at);

    const badFormat = await createRecord(srv.url, token, {
      eat: '格式错',
      at: '2026/01/02 03:04',
    });
    assert.equal(badFormat.status, 422);
    assert.ok(badFormat.body.error.fields.at);
  });

  it('传 at 原样返回，eatenAtUtc 正确换算', async () => {
    const { body } = await createRecord(srv.url, token, { eat: '补记', at: '2026-01-02T03:04' });
    assert.equal(body.at, '2026-01-02T03:04');
    assert.equal(body.eatenAtUtc, '2026-01-01T19:04:00Z');
    assert.equal(body.tzOffset, '+08:00');
  });
});
