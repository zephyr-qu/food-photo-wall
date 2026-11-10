/** 验收：聚合口径（AC-21 ~ AC-23、AC-34） */
import test from 'node:test';
import assert from 'node:assert/strict';
import { addRecord, call, login, makeApp } from './helpers.js';

const at = (y: number, m: number, d: number, hh = 12, mm = 0): string =>
  `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;

test('AC-21 城市计数 + 省分组：排序与三条不变量', async (t) => {
  const { app, close } = await makeApp();
  t.after(close);
  const token = await login(app);

  const rows: Array<[string | null, number]> = [
    ['成都', 3],
    ['乐山', 2],
    ['北京', 2],
    ['景德镇', 1],
    [null, 1],
  ];
  let day = 1;
  for (const [city, count] of rows) {
    for (let i = 0; i < count; i++) {
      await addRecord(app, token, { eat: `${city ?? '未记'}-${i}`, city, at: at(2026, 9, day++) });
    }
  }

  const res = await call(app, '/v1/records/cities', { token });
  assert.equal(res.status, 200);
  const { total, uncityCount, cityCounts, provinces } = res.body;

  assert.equal(total, 9);
  assert.equal(uncityCount, 1);
  // 景德镇在字典内 → 属江西，不是「其他」
  assert.deepEqual(cityCounts, [
    { city: '成都', count: 3 },
    { city: '北京', count: 2 }, // count 相同 → 拼音序 北京(beijing) < 乐山(leshan)
    { city: '乐山', count: 2 },
    { city: '景德镇', count: 1 },
  ]);
  assert.deepEqual(provinces, [
    { province: '四川', count: 5, cities: [{ city: '成都', count: 3 }, { city: '乐山', count: 2 }] },
    { province: '北京', count: 2, cities: [{ city: '北京', count: 2 }] },
    { province: '江西', count: 1, cities: [{ city: '景德镇', count: 1 }] },
  ]);

  // 不变量：未记单独由 uncityCount 承载，不进 cityCounts / provinces
  const citySum = cityCounts.reduce((s: number, x: { count: number }) => s + x.count, 0);
  const provSum = provinces.reduce((s: number, x: { count: number }) => s + x.count, 0);
  assert.equal(citySum + uncityCount, total);
  assert.equal(provSum + uncityCount, total);
  assert.equal(
    provinces.some((p: { province: string }) => p.province === '其他'),
    false,
  );

  // 与列表筛选口径一致：cityCounts[c] === GET /records?city=c 的 total
  for (const { city, count } of cityCounts) {
    const list = await call(app, `/v1/records?city=${encodeURIComponent(city)}`, { token });
    assert.equal(list.body.total, count, `cityCounts[${city}] 必须等于列表 total`);
  }
});

test('AC-21b 表外城市归「其他」', async (t) => {
  const { app, close } = await makeApp();
  t.after(close);
  const token = await login(app);

  await addRecord(app, token, { eat: 'a', city: '成都', at: at(2026, 9, 1) });
  await addRecord(app, token, { eat: 'b', city: '东京', at: at(2026, 9, 2) });
  await addRecord(app, token, { eat: 'c', city: null, at: at(2026, 9, 3) });

  const res = await call(app, '/v1/records/cities', { token });
  assert.equal(res.body.total, 3);
  assert.equal(res.body.uncityCount, 1);
  const other = res.body.provinces.find((p: { province: string }) => p.province === '其他');
  assert.ok(other, '字典外城市应归「其他」');
  assert.deepEqual(other.cities, [{ city: '东京', count: 1 }]);
});

test('AC-22 统计口径：avgRating 含 0 分母、repeated ≥2', async (t) => {
  const { app, close } = await makeApp();
  t.after(close);
  const token = await login(app);

  await addRecord(app, token, { eat: '甜水面', city: '成都', rating: 5, at: at(2026, 9, 1) });
  await addRecord(app, token, { eat: '甜水面', city: '成都', rating: 5, at: at(2026, 9, 2) });
  await addRecord(app, token, { eat: '冰粉', city: null, rating: 0, at: at(2026, 9, 3) });
  await addRecord(app, token, { eat: '烤鸭', city: '北京', rating: 4, at: at(2026, 9, 4) });

  const res = await call(app, '/v1/stats', { token });
  assert.equal(res.status, 200);
  const s = res.body;

  assert.equal(s.total, 4);
  assert.equal(s.fiveCount, 2);
  assert.equal(s.firstFiveEat, '甜水面');
  assert.equal(s.cities, 2, 'city=null 不计入 cities');
  assert.equal(s.shops, 0);
  assert.equal(s.dishCount, 3);
  assert.equal(s.avgRating, 3.5, '(5+5+0+4)/4，0 分计入分母');
  assert.equal(s.ratedCount, 3);
  assert.equal(s.avgRatingRated, 4.67, '14/3 四舍五入两位');
  assert.deepEqual(s.repeated, [{ eat: '甜水面', count: 2 }]);
  assert.deepEqual(s.scope, { city: null, cityMissing: false, from: null, to: null });
  assert.ok(s.generatedAt);
});

test('AC-22b firstFiveEat 取"时间倒序第一条 5 分"', async (t) => {
  const { app, close } = await makeApp();
  t.after(close);
  const token = await login(app);

  await addRecord(app, token, { eat: '旧五分', rating: 5, at: at(2026, 1, 1) });
  await addRecord(app, token, { eat: '新五分', rating: 5, at: at(2026, 6, 1) });
  await addRecord(app, token, { eat: '没分', rating: 0, at: at(2026, 7, 1) });

  const res = await call(app, '/v1/stats', { token });
  assert.equal(res.body.firstFiveEat, '新五分');
});

test('AC-22c repeated 排序：次数降序 → 同数拼音序，且不截断', async (t) => {
  const { app, close } = await makeApp();
  t.after(close);
  const token = await login(app);

  const dishes = ['甲菜', '甲菜', '甲菜', '冰粉', '冰粉', '生煎包', '生煎包', '单独'];
  let day = 1;
  for (const eat of dishes) await addRecord(app, token, { eat, at: at(2026, 9, day++) });

  const res = await call(app, '/v1/stats', { token });
  assert.deepEqual(res.body.repeated, [
    { eat: '甲菜', count: 3 },
    { eat: '冰粉', count: 2 }, // 冰粉(bing) < 生煎包(sheng)
    { eat: '生煎包', count: 2 },
  ]);
});

test('AC-23 统计默认全量；显式 city 参数才收窄（P2）', async (t) => {
  const { app, close } = await makeApp();
  t.after(close);
  const token = await login(app);

  await addRecord(app, token, { eat: 'a', city: '成都', rating: 5, at: at(2026, 9, 1) });
  await addRecord(app, token, { eat: 'b', city: '成都', rating: 5, at: at(2026, 9, 2) });
  await addRecord(app, token, { eat: 'c', city: '北京', rating: 4, at: at(2026, 9, 3) });

  const full = await call(app, '/v1/stats', { token });
  const again = await call(app, '/v1/stats', { token });
  assert.equal(full.body.total, 3);
  assert.deepEqual(full.body, again.body, '无参数时结果稳定（全量口径）');

  const scoped = await call(app, '/v1/stats?city=%E6%88%90%E9%83%BD', { token });
  assert.equal(scoped.body.total, 2);
  assert.deepEqual(scoped.body.scope, { city: '成都', cityMissing: false, from: null, to: null });
});

test('AC-34 月份桶按本地墙钟归桶（不是 UTC）+ firstCursor 严格 after', async (t) => {
  const { app, close } = await makeApp();
  t.after(close);
  const token = await login(app);

  // 这两条是关键：+08:00 的 11-01 00:00 在 UTC 是 10-31 16:00
  const oct = await addRecord(app, token, { eat: '十月末', at: '2025-10-31T23:59', tzOffset: '+08:00' });
  const nov = await addRecord(app, token, { eat: '十一月初', at: '2025-11-01T00:00', tzOffset: '+08:00' });

  const months = await call(app, '/v1/records/months', { token });
  assert.equal(months.status, 200);
  assert.deepEqual(
    months.body.items.map((m: { month: string; count: number }) => ({ month: m.month, count: m.count })),
    [
      { month: '2025-11', count: 1 },
      { month: '2025-10', count: 1 },
    ],
    'UTC 归桶会把 2025-11 吞进 2025-10',
  );

  const novItem = months.body.items.find((m: { month: string }) => m.month === '2025-11');
  assert.ok(novItem.firstCursor, '该月有记录就应给 firstCursor');

  // keyset 是严格 < cursor：从 firstCursor 往后翻，不含该月第一条本身
  const after = await call(app, `/v1/records?cursor=${encodeURIComponent(novItem.firstCursor)}`, { token });
  const ids = after.body.items.map((r: { id: string }) => r.id);
  assert.equal(ids.includes(nov.id), false, '严格 after：不包含游标那条');
  assert.equal(ids.includes(oct.id), true);

  // 文档建议的整月跳转：用 from/to 取整月，不漏第一条
  const wholeMonth = await call(app, '/v1/records?from=2025-11-01&to=2025-11-30', { token });
  assert.equal(wholeMonth.body.total, 1);
  assert.equal(wholeMonth.body.items[0].id, nov.id);

  /* ---- 修复后的正解：firstCursorInclusive + cursorInclusive=true ---- */
  assert.equal(novItem.firstCursorInclusive, novItem.firstCursor, '两者是同一串游标值');
  const incl = await call(
    app,
    `/v1/records?cursor=${encodeURIComponent(novItem.firstCursorInclusive)}&cursorInclusive=true`,
    { token },
  );
  const inclIds = incl.body.items.map((r: { id: string }) => r.id);
  assert.equal(inclIds.includes(nov.id), true, 'cursorInclusive=true 必须包含游标那条（当月最新）');
  assert.equal(inclIds[0], nov.id, '且必须排在第一位');
  assert.equal(inclIds.includes(oct.id), true, '更旧的记录也要在');
});

test('月份列表：每月 count 正确、firstCursor 指向该月最新一条', async (t) => {
  const { app, close } = await makeApp();
  t.after(close);
  const token = await login(app);

  const newest = await addRecord(app, token, { eat: 'zzz', at: at(2026, 10, 20) });
  await addRecord(app, token, { eat: 'aaa', at: at(2026, 10, 1) });
  await addRecord(app, token, { eat: 'sep', at: at(2026, 9, 5) });

  const res = await call(app, '/v1/records/months', { token });
  const oct = res.body.items.find((m: { month: string }) => m.month === '2026-10');
  assert.equal(oct.count, 2);

  const first = await call(app, `/v1/records?cursor=${encodeURIComponent(oct.firstCursor)}`, { token });
  const ids = first.body.items.map((r: { id: string }) => r.id);
  assert.equal(ids.includes(newest.id), false, 'firstCursor 是"最新一条"，严格 after 会跳过它');
  assert.deepEqual(
    res.body.items.map((m: { month: string }) => m.month),
    ['2026-10', '2026-09'],
    'month DESC',
  );
});

/**
 * 混合时区下的**当前行为**（钉住，不改语义）。
 *
 * ⚠ 这条测试记录的是**已知取舍**，不是「正确行为」：
 *
 *   排序用的是 `eatenAtUtc`（绝对时刻，跨时区绝对正确），
 *   分月用的是 `atLocal.slice(0,7)`（**记录地**的墙钟月）。
 *   两把时钟在混合时区下会打架：构造下面这两条 ——
 *
 *     X: atLocal = 2026-11-01T00:00, tz = +08:00 → UTC 2026-10-31T16:00Z（11 月）
 *     Y: atLocal = 2026-10-31T23:00, tz = -05:00 → UTC 2026-11-01T04:00Z（10 月）
 *
 *   - 列表按 instant 倒序 → **Y 在前**（Y 的真实时刻更晚）
 *   - 月份桶按墙钟月 → Y 落 2026-10，X 落 2026-11
 *   - /records/months 按月份键降序 → **2026-11 在前**
 *
 *   ⇒ 客户端 `layoutWall` 按「首次出现顺序」建组（= instant 序），
 *     墙上会出现「2026-10」排在「2026-11」**上面**，与月轴顺序相反。
 *
 * 为什么现在钉住而不修：改口径（客户端按月份键重排 / 服务端排序改用墙钟）
 * 会影响**已上线数据**的展示顺序，属于产品决策。先把行为写成测试，
 * 将来要改时能立刻看到影响面。
 *
 * 单时区用户永远看不到这个问题 —— 所以现有测试只覆盖了单时区边界
 * （见上面 AC-34 那条）。
 */
test('混合时区：排序按绝对时刻、分月按记录地墙钟（当前行为，钉住）', async (t) => {
  const { app, close } = await makeApp();
  t.after(close);
  const token = await login(app);

  /* ⚠ 日期取 2025 年：服务端会拒绝「未来 5 分钟以上」的时间，
     用 2026-11 会被 422「不能是未来时间」挡下来。 */
  // X：东八区的 11-01 00:00 → UTC 是 10-31 16:00
  const x = await addRecord(app, token, { eat: 'X 东八区', at: '2025-11-01T00:00', tzOffset: '+08:00' });
  // Y：美东的 10-31 23:00 → UTC 是 11-01 04:00（真实时刻更晚）
  const y = await addRecord(app, token, { eat: 'Y 美东', at: '2025-10-31T23:00', tzOffset: '-05:00' });

  /* 1. 列表按 UTC instant 倒序 → Y 在前 */
  const list = await call(app, '/v1/records', { token });
  assert.equal(list.body.items[0].id, y.id, '按绝对时刻排序，Y（UTC 更晚）应在最前');
  assert.equal(list.body.items[1].id, x.id);

  /* 2. 但月份桶按记录地墙钟月归 → Y 落 10 月、X 落 11 月 */
  const months = await call(app, '/v1/records/months', { token });
  const byMonth = new Map<string, number>(
    months.body.items.map((m: { month: string; count: number }) => [m.month, m.count]),
  );
  assert.equal(byMonth.get('2025-10'), 1, 'Y 的墙钟是 10-31 → 落 10 月');
  assert.equal(byMonth.get('2025-11'), 1, 'X 的墙钟是 11-01 → 落 11 月');

  /* 3. /records/months 按月份键降序 → 11 月在前（与列表顺序相反） */
  assert.deepEqual(
    months.body.items.map((m: { month: string }) => m.month),
    ['2025-11', '2025-10'],
    '月份列表按月份键降序 —— 与列表的 instant 序相反',
  );

  /* 4. tzOffset 存了但排序不用它 —— 记录上能查到各自的偏移 */
  assert.equal(list.body.items[0].tzOffset, '-05:00');
  assert.equal(list.body.items[1].tzOffset, '+08:00');
});

/**
 * from/to 筛选按**记录地墙钟日**（不是 UTC 日，也不是查询者的时区）。
 *
 * Y 的 atLocal 是 '2025-10-31T23:00'（美东），X 的是 '2025-11-01T00:00'（东八区）。
 * 按墙钟日筛：to=2025-10-31 只命中 Y；from=2025-11-01 只命中 X。
 * 注意 Y 的 UTC 时刻其实是 11-01 —— 若按 UTC 筛，结果会反过来。
 */
test('混合时区：from/to 按记录地墙钟日筛选（当前行为，钉住）', async (t) => {
  const { app, close } = await makeApp();
  t.after(close);
  const token = await login(app);

  const x = await addRecord(app, token, { eat: 'X 东八区', at: '2025-11-01T00:00', tzOffset: '+08:00' });
  const y = await addRecord(app, token, { eat: 'Y 美东', at: '2025-10-31T23:00', tzOffset: '-05:00' });

  const oct = await call(app, '/v1/records?from=2025-10-01&to=2025-10-31', { token });
  assert.deepEqual(
    oct.body.items.map((r: { id: string }) => r.id),
    [y.id],
    '按墙钟日筛，10 月只有 Y（尽管 Y 的 UTC 时刻在 11-01）',
  );

  const nov = await call(app, '/v1/records?from=2025-11-01&to=2025-11-30', { token });
  assert.deepEqual(
    nov.body.items.map((r: { id: string }) => r.id),
    [x.id],
    '按墙钟日筛，11 月只有 X',
  );
});
