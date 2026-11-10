/** 验收：照片 / 店铺 / 字典 / 运维 / 错误与限流（AC-25 ~ AC-33 等） */
import test from 'node:test';
import assert from 'node:assert/strict';
import { addRecord, call, formWithFile, garbagePng, login, makeApp, oversizedPng, tinyPng, truncatedPng } from './helpers.js';

const at = (y: number, m: number, d: number): string =>
  `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}T12:00`;

test('AC-25/26 照片上传：PNG 解析尺寸并可通过静态路径访问', async (t) => {
  const { app, close } = await makeApp();
  t.after(close);
  const token = await login(app);

  const res = await call(app, '/v1/photos', { method: 'POST', token, raw: formWithFile(tinyPng(4, 3)) });
  assert.equal(res.status, 201);
  const p = res.body;
  assert.match(p.photoId, /^pho_/);
  assert.equal(p.width, 4);
  assert.equal(p.height, 3);
  assert.equal(p.mime, 'image/png');
  /* size = 落库字节数，等于上传的那张真 PNG 的长度（不再写死假夹具的 24） */
  assert.equal(p.size, tinyPng(4, 3).length);
  assert.ok((p.size as number) > 24, '必须是结构完整的 PNG（含 IDAT/IEND）');
  assert.equal(p.status, 'approved');
  assert.match(p.url, /\/v1\/files\/pho_[A-Z0-9]+\.png$/);
  assert.equal(p.photo, p.url);
  assert.equal(p.photoThumb, p.url);

  const filePath = new URL(p.url).pathname; // http://localhost:8787/v1/files/x.png → /v1/files/x.png
  const file = await app.request(filePath);
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('Content-Type'), 'image/png');
  assert.match(file.headers.get('Cache-Control') ?? '', /immutable/);
});

test('AC-27 照片校验：gif/文本 → 415，超限 → 413', async (t) => {
  const { app, close } = await makeApp({ photoMaxBytes: 64 });
  t.after(close);
  const token = await login(app);

  const gif = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(20)]);
  const gifRes = await call(app, '/v1/photos', { method: 'POST', token, raw: formWithFile(gif, 'a.gif', 'image/gif') });
  assert.equal(gifRes.status, 415);
  assert.equal(gifRes.body.error.code, 'UNSUPPORTED_MEDIA_TYPE');

  const txt = Buffer.from('hello world, definitely not an image');
  const txtRes = await call(app, '/v1/photos', { method: 'POST', token, raw: formWithFile(txt, 'a.txt', 'text/plain') });
  assert.equal(txtRes.status, 415);

  const big = Buffer.concat([tinyPng(), Buffer.alloc(200)]);
  const bigRes = await call(app, '/v1/photos', { method: 'POST', token, raw: formWithFile(big) });
  assert.equal(bigRes.status, 413);
  assert.equal(bigRes.body.error.code, 'FILE_TOO_LARGE');

  // 缺少 file 字段
  const fd = new FormData();
  fd.append('scene', 'record');
  const missing = await call(app, '/v1/photos', { method: 'POST', token, raw: fd });
  assert.equal(missing.status, 422);
});

/**
 * 回归：结构损坏的"图片"必须被拒（历史 B1）。
 *
 * 以前 pngSize 只读偏移 16/20，所以「PNG 魔数 + 任意字节」都能通过并入库 ——
 * 实测 208 字节垃圾图返回 width=291307238 / height=1938908154，且以
 * `Cache-Control: immutable` 永久对外提供。这条测试锁死该行为。
 */
test('图片结构校验：半截 PNG / 魔数+垃圾 / 截断 JPEG 一律 422', async (t) => {
  const { app, close } = await makeApp();
  t.after(close);
  const token = await login(app);

  const cases: Array<[string, Buffer]> = [
    ['只有魔数+IHDR 头，无 IDAT/IEND', truncatedPng(4, 3)],
    ['PNG 魔数 + 随机字节', garbagePng(200)],
    ['PNG 头声明超大尺寸（伪造）', (() => {
      const b = truncatedPng(0, 0);
      b.writeUInt32BE(291307238, 16);
      b.writeUInt32BE(1938908154, 20);
      return b;
    })()],
    ['JPEG SOI + 垃圾（无 SOF）', Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
      Buffer.alloc(64, 0xab),
      Buffer.from([0xff, 0xd9]),
    ])],
  ];

  for (const [name, buf] of cases) {
    const res = await call(app, '/v1/photos', { method: 'POST', token, raw: formWithFile(buf) });
    assert.equal(res.status, 422, `应拒绝：${name}`);
    assert.equal(res.body.error.code, 'IMAGE_REJECTED', `错误码应为 IMAGE_REJECTED：${name}`);
  }
});

test('照片删除：被引用 409；删记录级联回收；未引用 204；他人 404', async (t) => {
  const { app, close } = await makeApp();
  t.after(close);
  const token = await login(app, 'owner');
  const other = await login(app, 'other');

  const uploaded = await call(app, '/v1/photos', { method: 'POST', token, raw: formWithFile(tinyPng()) });
  const photoId = uploaded.body.photoId as string;
  const rec = await addRecord(app, token, { eat: '带图', photoId });

  const inUse = await call(app, `/v1/photos/${photoId}`, { method: 'DELETE', token });
  assert.equal(inUse.status, 409);
  assert.equal(inUse.body.error.code, 'PHOTO_IN_USE');

  const others = await call(app, `/v1/photos/${photoId}`, { method: 'DELETE', token: other });
  assert.equal(others.status, 404);

  // 删记录时会级联把"不再被引用"的照片标记待回收（契约 §6.2.5）
  await call(app, `/v1/records/${rec.id}`, { method: 'DELETE', token });
  const cascaded = await call(app, `/v1/photos/${photoId}`, { method: 'DELETE', token });
  assert.equal(cascaded.status, 404, '级联后照片已不在，客户端不需要再调本接口');

  // 未被引用的照片可以直接删
  const loose = await call(app, '/v1/photos', { method: 'POST', token, raw: formWithFile(tinyPng()) });
  const ok = await call(app, `/v1/photos/${loose.body.photoId}`, { method: 'DELETE', token });
  assert.equal(ok.status, 204);
});

test('AC-28/29 店铺聚合：avgRating 只算已评、按店名/按 id 两种入口', async (t) => {
  const { app, close } = await makeApp();
  t.after(close);
  const token = await login(app);

  const high = await addRecord(app, token, {
    eat: '北京烤鸭',
    shop: '四季民福',
    city: '北京',
    rating: 5,
    at: at(2026, 10, 9),
  });
  await addRecord(app, token, {
    eat: '芥末鸭掌',
    shop: '四季民福',
    city: '北京',
    rating: 0, // 未评：不计入店铺均分
    at: at(2026, 9, 30),
  });
  assert.ok(high.shopId, '建记录时应回填 shopId');

  const byName = await call(app, `/v1/shops/by-name?name=${encodeURIComponent('四季民福')}`, { token });
  assert.equal(byName.status, 200);
  assert.equal(
    byName.body.shop.id,
    high.shopId,
    '/shops/by-name 必须命中路由，不能被 /shops/:shopId 吃掉',
  );
  assert.equal(byName.body.stats.visitCount, 2);
  assert.equal(byName.body.stats.ratedCount, 1);
  assert.equal(byName.body.stats.avgRating, 5, '店铺均分只算 rating>0');
  assert.equal(byName.body.stats.fiveCount, 1);
  assert.equal(byName.body.stats.dishCount, 2);
  assert.equal(byName.body.stats.cityCount, 1);
  assert.equal(byName.body.stats.lastAt, at(2026, 10, 9));
  assert.equal(byName.body.stats.firstAt, at(2026, 9, 30));
  assert.deepEqual(byName.body.shop.cities, ['北京']);
  assert.equal(byName.body.records.length, 2);
  assert.equal(byName.body.hasMore, false);
  assert.equal(byName.body.nextCursor, null);

  const byId = await call(app, `/v1/shops/${high.shopId}`, { token });
  assert.equal(byId.status, 200);
  assert.equal(byId.body.shop.name, '四季民福');
  assert.equal(byId.body.stats.visitCount, 2);
});

test('AC-28b 同名跨城：shop=null + candidates；带 city 可落定', async (t) => {
  const { app, close } = await makeApp();
  t.after(close);
  const token = await login(app);

  const bj = await addRecord(app, token, { eat: 'a', shop: '同名店', city: '北京', rating: 5 });
  const sh = await addRecord(app, token, { eat: 'b', shop: '同名店', city: '上海', rating: 4 });
  assert.notEqual(bj.shopId, sh.shopId, '同名跨城应是两家店');

  const ambiguous = await call(app, `/v1/shops/by-name?name=${encodeURIComponent('同名店')}`, { token });
  assert.equal(ambiguous.body.shop, null);
  assert.equal(ambiguous.body.candidates.length, 2);
  assert.equal(ambiguous.body.stats.visitCount, 2, '聚合口径 = 所有同名店记录合并');

  const resolved = await call(
    app,
    `/v1/shops/by-name?name=${encodeURIComponent('同名店')}&city=${encodeURIComponent('上海')}`,
    { token },
  );
  assert.equal(resolved.body.shop.id, sh.shopId);
  assert.equal(resolved.body.stats.visitCount, 1);
});

test('店铺越权/不存在 → 404', async (t) => {
  const { app, close } = await makeApp();
  t.after(close);
  const token = await login(app, 'a');
  const other = await login(app, 'b');

  const rec = await addRecord(app, token, { eat: 'x', shop: '店', city: '成都' });
  const mine = await call(app, `/v1/shops/${rec.shopId}`, { token });
  assert.equal(mine.status, 200);

  const others = await call(app, `/v1/shops/${rec.shopId}`, { token: other });
  assert.equal(others.status, 404);

  const missing = await call(app, '/v1/shops/shp_nope', { token });
  assert.equal(missing.status, 404);

  const noShop = await call(app, `/v1/shops/by-name?name=${encodeURIComponent('不存在的店')}`, { token });
  assert.equal(noShop.status, 404);
});

test('AC-30/31 城市字典：208 城 / 34 省、码点序、免鉴权', async (t) => {
  const { app, close } = await makeApp();
  t.after(close);

  const res = await call(app, '/v1/geo/cities'); // 不带 token
  assert.equal(res.status, 200);
  assert.equal(res.body.provinces.length, 34);

  const cities = res.body.provinces.flatMap((p: { cities: string[] }) => p.cities);
  assert.equal(cities.length, 208);
  assert.ok(res.body.version);

  // 省按码点序；省内城市也按码点序
  const names = res.body.provinces.map((p: { province: string }) => p.province);
  assert.deepEqual(names, [...names].sort());

  const beijing = res.body.provinces.find((p: { province: string }) => p.province === '北京');
  assert.deepEqual(beijing.cities, ['北京'], '直辖市只有一个城市');

  const jx = res.body.provinces.find((p: { province: string }) => p.province === '江西');
  assert.ok(jx.cities.includes('景德镇'), '景德镇在字典内，属江西');
});

test('AC-32 字典 ETag → 304', async (t) => {
  const { app, close } = await makeApp();
  t.after(close);

  const first = await call(app, '/v1/geo/cities');
  const etag = first.headers.get('ETag');
  assert.ok(etag, '必须下发 ETag');

  const cached = await app.request('/v1/geo/cities', { headers: { 'If-None-Match': etag } });
  assert.equal(cached.status, 304);
  assert.equal((await cached.text()).length, 0);
});

test('AC-33 健康检查：免鉴权、返回 version/time', async (t) => {
  const { app, close } = await makeApp();
  t.after(close);

  for (const path of ['/v1/healthz', '/healthz']) {
    const res = await call(app, path);
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'ok');
    assert.ok(res.body.version);
    assert.match(res.body.time, /Z$/);
  }
});

test('GET /me：记录数 / 照片数 / 最近一条时间', async (t) => {
  const { app, close } = await makeApp();
  t.after(close);
  const token = await login(app);

  const empty = await call(app, '/v1/me', { token });
  assert.equal(empty.status, 200);
  assert.equal(empty.body.recordCount, 0);
  assert.equal(empty.body.photoCount, 0);
  assert.equal(empty.body.lastRecordAt, null);

  await addRecord(app, token, { eat: 'a', at: at(2026, 9, 1) });
  await addRecord(app, token, { eat: 'b', at: at(2026, 9, 5) });
  await call(app, '/v1/photos', { method: 'POST', token, raw: formWithFile(tinyPng()) });

  const me = await call(app, '/v1/me', { token });
  assert.equal(me.body.recordCount, 2);
  assert.equal(me.body.photoCount, 1);
  assert.equal(me.body.lastRecordAt, at(2026, 9, 5));
});

test('错误体统一：code/message/requestId；未知路由 404', async (t) => {
  const { app, close } = await makeApp();
  t.after(close);

  const notFound = await call(app, '/v1/nope');
  assert.equal(notFound.status, 404);
  assert.equal(notFound.body.error.code, 'NOT_FOUND');
  assert.ok(notFound.body.error.requestId);

  const token = await login(app);
  const echoed = await call(app, '/v1/records', {
    token,
    headers: { 'X-Request-Id': 'my-trace-1' },
  });
  assert.equal(echoed.body.items.length, 0);
  assert.equal(echoed.headers.get('X-Request-Id'), 'my-trace-1', '应回显请求 ID');

  // 非 JSON body
  const badJson = await app.request('/v1/records', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: '{oops',
  });
  assert.equal(badJson.status, 400);
  const body = (await badJson.json()) as { error: { code: string } };
  assert.equal(body.error.code, 'BAD_REQUEST');
});

test('限流：超过阈值 → 429 + Retry-After', async (t) => {
  const { app, close } = await makeApp({
    rateLimit: { enabled: true, authPerMin: 2, defaultPerMin: 1000, photoPerMin: 1000 },
  });
  t.after(close);

  const one = await call(app, '/v1/auth/anonymous', { method: 'POST', body: { deviceId: 'rl' } });
  const two = await call(app, '/v1/auth/anonymous', { method: 'POST', body: { deviceId: 'rl' } });
  assert.equal(one.status, 200);
  assert.equal(two.status, 200);

  const three = await call(app, '/v1/auth/anonymous', { method: 'POST', body: { deviceId: 'rl' } });
  assert.equal(three.status, 429);
  assert.equal(three.body.error.code, 'RATE_LIMITED');
  assert.ok(Number(three.headers.get('Retry-After')) >= 1);
});

test('种子数据（SEED_DEMO_RECORDS）：新用户拿到 12 条且口径与前端一致', async (t) => {
  const { app, close } = await makeApp({ seedDemoRecords: true });
  t.after(close);

  const res = await call(app, '/v1/auth/wechat/login', { method: 'POST', body: { code: 'seed' } });
  assert.equal(res.body.user.recordCount, 12, '前端预置 12 条');

  const token = res.body.accessToken as string;
  const stats = await call(app, '/v1/stats', { token });
  // 前端 REAL_RECORDS 基线：评分和 53 → avgRating=53/12≈4.42；五分 7；城市 7；店铺 10
  assert.equal(stats.body.total, 12);
  assert.equal(stats.body.fiveCount, 7);
  assert.equal(stats.body.cities, 7);
  assert.equal(stats.body.shops, 10);
  assert.equal(stats.body.avgRating, 4.42);
  assert.deepEqual(stats.body.repeated, [], '预置数据没有重复菜名');

  const cities = await call(app, '/v1/records/cities', { token });
  assert.equal(cities.body.total, 12);
  assert.equal(cities.body.uncityCount, 1);
});

/**
 * 种子数据的**时间**必须相对 now，不能是硬编码的旧日期。
 *
 * ⚠ 以前 `atLocal: seed.at` 直接抄预置数据里那个 '2026-10-09T12:30'，
 * 于是用户今天注册看到的是「刚创建却标着半年前」的记录 —— 随时间推移
 * 这个日期越来越不像真的。所以现在种子日期要搬到「最近」。
 *
 * 同时 tzOffset 必须是**用户自己的**（登录请求头带过来的），
 * 否则非东八区的用户看到的月份归属是错的。
 */
test('种子数据：日期相对 now 生成 + 用用户自己的时区', async (t) => {
  const { app, close } = await makeApp({ seedDemoRecords: true });
  t.after(close);

  /* 用一个非东八区的偏移登录（-05:00），验证 tzOffset 被采纳 */
  const res = await call(app, '/v1/auth/wechat/login', {
    method: 'POST',
    body: { code: 'seed-tz' },
    headers: { 'X-Timezone-Offset': '-05:00' },
  });
  assert.equal(res.status, 200);
  const token = res.body.accessToken as string;

  /* ⚠ 列表默认 limit=10，12 条种子要显式放大 limit 才能拿全 */
  const list = await call(app, '/v1/records?limit=50', { token });
  assert.equal(list.body.items.length, 12);

  const today = new Date();
  const todayY = today.getFullYear();
  const todayM = today.getMonth() + 1;

  for (const r of list.body.items) {
    /* 1. tzOffset 用的是用户自己的 */
    assert.equal(r.tzOffset, '-05:00', '种子数据要用用户自己的时区，不是服务端默认 +08:00');

    /* 2. 日期不晚于今天（不能出现未来）。⚠ 先切掉 'T…时刻' 再按 '-' 拆 */
    const [dateOnly] = r.at.split('T');
    const [y, m, d] = dateOnly.split('-').map(Number);
    assert.ok(
      y < todayY || (y === todayY && (m < todayM || (m === todayM && d <= today.getDate()))),
      `种子记录 ${r.eat} 的日期在未来：${r.at}`,
    );

    /* 3. 日期在「最近一年内」—— 不能是硬编码的老日期 */
    const ageDays = (today.getTime() - new Date(y, m - 1, d).getTime()) / 86_400_000;
    assert.ok(ageDays >= 0, `种子记录 ${r.eat} 的日期在未来：${r.at}`);
    assert.ok(ageDays < 400, `种子记录 ${r.eat} 的日期太旧（${Math.round(ageDays)} 天前），应是相对 now 生成的`);
  }

  /* 4. 时刻保留种子原值（早餐/午餐/夜宵的搭配是有意义的） */
  const times = list.body.items.map((r: { at: string }) => r.at.split('T')[1]);
  assert.ok(times.includes('12:30'), `应保留种子的时刻，实际：${times.join(',')}`);
});

/**
 * 软删回收（维护任务）：过了保留期的软删记录 + 孤儿照片应被物理删除。
 *
 * 为什么需要：删除是软删（支持 5 秒撤销 / 30 天恢复），但不回收的话
 * 记录表与上传目录只增不减。这条测试锁死"回收确实发生、且不误删"。
 */
test('回收：过期软删记录被清理，保留期内不动，被引用的照片不删', async (t) => {
  const { app, close, services } = await makeApp();
  t.after(close);
  const token = await login(app);

  /* 造三条：A 正常、B 删除（保留期内）、C 删除（超期） */
  const a = await addRecord(app, token, { eat: '正常记录' });
  const b = await addRecord(app, token, { eat: '刚删除' });
  const c = await addRecord(app, token, { eat: '早就删了' });

  await call(app, `/v1/records/${b.id}`, { method: 'DELETE', token });
  await call(app, `/v1/records/${c.id}`, { method: 'DELETE', token });

  /* 把 C 的 deletedAt 改成 100 天前（模拟超期）。
     store 是内存实现，直接改行对象即可（测试里允许这么做）。 */
  const rowC = services.store.getRecord(c.id);
  assert.ok(rowC);
  rowC.deletedAt = Date.now() - 100 * 86_400_000;
  services.store.updateRecord(rowC);

  /* 保留期 30 天：只有 C 该被删 */
  const r1 = services.store.purgeSoftDeleted(30);
  assert.equal(r1.records, 1, '只应清理超期的那条');
  assert.equal(services.store.getRecord(c.id), undefined, 'C 应被物理删除');
  assert.ok(services.store.getRecord(b.id), 'B 在保留期内必须还在');
  assert.ok(services.store.getRecord(a.id), '正常记录不能动');

  /* 再用 0 天保留期跑一次：B 也应被清掉 */
  const r2 = services.store.purgeSoftDeleted(0);
  assert.equal(r2.records, 1, 'B 也应被清理');
  assert.equal(services.store.getRecord(b.id), undefined);
  assert.ok(services.store.getRecord(a.id), '正常记录仍然不能动');
});

test('回收：照片只有"已软删且无未删除记录引用"才被清理', async (t) => {
  const { app, close, services } = await makeApp();
  t.after(close);
  const token = await login(app);

  /* 上传两张照片 */
  const p1 = await call(app, '/v1/photos', {
    method: 'POST',
    token,
    raw: formWithFile(tinyPng(4, 3)),
  });
  const p2 = await call(app, '/v1/photos', {
    method: 'POST',
    token,
    raw: formWithFile(tinyPng(5, 4)),
  });
  assert.equal(p1.status, 201);
  assert.equal(p2.status, 201);

  /* p1 被一条**正常**记录引用；p2 被一条记录引用后该记录被删 */
  await addRecord(app, token, { eat: '引用 p1', photoId: p1.body.photoId });
  const rec2 = await addRecord(app, token, { eat: '引用 p2', photoId: p2.body.photoId });
  await call(app, `/v1/records/${rec2.id}`, { method: 'DELETE', token });

  /* 记录被删时照片已被标记软删（见 remove 的级联逻辑） */
  const photo2 = services.store.getPhoto(p2.body.photoId);
  assert.ok(photo2);
  assert.notEqual(photo2.deletedAt, null, 'p2 应已被标记软删');

  const r = services.store.purgeSoftDeleted(30);

  /* p1 仍被正常记录引用 → 不能删；p2 无引用 → 删 */
  assert.ok(services.store.getPhoto(p1.body.photoId), '被引用的照片不能删');
  assert.equal(services.store.getPhoto(p2.body.photoId), undefined, '孤儿照片应被清理');
  assert.equal(r.photos, 1);
});

/**
 * 回归：伪造 `X-Forwarded-For` 不能绕过限流（安全漏洞）。
 *
 * 历史问题：key 取自 `X-Forwarded-For` 的**最左**一段（客户端可随意编造），
 * 直连部署下每次换一个假 IP 就完全绕过 —— 实测修复前 30 次全部通过。
 * 这比"没有限流"更糟：看起来有限流，日志里却一切正常。
 *
 * 现在的策略：
 *   · trustProxy=false（默认）→ 用 TCP 对端地址，伪造头完全无效；
 *   · trustProxy=true → 取**最右一跳**（可信代理追加的那一条）。
 */
test('限流：伪造 X-Forwarded-For 不能绕过（trustProxy=false）', async (t) => {
  const { app, close } = await makeApp({
    rateLimit: { enabled: true, authPerMin: 3, defaultPerMin: 1000, photoPerMin: 1000 },
    trustProxy: false,
  });
  t.after(close);

  /* 每次都换一个假 IP，模拟攻击者。app.request() 没有真实 socket，
     所有请求落到同一个不可伪造的桶（'unknown'），所以仍应被限流。 */
  const results: number[] = [];
  for (let i = 0; i < 8; i++) {
    const res = await call(app, '/v1/auth/anonymous', {
      method: 'POST',
      headers: { 'X-Forwarded-For': `9.9.9.${i}` },
      body: { deviceId: `spoof-${i}` },
    });
    results.push(res.status);
  }

  const ok = results.filter((s) => s === 200).length;
  const limited = results.filter((s) => s === 429).length;
  assert.equal(ok, 3, `只应放行 3 次（限额 3），实际 ${ok}`);
  assert.equal(limited, 5, `其余应全部 429，实际 ${limited}`);
});

test('限流：trustProxy=true 时按最右一跳分组，伪造最左段无效', async (t) => {
  const { app, close } = await makeApp({
    rateLimit: { enabled: true, authPerMin: 2, defaultPerMin: 1000, photoPerMin: 1000 },
    trustProxy: true,
  });
  t.after(close);

  /* 客户端 A：最左段是伪造的 8.8.8.8，最右 1.1.1.1 才是代理写的真实地址 */
  const a = async () =>
    call(app, '/v1/auth/anonymous', {
      method: 'POST',
      headers: { 'X-Forwarded-For': '8.8.8.8, 1.1.1.1' },
      body: { deviceId: `a-${Math.random()}` },
    });
  /* 客户端 B：换一个真实地址，但伪造段相同 */
  const b = async () =>
    call(app, '/v1/auth/anonymous', {
      method: 'POST',
      headers: { 'X-Forwarded-For': '8.8.8.8, 2.2.2.2' },
      body: { deviceId: `b-${Math.random()}` },
    });

  assert.equal((await a()).status, 200);
  assert.equal((await a()).status, 200);
  /* A 第 3 次应被限（限额 2） */
  assert.equal((await a()).status, 429, 'A 超限');

  /* B 是另一个真实 IP，不应被 A 拖累 —— 证明分组依据是最右跳 */
  assert.equal((await b()).status, 200, 'B 不受 A 影响');
});

/**
 * 内容安全：开启审核后，**超过 1MB 的图必须被拒绝**（不能放行绕过）。
 *
 * 背景（易被误解的一点）：微信同步接口 `wxa/img_sec_check` 上限 1MB。
 * 另外有一个异步版 `media_check_async` 支持更大文件，但它靠**回调**返回结果，
 * 需要额外的公网回调端点 + 验签 + 状态机。
 *
 * 我们没用异步版，理由是本产品前端上传前已 `compressImage(quality:72)`
 * （手机原图 2~8MB → 典型 200~600KB），1MB 边界极少触发；为一个低概率边界
 * 引入整套回调编排不划算。**但超限时必须拒绝**——放行等于大图可完全绕过审核。
 *
 * 这条测试不需要真调微信：超限分支在调接口**之前**就返回了。
 */
test('内容安全：开启审核时 >1MB 直接拒绝（不调微信、不放行）', async (t) => {
  /* 只开开关、不给微信凭据 —— usable 要求 enabled && appId && secret，
     所以这里必须给假凭据才会走到大小检查分支。 */
  const { app, close } = await makeApp({
    imageCheck: { enabled: true },
    wechat: { appId: 'fake-appid', secret: 'fake-secret' },
  });
  t.after(close);
  const token = await login(app);

  /* 构造一张**结构合法**、体积 >1MB 的 PNG（见 helpers 里的 oversizedPng）。
     ⚠ 不能用「合法小图 + 补零」凑大小：那样会在图片结构校验阶段就以
     "无法解析"被拒（也是 422），测的根本不是大小限制。 */
  const big = oversizedPng();
  assert.ok(big.length > 1024 * 1024, `夹具必须真超 1MB，实际 ${big.length}`);

  const res = await call(app, '/v1/photos', {
    method: 'POST',
    token,
    raw: formWithFile(big),
  });

  assert.equal(res.status, 422, '超 1MB 应被拒（不能放行绕过审核）');
  assert.equal(res.body.error.code, 'IMAGE_REJECTED');
  /* 断言**具体原因**，而不是宽松匹配「压缩」二字 ——
     要能区分"超限"与"结构损坏"两种不同的拒绝。 */
  assert.match(
    String(res.body.error.message),
    /1024KB/,
    `拒绝原因应是超限，实际：${res.body.error.message}`,
  );
});
