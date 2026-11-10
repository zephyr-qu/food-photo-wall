/* ================================================================
   聚合口径（契约 §6.3 / 验收 D-10~D-13、AC-21~AC-24）
   这些数字算错用户不会立刻发现，但会让整面墙显得不可信，
   所以逐条按文档公式断言。
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
  // 聚合用例自造数据，必须从空数据起（否则会混进新用户示例的 12 条）
  resetStore({ seedNewUsers: false });
  ({ token } = await loginFresh(srv.url, `agg-${Math.random().toString(36).slice(2)}`));
});

/** 造 AC-21 的分布：成都×3、乐山×2、北京×2、景德镇×1、未记×1 = 9 条 */
async function seedAc21() {
  const rows = [
    ...Array.from({ length: 3 }, (_, i) => ({ city: '成都', eat: `成都菜${i}` })),
    ...Array.from({ length: 2 }, (_, i) => ({ city: '乐山', eat: `乐山菜${i}` })),
    ...Array.from({ length: 2 }, (_, i) => ({ city: '北京', eat: `北京菜${i}` })),
    { city: '景德镇', eat: '冷粉' },
    { city: null, eat: '自己做的' },
  ];
  let day = 1;
  for (const row of rows) {
    const at = `2026-09-${String(day++).padStart(2, '0')}T12:00`;
    const { status } = await createRecord(srv.url, token, { ...row, at });
    assert.equal(status, 201);
  }
}

describe('D-10 城市筛选三种语义 + 计数一致性', () => {
  it('无参数 / city=成都 / cityMissing=true 与 cities 聚合对应一致', async () => {
    await seedAc21();

    const all = await request('GET', '/v1/records', { token });
    const chengdu = await request('GET', `/v1/records?city=${encodeURIComponent('成都')}`, { token });
    const missing = await request('GET', '/v1/records?cityMissing=true', { token });
    const cities = await request('GET', '/v1/records/cities', { token });

    assert.equal(all.body.total, 9);
    assert.equal(chengdu.body.total, 3);
    assert.equal(missing.body.total, 1);

    // 计数桶必须与筛选 total 一致（AC-21 不变量）
    assert.equal(cities.body.total, all.body.total);
    assert.equal(cities.body.uncityCount, missing.body.total);
    const cd = cities.body.cityCounts.find((c) => c.city === '成都');
    assert.equal(cd.count, chengdu.body.total);

    // 筛选结果的内容也要对
    assert.ok(chengdu.body.items.every((r) => r.city === '成都'));
    assert.ok(missing.body.items.every((r) => r.city === null));

    // 统计不吃城市筛选（D-10：总全部不随筛选变）
    const stats = await request('GET', '/v1/stats', { token });
    assert.equal(stats.body.total, 9);
  });

  it('city 与 cityMissing 同时传 → 400', async () => {
    const res = await request('GET', `/v1/records?city=${encodeURIComponent('成都')}&cityMissing=true`, {
      token,
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'BAD_REQUEST');
  });
});

describe('D-11 城市计数排序 + 省分组', () => {
  it('cityCounts count 降序（同数拼音序）；provinces 码点序；不变量成立', async () => {
    await seedAc21();
    const res = await request('GET', '/v1/records/cities', { token });
    assert.equal(res.status, 200);

    assert.equal(res.body.total, 9);
    assert.equal(res.body.uncityCount, 1);
    assert.equal(res.body.cityCounts.length, 4, '未记不占 cityCounts 的桶');

    // count 降序
    for (let i = 1; i < res.body.cityCounts.length; i++) {
      assert.ok(res.body.cityCounts[i - 1].count >= res.body.cityCounts[i].count);
    }
    const byCity = Object.fromEntries(res.body.cityCounts.map((c) => [c.city, c.count]));
    assert.deepEqual(byCity, { 成都: 3, 乐山: 2, 北京: 2, 景德镇: 1 });

    // 同数按拼音序：北京(b) 在 乐山(l) 前
    const tied = res.body.cityCounts.filter((c) => c.count === 2).map((c) => c.city);
    assert.deepEqual(tied, ['北京', '乐山'], '同数应按 zh-Hans-CN 拼音序');

    // provinces
    const prov = Object.fromEntries(res.body.provinces.map((p) => [p.province, p.count]));
    assert.equal(prov['四川'], 5);
    assert.equal(prov['北京'], 2);
    assert.equal(prov['江西'], 1, '景德镇归江西，不是表外');
    assert.ok(!('其他' in prov), '本例无表外城市');
    // 未记不参与省分组
    assert.ok(!res.body.provinces.some((p) => p.cities.some((c) => c.city === null)));

    // 不变量
    const sumCity = res.body.cityCounts.reduce((s, c) => s + c.count, 0);
    const sumProv = res.body.provinces.reduce((s, p) => s + p.count, 0);
    assert.equal(sumCity + res.body.uncityCount, res.body.total);
    assert.equal(sumProv + res.body.uncityCount, res.body.total);
  });

  it('表外城市归「其他」', async () => {
    await createRecord(srv.url, token, { eat: 'X', city: '不存在市' });
    const res = await request('GET', '/v1/records/cities', { token });
    const other = res.body.provinces.find((p) => p.province === '其他');
    assert.ok(other, '表外城市必须归「其他」');
    assert.equal(other.count, 1);
  });

  it('空数据返回空桶', async () => {
    const res = await request('GET', '/v1/records/cities', { token });
    assert.equal(res.body.total, 0);
    assert.equal(res.body.uncityCount, 0);
    assert.deepEqual(res.body.cityCounts, []);
    assert.deepEqual(res.body.provinces, []);
    assert.ok(res.body.generatedAt);
  });
});

describe('D-12 / AC-22 统计口径（重点）', () => {
  it('avgRating 分母含 0 分；repeated 只含 ≥2 次且不截断', async () => {
    // 4 条：甜水面×2(rating 5)、冰粉(rating 0)、烤鸭(rating 4)
    await createRecord(srv.url, token, { eat: '甜水面', rating: 5, city: '成都', at: '2026-10-01T12:00' });
    await createRecord(srv.url, token, { eat: '甜水面', rating: 5, city: '成都', at: '2026-10-02T12:00' });
    await createRecord(srv.url, token, { eat: '冰粉', rating: 0, at: '2026-10-03T12:00' });
    await createRecord(srv.url, token, { eat: '烤鸭', rating: 4, city: '北京', at: '2026-10-04T12:00' });

    const res = await request('GET', '/v1/stats', { token });
    assert.equal(res.status, 200);
    assert.equal(res.body.total, 4);
    assert.equal(res.body.fiveCount, 2);
    assert.equal(res.body.firstFiveEat, '甜水面', '按时间倒序第一条五分');
    assert.equal(res.body.cities, 2, 'null 城市不计');
    assert.equal(res.body.dishCount, 3);
    assert.equal(res.body.avgRating, 3.5, '(5+5+0+4)/4，0 分计入分母');
    assert.equal(res.body.ratedCount, 3);
    assert.equal(res.body.avgRatingRated, 4.67, '14/3 保留两位');
    assert.deepEqual(res.body.repeated, [{ eat: '甜水面', count: 2 }]);
  });

  it('repeated 按次数降序、同数按拼音序，且不截断', async () => {
    for (let i = 0; i < 3; i++) await createRecord(srv.url, token, { eat: '冰粉' });
    for (let i = 0; i < 2; i++) await createRecord(srv.url, token, { eat: '甜水面' });
    for (let i = 0; i < 2; i++) await createRecord(srv.url, token, { eat: '生煎包' });
    await createRecord(srv.url, token, { eat: '烤鸭' });

    const res = await request('GET', '/v1/stats', { token });
    assert.equal(res.body.repeated.length, 3, '不要服务端截断（前端只取前 3）');
    assert.deepEqual(res.body.repeated[0], { eat: '冰粉', count: 3 });
    const tied = res.body.repeated.slice(1).map((r) => r.eat);
    assert.deepEqual(tied, ['生煎包', '甜水面'], '同数按 zh-Hans-CN');
  });

  it('空数据 avgRating=0、firstFiveEat=""', async () => {
    const res = await request('GET', '/v1/stats', { token });
    assert.equal(res.body.total, 0);
    assert.equal(res.body.avgRating, 0);
    assert.equal(res.body.avgRatingRated, 0);
    assert.equal(res.body.firstFiveEat, '');
    assert.deepEqual(res.body.repeated, []);
  });
});

describe('D-13 / AC-24 随机一道', () => {
  it('候选 > 1 时排除 excludeId；空候选 404 NO_RECORD；带 no-store', async () => {
    // 成都只有 1 条（用于验证"候选只剩 1 条时允许重复返回它"），北京 5 条
    await createRecord(srv.url, token, { eat: '成都独苗', city: '成都' });
    for (let i = 0; i < 5; i++) {
      await createRecord(srv.url, token, { eat: `北京菜${i}`, city: '北京' });
    }

    const all = await request('GET', '/v1/records', { token });
    const excludeId = all.body.items[0].id;

    // 连抽 20 次，候选 6 > 1，必须每次都不是 excludeId
    for (let i = 0; i < 20; i++) {
      const res = await request(
        'GET',
        `/v1/records/random?excludeId=${encodeURIComponent(excludeId)}`,
        { token },
      );
      assert.equal(res.status, 200);
      assert.notEqual(res.body.record.id, excludeId, '候选 >1 时必须排除 excludeId');
      assert.equal(res.headers.get('cache-control'), 'no-store');
    }

    // 候选只有 1 条时允许返回它（前端也允许重复）
    const chengdu = await request('GET', `/v1/records?city=${encodeURIComponent('成都')}`, { token });
    assert.equal(chengdu.body.total, 1);
    const onlyId = chengdu.body.items[0].id;
    const only = await request(
      'GET',
      `/v1/records/random?city=${encodeURIComponent('成都')}&excludeId=${encodeURIComponent(onlyId)}`,
      { token },
    );
    assert.equal(only.status, 200, '候选只有 1 条时允许返回它');
    assert.equal(only.body.record.id, onlyId);

    // 空候选 → 404 NO_RECORD
    const empty = await request('GET', `/v1/records/random?city=${encodeURIComponent('没有这个城市')}`, {
      token,
    });
    assert.equal(empty.status, 404);
    assert.equal(empty.body.error.code, 'NO_RECORD');
  });

  it('随机结果都属于当前用户，且分布覆盖多条（不是永远同一条）', async () => {
    const ids = new Set();
    for (let i = 0; i < 10; i++) {
      const { body } = await createRecord(srv.url, token, { eat: `随机${i}` });
      ids.add(body.id);
    }
    const seen = new Set();
    for (let i = 0; i < 40; i++) {
      const res = await request('GET', '/v1/records/random', { token });
      assert.equal(res.status, 200);
      assert.ok(ids.has(res.body.record.id));
      seen.add(res.body.record.id);
    }
    assert.ok(seen.size > 1, '随机应能抽到不同记录');
  });
});

describe('AC-34 月份桶按 at_local 归桶（时区边界）', () => {
  it('2026-09-30T23:59 与 2026-10-01T00:00 分属两个桶', async () => {
    await createRecord(srv.url, token, { eat: '九月', at: '2026-09-30T23:59' });
    await createRecord(srv.url, token, { eat: '十月', at: '2026-10-01T00:00' });

    const res = await request('GET', '/v1/records/months', { token });
    assert.equal(res.status, 200);
    const map = Object.fromEntries(res.body.items.map((m) => [m.month, m.count]));
    // 2026-10-01T00:00 (+08:00) 的 UTC 是 2026-09-30T16:00Z：
    // 若按 UTC 归桶会错归到 9 月，这里必须按 at 归桶
    assert.equal(map['2026-09'], 1);
    assert.equal(map['2026-10'], 1);
    // 月份倒序
    assert.deepEqual(
      res.body.items.map((m) => m.month),
      ['2026-10', '2026-09'],
    );
    // firstCursor 可用
    const cursor = res.body.items[0].firstCursor;
    assert.ok(cursor);
    const page = await request('GET', `/v1/records?cursor=${encodeURIComponent(cursor)}`, { token });
    assert.equal(page.status, 200);
  });
});

describe('AC-25 / AC-26 店铺聚合', () => {
  it('按名聚合：visitCount/dishCount/avgRating(只算已评)/fiveCount/firstAt/lastAt', async () => {
    await createRecord(srv.url, token, {
      eat: '北京烤鸭', shop: '四季民福', city: '北京', rating: 5, at: '2026-09-30T18:00',
    });
    await createRecord(srv.url, token, {
      eat: '宫保鸡丁', shop: '四季民福', city: '北京', rating: 4, at: '2026-10-09T12:30',
    });
    // 一条未评分：应计入 visitCount，但不拉低 avgRating
    await createRecord(srv.url, token, {
      eat: '豌豆黄', shop: '四季民福', city: '北京', rating: 0, at: '2026-10-01T10:00',
    });

    const res = await request('GET', `/v1/shops/by-name?name=${encodeURIComponent('四季民福')}`, { token });
    assert.equal(res.status, 200);
    assert.equal(res.body.stats.visitCount, 3);
    assert.equal(res.body.stats.dishCount, 3);
    assert.equal(res.body.stats.avgRating, 4.5, '店铺均分只算已评（与墙统计不同）');
    assert.equal(res.body.stats.ratedCount, 2);
    assert.equal(res.body.stats.fiveCount, 1);
    assert.equal(res.body.stats.firstAt, '2026-09-30T18:00');
    assert.equal(res.body.stats.lastAt, '2026-10-09T12:30');
    assert.equal(res.body.shop.name, '四季民福');
    // records 倒序
    assert.deepEqual(res.body.records.map((r) => r.eat), ['宫保鸡丁', '豌豆黄', '北京烤鸭']);
  });

  it('同名跨城：合并聚合 + candidates；带 city 只聚合那一家', async () => {
    await createRecord(srv.url, token, { eat: '面', shop: '老张面馆', city: '北京', rating: 5 });
    await createRecord(srv.url, token, { eat: '拌面', shop: '老张面馆', city: '上海', rating: 3 });

    const merged = await request('GET', `/v1/shops/by-name?name=${encodeURIComponent('老张面馆')}`, { token });
    assert.equal(merged.status, 200);
    assert.equal(merged.body.stats.visitCount, 2, '合并聚合');
    assert.equal(merged.body.shop, null, '无法唯一确定城市时 shop=null');
    assert.ok(Array.isArray(merged.body.candidates));
    assert.equal(merged.body.candidates.length, 2);
    for (const c of merged.body.candidates) {
      assert.ok(c.id.startsWith('shp_'));
      assert.equal(c.name, '老张面馆');
      assert.equal(c.cities.length, 1);
    }

    const beijing = await request(
      'GET',
      `/v1/shops/by-name?name=${encodeURIComponent('老张面馆')}&city=${encodeURIComponent('北京')}`,
      { token },
    );
    assert.equal(beijing.body.stats.visitCount, 1);
    assert.equal(beijing.body.shop.cities[0], '北京');
  });

  it('无记录 → 404', async () => {
    const res = await request('GET', `/v1/shops/by-name?name=${encodeURIComponent('不存在')}`, { token });
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'NOT_FOUND');
  });
});

describe('N-04 / N-05 字符与长文本', () => {
  it('中文/emoji 菜名正确往返', async () => {
    const eat = '🍜 拉面';
    const { status, body } = await createRecord(srv.url, token, { eat });
    assert.equal(status, 201);
    assert.equal(body.eat, eat);
    const got = await request('GET', `/v1/records/${body.id}`, { token });
    assert.equal(got.body.eat, eat);
  });

  it('note 200 字（含换行）完整返回；超 200 → 422', async () => {
    const note = 'a'.repeat(199) + '\n';
    const ok = await createRecord(srv.url, token, { eat: 'x', note });
    assert.equal(ok.status, 201);
    assert.equal(ok.body.note, note);

    const tooLong = await createRecord(srv.url, token, { eat: 'x', note: 'b'.repeat(201) });
    assert.equal(tooLong.status, 422);
    assert.ok(tooLong.body.error.fields.note);
  });
});
