/** 验收：列表 / 分页 / 创建 / 编辑 / 删除（AC-05 ~ AC-20、AC-35） */
import test from 'node:test';
import assert from 'node:assert/strict';
import { addRecord, call, formWithFile, login, makeApp, tinyPng } from './helpers.js';
import { localToUtcMs, parseAtLocal } from '../src/lib/time.js';
import { FIELD_LIMITS } from '../src/lib/constants.js';
import type { MemoryStore } from '../src/store/memory.js';

const at = (y: number, m: number, d: number, hh = 12, mm = 0): string =>
  `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;

test('AC-05/AC-06 分页不重不漏：25 条翻 3 页', async (t) => {
  const { app, close } = await makeApp();
  t.after(close);
  const token = await login(app);

  for (let i = 0; i < 25; i++) {
    await addRecord(app, token, { eat: `菜${i}`, at: at(2026, 9, 1 + i) });
  }

  const seen: string[] = [];
  let cursor: string | null = null;
  const pages: number[] = [];
  for (let page = 0; page < 3; page++) {
    const qs: string = cursor ? `?limit=10&cursor=${encodeURIComponent(cursor)}` : '?limit=10';
    const res = await call(app, `/v1/records${qs}`, { token });
    assert.equal(res.status, 200);
    pages.push(res.body.items.length);
    seen.push(...res.body.items.map((r: { id: string }) => r.id));
    cursor = res.body.nextCursor;
    if (page < 2) assert.equal(res.body.hasMore, true);
    else assert.equal(res.body.hasMore, false);
  }

  assert.deepEqual(pages, [10, 10, 5]);
  assert.equal(new Set(seen).size, 25, '三页 id 必须无重复');
  assert.equal(seen.length, 25, '三页合计 25 条，无遗漏');

  // 严格 at 倒序
  const all = await call(app, '/v1/records?limit=50', { token });
  const ats = all.body.items.map((r: { at: string }) => r.at);
  const sorted = [...ats].sort().reverse();
  assert.deepEqual(ats, sorted);
});

test('AC-07 同分钟多条：靠 id 兜底，不重不漏', async (t) => {
  const { app, close } = await makeApp();
  t.after(close);
  const token = await login(app);

  const stamp = at(2026, 10, 9, 12, 30);
  for (let i = 0; i < 3; i++) await addRecord(app, token, { eat: `同分钟${i}`, at: stamp });

  const p1 = await call(app, '/v1/records?limit=2', { token });
  assert.equal(p1.body.items.length, 2);
  assert.equal(p1.body.hasMore, true);
  const p2 = await call(app, `/v1/records?limit=2&cursor=${encodeURIComponent(p1.body.nextCursor)}`, { token });
  assert.equal(p2.body.items.length, 1);
  assert.equal(p2.body.hasMore, false);

  const ids = [...p1.body.items, ...p2.body.items].map((r: { id: string }) => r.id);
  assert.equal(new Set(ids).size, 3);
});

test('AC-08 翻页期间新增记录不影响旧游标', async (t) => {
  const { app, close } = await makeApp();
  t.after(close);
  const token = await login(app);

  for (let i = 0; i < 12; i++) await addRecord(app, token, { eat: `旧${i}`, at: at(2026, 8, 1 + i) });

  const p1 = await call(app, '/v1/records?limit=10', { token });
  const cursor = p1.body.nextCursor as string;
  const fresh = await addRecord(app, token, { eat: '刚贴的', at: at(2026, 10, 20) });

  const p2 = await call(app, `/v1/records?limit=10&cursor=${encodeURIComponent(cursor)}`, { token });
  const p2ids = p2.body.items.map((r: { id: string }) => r.id);
  assert.equal(p2ids.includes(fresh.id), false, '新记录不应出现在旧游标的结果里');
  assert.equal(new Set([...p1.body.items.map((r: { id: string }) => r.id), ...p2ids]).size, 12);
});

test('AC-09 非法游标 / 越界 limit → 400 BAD_REQUEST', async (t) => {
  const { app, close } = await makeApp();
  t.after(close);
  const token = await login(app);

  for (const qs of ['?cursor=not-base64', '?limit=0', '?limit=51', '?limit=abc']) {
    const res = await call(app, `/v1/records${qs}`, { token });
    assert.equal(res.status, 400, `${qs} 应该 400`);
    assert.equal(res.body.error.code, 'BAD_REQUEST');
  }
});

test('AC-10 城市筛选三种语义 + 互斥 400', async (t) => {
  const { app, close } = await makeApp();
  t.after(close);
  const token = await login(app);

  await addRecord(app, token, { eat: 'a', city: '成都', at: at(2026, 9, 1) });
  await addRecord(app, token, { eat: 'b', city: '乐山', at: at(2026, 9, 2) });
  await addRecord(app, token, { eat: 'c', city: null, at: at(2026, 9, 3) });

  const all = await call(app, '/v1/records?limit=50', { token });
  assert.equal(all.body.total, 3);

  const chengdu = await call(app, '/v1/records?city=%E6%88%90%E9%83%BD', { token });
  assert.equal(chengdu.body.total, 1);
  assert.equal(chengdu.body.items[0].city, '成都');

  const missing = await call(app, '/v1/records?cityMissing=true', { token });
  assert.equal(missing.body.total, 1);
  assert.equal(missing.body.items[0].city, null);

  const both = await call(app, '/v1/records?city=%E6%88%90%E9%83%BD&cityMissing=true', { token });
  assert.equal(both.status, 400);
});

test('AC-11/AC-13 最小创建默认值 + 空串归一 null', async (t) => {
  const { app, close } = await makeApp();
  t.after(close);
  const token = await login(app);

  const res = await call(app, '/v1/records', { method: 'POST', token, body: { eat: '甜水面' } });
  assert.equal(res.status, 201);
  const r = res.body;
  assert.match(r.id, /^rec_/);
  assert.equal(/^g/.test(r.id) && r.id.includes('_'), false, 'id 不能是 g..._ 形态');
  assert.equal(r.rating, 0);
  assert.equal(r.shop, null);
  assert.equal(r.city, null);
  assert.equal(r.note, null);
  assert.equal(r.photo, null);
  assert.equal(r.photoId, null);
  assert.equal(r.version, 1);
  assert.match(r.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  assert.match(r.eatenAtUtc, /Z$/);

  const normalized = await call(app, '/v1/records', {
    method: 'POST',
    token,
    body: { eat: '冰粉', shop: '', city: '', note: '', district: '' },
  });
  assert.equal(normalized.status, 201);
  for (const k of ['shop', 'city', 'note', 'district']) {
    assert.equal(normalized.body[k], null, `${k} 空串应归一为 null`);
  }
});

test('AC-12/AC-14 校验：eat 必填、rating 边界、类型严格', async (t) => {
  const { app, close } = await makeApp();
  t.after(close);
  const token = await login(app);

  for (const body of [{}, { eat: '' }, { eat: '   ' }, { eat: 'x'.repeat(61) }]) {
    const res = await call(app, '/v1/records', { method: 'POST', token, body });
    assert.equal(res.status, 422, JSON.stringify(body));
    assert.equal(res.body.error.code, 'VALIDATION_FAILED');
    assert.ok(res.body.error.fields.eat, '应有 fields.eat');
  }

  for (const rating of [-1, 6, 2.5, '3']) {
    const res = await call(app, '/v1/records', { method: 'POST', token, body: { eat: 'x', rating } });
    assert.equal(res.status, 422, `rating=${rating} 应该 422`);
    assert.ok(res.body.error.fields.rating);
  }
});

/**
 * 字段长度上限：POST 与 PATCH 的判定口径必须一致，且都等于共享常量。
 *
 * 为什么单独立一条：以前这些数字散在 zod 里（60/80/40/200），
 * 前端另有一份（框架默认 140），两边漂移的后果是「用户能输入、
 * 能提交，然后被服务端 422 拒掉，前端只显示『字段校验失败』」。
 * 现在两边都引用各自的 FIELD_LIMITS，这条测试把服务端这侧钉住。
 */
test('字段长度上限：等于上限通过、超一个字符 422 且 fields 指名', async (t) => {
  const { app, close } = await makeApp();
  t.after(close);
  const token = await login(app);

  const cases: Array<[keyof typeof FIELD_LIMITS, string]> = [
    ['eat', '甜'],
    ['shop', '店'],
    ['city', '城'],
    ['district', '区'],
    ['note', '备'],
  ];

  for (const [field, ch] of cases) {
    const max = FIELD_LIMITS[field];

    /* 正好等于上限 → 通过 */
    const ok = await call(app, '/v1/records', {
      method: 'POST',
      token,
      body: { eat: '甜水面', [field]: ch.repeat(max) },
    });
    assert.equal(ok.status, 201, `${field} 长度 ${max} 应该通过`);

    /* 超一个字符 → 422，且 fields 指名这个字段 */
    const bad = await call(app, '/v1/records', {
      method: 'POST',
      token,
      body: { eat: '甜水面', [field]: ch.repeat(max + 1) },
    });
    assert.equal(bad.status, 422, `${field} 长度 ${max + 1} 应该 422`);
    assert.equal(bad.body.error.code, 'VALIDATION_FAILED');
    assert.ok(bad.body.error.fields[field], `应有 fields.${field}`);

    /* PATCH 同样口径 */
    const patchBad = await call(app, `/v1/records/${ok.body.id}`, {
      method: 'PATCH',
      token,
      body: { [field]: ch.repeat(max + 1) },
    });
    assert.equal(patchBad.status, 422, `PATCH ${field} 超长应该 422`);
    assert.ok(patchBad.body.error.fields[field], `PATCH 应有 fields.${field}`);
  }
});

/**
 * 首尾空白不占额度（POST 口径）。
 *
 * 前后端必须一致：前端用 `overLength`（trim 后判）做即时提示，
 * 服务端用 nullableText（trim 后判）。如果前端按原始长度判，
 * 用户会看到「超长了」的提示，而服务端其实会接受 —— 白紧张一次。
 */
test('字段长度上限：首尾空白不算超长（POST）', async (t) => {
  const { app, close } = await makeApp();
  t.after(close);
  const token = await login(app);

  const res = await call(app, '/v1/records', {
    method: 'POST',
    token,
    body: { eat: '甜水面', shop: `  ${'店'.repeat(FIELD_LIMITS.shop)}  ` },
  });
  assert.equal(res.status, 201, '带首尾空白的 80 字店名应该通过');
  assert.equal(res.body.shop.length, FIELD_LIMITS.shop, '存进去的应该是 trim 后的值');
});

/**
 * POST 与 PATCH 的长度口径必须一致。
 *
 * 以前 PATCH 用 `z.string().max(80)`（trim **前**判），POST 用
 * nullableText（trim **后**判）—— 于是「80 个字 + 两个尾随空格」
 * 在 POST 能过、在 PATCH 却 422，而服务端存进去的其实是 trim 后的
 * 80 个字。同一份内容，改一次就报错。
 */
test('字段长度上限：POST 与 PATCH 口径一致（带首尾空白都通过）', async (t) => {
  const { app, close } = await makeApp();
  t.after(close);
  const token = await login(app);

  const created = await call(app, '/v1/records', { method: 'POST', token, body: { eat: '甜水面' } });
  assert.equal(created.status, 201);

  const padded = `  ${'店'.repeat(FIELD_LIMITS.shop)}  `;
  const patched = await call(app, `/v1/records/${created.body.id}`, {
    method: 'PATCH',
    token,
    body: { shop: padded },
  });
  assert.equal(patched.status, 200, 'PATCH 也要按 trim 后的长度判');
  assert.equal(patched.body.shop.length, FIELD_LIMITS.shop);
});

/**
 * PATCH 的显式 null 仍然表示「清空」（不能被 trim 逻辑吃掉）。
 */
test('PATCH：显式 null 清空字段，空串归一为 null', async (t) => {
  const { app, close } = await makeApp();
  t.after(close);
  const token = await login(app);

  const created = await call(app, '/v1/records', {
    method: 'POST',
    token,
    body: { eat: '甜水面', shop: '马旺子川小馆', note: '好吃' },
  });
  assert.equal(created.status, 201);

  const cleared = await call(app, `/v1/records/${created.body.id}`, {
    method: 'PATCH',
    token,
    body: { shop: null, note: '   ' },
  });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.shop, null, '显式 null 应清空店名');
  assert.equal(cleared.body.note, null, '纯空白应归一为 null');
});

test('AC-15 时间：默认当前 / 指定保留 / 未来与坏格式 422', async (t) => {
  const { app, close } = await makeApp();
  t.after(close);
  const token = await login(app);

  const nowRes = await call(app, '/v1/records', { method: 'POST', token, body: { eat: 'now' } });
  const parts = parseAtLocal(nowRes.body.at);
  assert.ok(parts, 'at 必须是 YYYY-MM-DDTHH:mm');
  const tzMin = 8 * 60;
  const utc = localToUtcMs(parts!, tzMin);
  assert.ok(Math.abs(utc - Date.now()) < 120_000, '默认 at 应接近当前时间');

  const fixed = await call(app, '/v1/records', {
    method: 'POST',
    token,
    body: { eat: '补记', at: '2026-01-02T03:04' },
  });
  assert.equal(fixed.status, 201);
  assert.equal(fixed.body.at, '2026-01-02T03:04');

  const future = await call(app, '/v1/records', {
    method: 'POST',
    token,
    body: { eat: '未来', at: '2030-01-01T00:00' },
  });
  assert.equal(future.status, 422);
  assert.ok(future.body.error.fields.at);

  for (const bad of ['2026/01/02 03:04', '2026-01-02T03:04:05', '2026-01-02T03:04Z', '2026-02-30T10:00']) {
    const res = await call(app, '/v1/records', { method: 'POST', token, body: { eat: 'x', at: bad } });
    assert.equal(res.status, 422, `${bad} 应该 422`);
  }
});

test('AC-16 创建幂等：同 Idempotency-Key 只落一条', async (t) => {
  const { app, close } = await makeApp({ seedDemoRecords: false });
  t.after(close);
  const token = await login(app);

  const headers = { 'Idempotency-Key': 'k1' };
  const first = await call(app, '/v1/records', {
    method: 'POST',
    token,
    headers,
    body: { eat: '甜水面' },
  });
  assert.equal(first.status, 201);
  assert.equal(first.headers.get('Idempotent-Replayed'), null);

  const second = await call(app, '/v1/records', {
    method: 'POST',
    token,
    headers,
    body: { eat: '甜水面' },
  });
  assert.equal(second.status, 201);
  assert.equal(second.headers.get('Idempotent-Replayed'), 'true');
  assert.equal(second.body.id, first.body.id);

  const list = await call(app, '/v1/records', { token });
  assert.equal(list.body.total, 1);
});

test('AC-17 局部更新：只改出现的字段，version+1', async (t) => {
  const { app, close } = await makeApp();
  t.after(close);
  const token = await login(app);

  const created = await addRecord(app, token, {
    eat: '甜水面',
    rating: 5,
    note: 'x',
    at: '2026-10-09T12:30',
  });
  const res = await call(app, `/v1/records/${created.id}`, {
    method: 'PATCH',
    token,
    body: { note: null, rating: 4 },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.note, null);
  assert.equal(res.body.rating, 4);
  assert.equal(res.body.eat, '甜水面');
  assert.equal(res.body.at, '2026-10-09T12:30');
  assert.equal(res.body.createdAt, created.createdAt);
  assert.equal(res.body.version, 2);
  assert.notEqual(res.body.updatedAt, created.updatedAt);

  // If-Match 冲突 → 409
  const conflict = await call(app, `/v1/records/${created.id}`, {
    method: 'PATCH',
    token,
    headers: { 'If-Match': '1' },
    body: { rating: 3 },
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error.code, 'CONFLICT');

  const ok = await call(app, `/v1/records/${created.id}`, {
    method: 'PATCH',
    token,
    headers: { 'If-Match': '2' },
    body: { rating: 3 },
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.version, 3);
});

test('AC-18/AC-19 照片关联与不存在的记录', async (t) => {
  const { app, close } = await makeApp();
  t.after(close);
  const token = await login(app);

  const photoRes = await call(app, '/v1/photos', {
    method: 'POST',
    token,
    raw: formWithFile(tinyPng()),
  });
  assert.equal(photoRes.status, 201);
  const photoId = photoRes.body.photoId as string;

  const created = await addRecord(app, token, { eat: '带图', photoId });
  assert.equal(created.photoId, photoId);
  assert.equal(created.photo, photoRes.body.photo);

  const cleared = await call(app, `/v1/records/${created.id}`, {
    method: 'PATCH',
    token,
    body: { photoId: null },
  });
  assert.equal(cleared.body.photoId, null);
  assert.equal(cleared.body.photo, null);

  const badPhoto = await call(app, `/v1/records/${created.id}`, {
    method: 'PATCH',
    token,
    body: { photoId: 'pho_nope' },
  });
  assert.equal(badPhoto.status, 422);
  assert.ok(badPhoto.body.error.fields.photoId);

  const notFound = await call(app, '/v1/records/rec_nope', { method: 'PATCH', token, body: { note: 'x' } });
  assert.equal(notFound.status, 404);
});

test('AC-20 删除：204 幂等 + 列表/计数/统计同步减一', async (t) => {
  const { app, close } = await makeApp();
  t.after(close);
  const token = await login(app);

  const keep = await addRecord(app, token, { eat: '留下', city: '成都', rating: 5, at: at(2026, 9, 2) });
  const drop = await addRecord(app, token, { eat: '删掉', city: '成都', rating: 5, at: at(2026, 9, 1) });

  const before = await call(app, '/v1/stats', { token });
  assert.equal(before.body.total, 2);

  const del = await call(app, `/v1/records/${drop.id}`, { method: 'DELETE', token });
  assert.equal(del.status, 204);
  const again = await call(app, `/v1/records/${drop.id}`, { method: 'DELETE', token });
  assert.equal(again.status, 204, '重复删自己的记录应幂等 204');

  const gone = await call(app, `/v1/records/${drop.id}`, { token });
  assert.equal(gone.status, 404);

  const list = await call(app, '/v1/records', { token });
  assert.equal(list.body.total, 1);
  assert.equal(list.body.items[0].id, keep.id);

  const cities = await call(app, '/v1/records/cities', { token });
  assert.equal(cities.body.total, 1);
  assert.equal(cities.body.cityCounts[0].count, 1);

  const after = await call(app, '/v1/stats', { token });
  assert.equal(after.body.total, 1);
});

test('AC-35 撤销删除：恢复到原时间位置 + 重复恢复幂等 + 超窗口 410', async (t) => {
  const { bundle } = await (async () => {
    const b = await makeApp();
    return { bundle: b };
  })();
  const { app, store, close } = bundle;
  t.after(close);
  const token = await login(app);

  await addRecord(app, token, { eat: '旧', at: at(2026, 9, 1) });
  const middle = await addRecord(app, token, { eat: '中', at: at(2026, 9, 2) });
  await addRecord(app, token, { eat: '新', at: at(2026, 9, 3) });

  await call(app, `/v1/records/${middle.id}`, { method: 'DELETE', token });
  const restored = await call(app, `/v1/records/${middle.id}/restore`, { method: 'POST', token });
  assert.equal(restored.status, 200);
  assert.equal(restored.body.at, middle.at);

  const list = await call(app, '/v1/records?limit=10', { token });
  assert.deepEqual(
    list.body.items.map((r: { eat: string }) => r.eat),
    ['新', '中', '旧'],
    '恢复后回到原时间位置，不是排到最前',
  );

  const twice = await call(app, `/v1/records/${middle.id}/restore`, { method: 'POST', token });
  assert.equal(twice.status, 200, '重复恢复幂等 200');

  // 把 deletedAt 拨到 31 天前 → 410 GONE
  const row = (store as MemoryStore).getRecord(middle.id)!;
  row.deletedAt = Date.now() - 31 * 86_400_000;
  (store as MemoryStore).updateRecord(row);
  const tooLate = await call(app, `/v1/records/${middle.id}/restore`, { method: 'POST', token });
  assert.equal(tooLate.status, 410);
  assert.equal(tooLate.body.error.code, 'GONE');
});

test('随机一道：排除上一条、空池 404 NO_RECORD、no-store', async (t) => {
  const { app, close } = await makeApp();
  t.after(close);
  const token = await login(app);

  const empty = await call(app, '/v1/records/random', { token });
  assert.equal(empty.status, 404);
  assert.equal(empty.body.error.code, 'NO_RECORD');

  const a = await addRecord(app, token, { eat: 'a' });
  const b = await addRecord(app, token, { eat: 'b' });

  const res = await call(app, `/v1/records/random?excludeId=${a.id}`, { token });
  assert.equal(res.status, 200);
  assert.equal(res.body.record.id, b.id);
  assert.equal(res.headers.get('Cache-Control'), 'no-store');

  // 只有一条时，即使 exclude 也允许返回它
  await call(app, `/v1/records/${b.id}`, { method: 'DELETE', token });
  const only = await call(app, `/v1/records/random?excludeId=${a.id}`, { token });
  assert.equal(only.status, 200);
  assert.equal(only.body.record.id, a.id);
});

/**
 * 分享（契约 §11 #10）：token 门控的匿名读。
 *
 * 关键断言是**安全边界**而不是 happy path：
 *   · 没开分享 → 链接不存在（404，且与 token 错不可区分）；
 *   · token 错 / 别的记录的 token → 404；
 *   · 删除即断链；
 *   · 撤销分享后旧 token 立即失效（这是"发错了能收回"的唯一手段）。
 */
test('分享：token 门控匿名读、删除即断链、撤销后失效', async (t) => {
  const { app, close } = await makeApp();
  t.after(close);
  const token = await login(app);
  const rec = await addRecord(app, token, { eat: '可分享的菜', city: '成都', rating: 5 });

  // 1) 没开分享：任何人都读不到（带任意 token 也不行）
  const before = await app.request(`/v1/share/records/${rec.id}?token=whatever`);
  assert.equal(before.status, 404, '未开启分享时链接不应可用');

  // 2) 开启分享 → 拿到 token → 免鉴权可读（模拟对方没登录）
  const opened = await call(app, `/v1/records/${rec.id}/share`, { method: 'POST', token });
  assert.equal(opened.status, 200);
  const shareToken = opened.body.shareToken as string;
  assert.match(shareToken, /^sh_[0-9a-f]{64}$/, 'token 必须是不可猜的随机串');

  const anonymous = await app.request(`/v1/share/records/${rec.id}?token=${shareToken}`);
  assert.equal(anonymous.status, 200, '免鉴权应能读到');
  const payload = (await anonymous.json()) as { record: { eat: string }; shared: boolean };
  assert.equal(payload.record.eat, '可分享的菜');
  assert.equal(payload.shared, true);

  // 3) 幂等：再点一次分享拿到同一个 token（否则已发出去的卡片会失效）
  const again = await call(app, `/v1/records/${rec.id}/share`, { method: 'POST', token });
  assert.equal(again.body.shareToken, shareToken, '重复分享必须复用同一 token');

  // 4) token 错 / 缺 token / 别的记录 id → 一律 404（不泄露存在性）
  const wrong = await app.request(`/v1/share/records/${rec.id}?token=sh_${'0'.repeat(64)}`);
  assert.equal(wrong.status, 404);
  const missing = await app.request(`/v1/share/records/${rec.id}`);
  assert.equal(missing.status, 404);
  const other = await addRecord(app, token, { eat: '另一条' });
  const crossed = await app.request(`/v1/share/records/${other.id}?token=${shareToken}`);
  assert.equal(crossed.status, 404, 'A 的 token 不能读 B');

  // 5) 别人的 token 也不能凭空创建分享（需要鉴权 + 归属校验）
  const strangerLogin = await call(app, '/v1/auth/anonymous', {
    method: 'POST',
    body: { deviceId: 'stranger-share-device' },
  });
  const stranger = await call(app, `/v1/records/${rec.id}/share`, {
    method: 'POST',
    token: strangerLogin.body.accessToken,
  });
  assert.equal(stranger.status, 404, '别人的记录不能开分享');

  // 6) 撤销分享 → 旧链接立即失效
  const revoked = await call(app, `/v1/records/${rec.id}/share`, { method: 'DELETE', token });
  assert.equal(revoked.status, 204);
  const afterRevoke = await app.request(`/v1/share/records/${rec.id}?token=${shareToken}`);
  assert.equal(afterRevoke.status, 404, '撤销后旧 token 必须失效');

  // 7) 删除即断链：重新分享后删除，链接应立刻不可用
  const reopened = await call(app, `/v1/records/${rec.id}/share`, { method: 'POST', token });
  const token2 = reopened.body.shareToken as string;
  await call(app, `/v1/records/${rec.id}`, { method: 'DELETE', token });
  const afterDelete = await app.request(`/v1/share/records/${rec.id}?token=${token2}`);
  assert.equal(afterDelete.status, 404, '删除后分享链接必须断掉');
});

/**
 * 时区请求头校验（§3.4）：非法 `X-Timezone-Offset` 必须 400，不能静默回落。
 *
 * 为什么这条重要：以前 `parseTzOffset(header) ?? fallback` 会把 `bogus`
 * 当成 +08:00 照常写入 —— 记录的 at/eatenAtUtc 与客户端以为的时区差几小时，
 * 且无任何信号。时区错会连锁影响排序、分月、统计，属于"静默错数据"。
 */
test('X-Timezone-Offset 非法 → 400（不静默回落），合法与缺省都正常', async (t) => {
  const { app, close } = await makeApp();
  t.after(close);
  const token = await login(app);

  const bad = [
    'bogus',
    '8:00',        // 缺正负号
    '+8',          // 缺分钟
    '+0800',       // 缺冒号
    '+25:00',      // 超出 ±14
    '+14:30',      // 14 小时只能 :00
    '',
  ];
  for (const v of bad) {
    const res = await call(app, '/v1/records', {
      method: 'POST',
      token,
      headers: { 'X-Timezone-Offset': v },
      body: { eat: '时区测试' },
    });
    // 空串等于没传（客户端常见），不算非法 —— 单独放行
    if (v === '') {
      assert.equal(res.status, 201, '空字符串应视为未传');
      continue;
    }
    assert.equal(res.status, 400, `应拒绝 X-Timezone-Offset="${v}"`);
    assert.equal(res.body.error.code, 'BAD_REQUEST');
  }

  // 合法值：记录应带上该偏移，且 at 与 eatenAtUtc 严格互推
  const ok = await call(app, '/v1/records', {
    method: 'POST',
    token,
    headers: { 'X-Timezone-Offset': '-05:00' },
    body: { eat: '纽约时区' },
  });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.tzOffset, '-05:00');
  assert.match(ok.body.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  /* -05:00 的 at 转 UTC 应比本地时间晚 5 小时 */
  const atMs = Date.parse(`${ok.body.at}:00-05:00`);
  assert.equal(Date.parse(ok.body.eatenAtUtc), atMs, 'at 与 eatenAtUtc 必须互推');

  // 缺省：回落默认 +08:00
  const dflt = await call(app, '/v1/records', { method: 'POST', token, body: { eat: '默认时区' } });
  assert.equal(dflt.status, 201);
  assert.equal(dflt.body.tzOffset, '+08:00');
});
