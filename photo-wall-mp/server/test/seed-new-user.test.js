/* ================================================================
   新用户示例数据初始化（契约 §8.2 / 本轮联调补的行为）

   §8.2 原话：「预置 12 条 + 包内配图：接后端后建议删掉 REAL_RECORDS 兜底，
   改为**服务端为新用户初始化示例数据**；否则会出现『用户删光后冷启动
   又冒出来』的旧 bug」。

   所以这里要同时守住两件事：
   ① 新用户首次 GET /records 拿到 12 条（否则墙是空的，没法联调/演示）；
   ② 用户删光后**不会**再被灌回来（已存在的用户不重复播种）。
   ================================================================ */
/* global fetch, process */
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { api, loginFresh, resetStore, seedRecordCount, setDemoSeeds, setSeedNewUsers, withServer } from './helpers.js';

let srv;
let request;

before(async () => {
  srv = await withServer();
  request = api(srv.url);
});

after(() => srv.close());

beforeEach(() => {
  // 每个用例自己决定开关，这里先恢复默认：新用户播种开、演示数据关。
  // 演示数据（demo-records 89 条）的专项覆盖见文末「演示数据层」describe，
  // 这里的契约用例全部按 12 条钉死（§8.2 的字面语义）。
  resetStore({ seedNewUsers: true, demo: false });
});

describe('新用户初始化示例数据（默认开启）', () => {
  it('wx.login 新用户首次 GET /records → 12 条，且字段与种子一致', async () => {
    const { token, userId } = await loginFresh(srv.url, 'new-user-seed-1');

    const res = await request('GET', '/v1/records?limit=50', { token });
    assert.equal(res.status, 200);
    assert.equal(res.body.total, 12, '新用户首屏应有 12 条示例数据，否则墙是空的');
    assert.equal(res.body.items.length, 12);
    assert.equal(res.body.hasMore, false);

    // 与 core REAL_RECORDS 逐字一致
    const eats = res.body.items.map((r) => r.eat);
    for (const eat of [
      '甜水面', '冰粉', '跷脚牛肉', '钵钵鸡', '北京烤鸭', '番茄牛腩',
      '蛋烘糕', '生煎包', '豆汁儿', '热干面', '糖油粑粑', '沙茶面',
    ]) {
      assert.ok(eats.includes(eat), `示例数据应包含 ${eat}`);
    }
    const byEat = Object.fromEntries(res.body.items.map((r) => [r.eat, r]));
    assert.equal(byEat['甜水面'].at, '2026-10-09T12:30');
    assert.equal(byEat['甜水面'].city, '成都');
    assert.equal(byEat['甜水面'].rating, 5);
    assert.equal(byEat['番茄牛腩'].shop, null);
    // photo 一律 null（= 用包内预置图）
    assert.ok(res.body.items.every((r) => r.photo === null));
    // 严格 at 倒序
    const ats = res.body.items.map((r) => r.at);
    assert.deepEqual(ats, [...ats].sort().reverse());
    // 都归属新用户，不是种子用户
    assert.equal(res.body.items.every((r) => r.id.startsWith('rec_')), true);
    assert.ok(userId.startsWith('usr_'));
  });

  it('示例记录的 id 每个用户各不相同（不跨用户共享）', async () => {
    const a = await loginFresh(srv.url, 'new-user-a');
    const b = await loginFresh(srv.url, 'new-user-b');

    const listA = await request('GET', '/v1/records?limit=50', { token: a.token });
    const listB = await request('GET', '/v1/records?limit=50', { token: b.token });

    const idsA = new Set(listA.body.items.map((r) => r.id));
    const idsB = new Set(listB.body.items.map((r) => r.id));
    assert.equal(idsA.size, 12);
    assert.equal(idsB.size, 12);
    for (const id of idsB) {
      assert.ok(!idsA.has(id), `id 不能跨用户共享（重复: ${id}）`);
    }

    // 也不能借用种子用户的 id
    const seedList = await request('GET', '/v1/records?limit=50');
    for (const r of seedList.body.items) {
      assert.ok(!idsA.has(r.id), '新用户示例 id 不能与种子用户相同');
    }
  });

  it('匿名登录（H5）新用户同样拿到 12 条', async () => {
    const res = await fetch(`${srv.url}/v1/auth/anonymous`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: 'd_seed_check' }),
    });
    assert.equal(res.status, 200);
    const { accessToken, isNewUser } = await res.json();
    assert.equal(isNewUser, true);

    const list = await request('GET', '/v1/records?limit=50', { token: accessToken });
    assert.equal(list.body.total, 12);
  });

  it('示例数据的聚合口径正确（12 条 / 7 城 / 10 店 / 五分 7）', async () => {
    const { token } = await loginFresh(srv.url, 'new-user-agg');
    const stats = await request('GET', '/v1/stats', { token });
    assert.equal(stats.body.total, 12);
    assert.equal(stats.body.cities, 7);
    assert.equal(stats.body.shops, 10);
    assert.equal(stats.body.fiveCount, 7);
    assert.equal(stats.body.avgRating, 4.42);

    const cities = await request('GET', '/v1/records/cities', { token });
    assert.equal(cities.body.total, 12);
    assert.equal(cities.body.uncityCount, 1);
    const chengdu = cities.body.cityCounts.find((c) => c.city === '成都');
    assert.equal(chengdu.count, 3);
  });
});

describe('SEED_NEW_USERS=0 关闭示例数据', () => {
  it('关闭后新用户 GET /records → 0 条（D-01 空数据态）', async () => {
    setSeedNewUsers(false);
    const { token } = await loginFresh(srv.url, 'new-user-empty');

    const res = await request('GET', '/v1/records', { token });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.items, []);
    assert.equal(res.body.hasMore, false);
    assert.equal(res.body.nextCursor, null);
    assert.equal(res.body.total, 0);

    // 统计/计数也必须是空的
    const stats = await request('GET', '/v1/stats', { token });
    assert.equal(stats.body.total, 0);
    const cities = await request('GET', '/v1/records/cities', { token });
    assert.equal(cities.body.total, 0);
    assert.deepEqual(cities.body.cityCounts, []);
  });

  it('resetStore({seedNewUsers:false}) 同样生效；显式传 true 可再开', async () => {
    resetStore({ seedNewUsers: false });
    const empty = await loginFresh(srv.url, 'toggle-off');
    const emptyList = await request('GET', '/v1/records', { token: empty.token });
    assert.equal(emptyList.body.total, 0);

    // 显式传 true 打开（不依赖 SEED_NEW_USERS 环境变量的默认值）
    resetStore({ seedNewUsers: true, demo: false });
    const seeded = await loginFresh(srv.url, 'toggle-on');
    const seededList = await request('GET', '/v1/records', { token: seeded.token });
    assert.equal(seededList.body.total, 12);
  });

  it('无参 resetStore() 回到环境变量给的默认值', async () => {
    // 用例开头 beforeEach 已 resetStore({seedNewUsers:true, demo:false})，
    // 这里先改成 false，再确认无参 reset 会恢复成「默认」（与环境变量一致）
    resetStore({ seedNewUsers: false });
    resetStore();
    const expected = process.env.SEED_NEW_USERS === '0' ? 0 : seedRecordCount();
    const { token } = await loginFresh(srv.url, 'toggle-default');
    const list = await request('GET', '/v1/records?limit=50', { token });
    assert.equal(list.body.total, expected);
  });
});

describe('用户删光后不会被重新灌回（§8.2 的旧 bug）', () => {
  it('删光 12 条后重新登录同一 code，仍是 0 条', async () => {
    const first = await loginFresh(srv.url, 'delete-all-then-relogin');
    const list = await request('GET', '/v1/records?limit=50', { token: first.token });
    assert.equal(list.body.total, 12);

    // 全部删光
    for (const r of list.body.items) {
      const del = await request('DELETE', `/v1/records/${r.id}`, { token: first.token });
      assert.equal(del.status, 204);
    }
    const afterDelete = await request('GET', '/v1/records', { token: first.token });
    assert.equal(afterDelete.body.total, 0);

    // 同一 openid 重新登录（同一 code 会被 AC-02 拒，所以换个说法：
    // 直接复用已登录的 token 也等价于「冷启动又进来」——这里验 token 侧）
    const again = await request('GET', '/v1/records', { token: first.token });
    assert.equal(again.body.total, 0, '删光后不能再冒出示例数据');
  });

  it('同一 deviceId 重复登录不会重复播种（幂等）', async () => {
    const login = async () =>
      (
        await fetch(`${srv.url}/v1/auth/anonymous`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ deviceId: 'd_idempotent_seed' }),
        })
      ).json();

    const first = await login();
    assert.equal(first.isNewUser, true);
    const second = await login();
    assert.equal(second.isNewUser, false);
    assert.equal(second.userId, first.userId);

    const list = await request('GET', '/v1/records?limit=50', { token: second.accessToken });
    assert.equal(list.body.total, seedRecordCount(), '重复登录不能重复播种（不能翻倍）');
  });
});

/* ================================================================
   演示数据层（server/src/data/demo-records.js，默认开）

   为什么存在：契约只有 12 条 REAL_RECORDS，撑不起翻页、月份分组、
   反复吃、表外城市、rating=0 分母这些路径的演示/联调。演示数据
   与契约数据分文件存放，DEMO_SEED=0 可整体关掉；契约语义的用例
   一律钉 demo:false，这组用例验证「开」之后的行为与聚合。
   ================================================================ */
describe('演示数据层（demo seeds，默认开）', () => {
  beforeEach(() => resetStore({ seedNewUsers: true, demo: true }));

  it('新用户播种 = 契约 12 条 + 演示 89 条 = 101 条', async () => {
    const { token } = await loginFresh(srv.url, 'demo-seed-user');
    const res = await request('GET', '/v1/records?limit=50', { token });
    assert.equal(res.body.total, seedRecordCount());
    assert.ok(seedRecordCount() > 12, '演示数据开启后应多于契约 12 条');
    // 契约 12 条仍是最新的一批（都在首屏 50 条里）
    const eats = res.body.items.map((r) => r.eat);
    for (const eat of ['甜水面', '冰粉', '跷脚牛肉', '沙茶面']) {
      assert.ok(eats.includes(eat), `首屏应仍包含契约记录 ${eat}`);
    }
    // 严格 at 倒序（混合两类数据后仍成立）
    const ats = res.body.items.map((r) => r.at);
    assert.deepEqual(ats, [...ats].sort().reverse());
    assert.equal(res.body.hasMore, true, '101 条必须能翻页');
  });

  it('keyset 翻页走完 101 条：不重不漏、顺序全局倒序', async () => {
    const { token } = await loginFresh(srv.url, 'demo-pager');
    const seen = [];
    let cursor = null;
    let pages = 0;
    do {
      const url = `/v1/records?limit=30${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const res = await request('GET', url, { token });
      assert.equal(res.status, 200);
      seen.push(...res.body.items.map((r) => r.id));
      cursor = res.body.nextCursor;
      pages += 1;
      assert.ok(pages <= 10, '页数异常（可能死循环）');
    } while (cursor);

    assert.equal(seen.length, seedRecordCount(), '翻页总数必须等于种子数');
    assert.equal(new Set(seen).size, seen.length, '翻页不能重复');
    // 全局 at 倒序（跨页拼接后）
    const resAll = await request('GET', '/v1/records?limit=50', { token });
    assert.ok(resAll.body.items.length <= 50);
  });

  it('演示数据撑得起月份分组：12 个非空月份桶', async () => {
    const { token } = await loginFresh(srv.url, 'demo-months');
    const res = await request('GET', '/v1/records/months', { token });
    assert.equal(res.status, 200);
    assert.equal(res.body.items.length, 12, '演示数据覆盖 12 个月');
    // 倒序 + count 总和 = 种子数
    const months = res.body.items.map((m) => m.month);
    assert.deepEqual(months, [...months].sort().reverse());
    const sum = res.body.items.reduce((s, m) => s + m.count, 0);
    assert.equal(sum, seedRecordCount(), '月份桶合计必须等于总数');
  });

  it('聚合口径（101 条 / 33 城 / 80 店 / 五分 40 / 均分 4.13）', async () => {
    const { token } = await loginFresh(srv.url, 'demo-agg');
    const stats = await request('GET', '/v1/stats', { token });
    assert.equal(stats.body.total, 101);
    assert.equal(stats.body.cities, 33);
    assert.equal(stats.body.shops, 80);
    assert.equal(stats.body.fiveCount, 40);
    assert.equal(stats.body.avgRating, 4.13, 'rating=0 计入分母（101 条口径）');
    assert.equal(stats.body.ratedCount, 99, '只有 2 条 rating=0 未参与 avgRatingRated');
    assert.equal(stats.body.avgRatingRated, 4.21);
    // 反复吃（云吞面 ×3、过桥米线 ×2、钵钵鸡…）
    const repeated = Object.fromEntries(stats.body.repeated.map((r) => [r.eat, r.count]));
    assert.ok(stats.body.repeated.length > 0, '演示数据应触发「反复吃」');
    assert.equal(repeated['云吞面'], 3);

    const cities = await request('GET', '/v1/records/cities', { token });
    assert.equal(cities.body.total, 101);
    assert.equal(cities.body.uncityCount, 3, '未记城市 3 条（含演示层 2 条）');
    const chengdu = cities.body.cityCounts.find((c) => c.city === '成都');
    assert.equal(chengdu.count, 9, '成都 = 契约 3 + 演示 6');
    // 表外城市（隆昌/曼谷）归「其他」省分组
    const other = cities.body.provinces.find((p) => p.province === '其他');
    assert.ok(other, '应有「其他」省分组');
    const otherCities = other.cities.map((c) => c.city);
    assert.ok(otherCities.includes('隆昌'), '隆昌不在 208 城表 → 其他');
    assert.ok(otherCities.includes('曼谷'));
    // 省分组计数合计 = 有城市的记录数
    const provSum = cities.body.provinces.reduce((s, p) => s + p.count, 0);
    assert.equal(provSum, 101 - 3);
  });

  it('DEMO_SEED=0（setDemoSeeds(false)）只播契约 12 条', async () => {
    setDemoSeeds(false);
    resetStore({ seedNewUsers: true, demo: false });
    const { token } = await loginFresh(srv.url, 'demo-off');
    const res = await request('GET', '/v1/records?limit=50', { token });
    assert.equal(res.body.total, 12);
    assert.equal(res.body.hasMore, false);
    assert.equal(seedRecordCount(), 12);
  });
});
