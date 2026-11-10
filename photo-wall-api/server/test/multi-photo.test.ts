/**
 * 多图验收（AC-36 ~ AC-38）：
 *   · 一条记录至多 5 张照片，顺序即用户选择顺序；
 *   · 编辑照片集合是**整体替换**，`[]` = 清空，不带 = 不动；
 *   · 旧字段 `photoId` 仍可用，且与 `photoIds` 同时出现时后者优先；
 *   · 引用与级联全部按「多张」判定。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { addRecord, call, formWithFile, login, makeApp, tinyPng } from './helpers.js';
import { SqliteStore } from '../src/store/sqlite.js';
import { MemoryStore } from '../src/store/memory.js';
import type { RecordRow } from '../src/store/types.js';
import { unlinkSync } from 'node:fs';

/** 传 n 张真图，返回 photoId 列表（顺序即上传顺序） */
async function uploadPhotos(
  app: Awaited<ReturnType<typeof makeApp>>['app'],
  token: string,
  n: number,
): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const res = await call(app, '/v1/photos', {
      method: 'POST',
      token,
      raw: formWithFile(tinyPng(4 + i, 3 + i), `p${i}.png`),
    });
    assert.equal(res.status, 201, `第 ${i + 1} 张上传失败：${res.text}`);
    ids.push(res.body.photoId as string);
  }
  return ids;
}

test('AC-36 建记录带 5 个 photoIds → photos 长度 5、顺序一致、封面 = photos[0]', async (t) => {
  const { app, close } = await makeApp();
  t.after(close);
  const token = await login(app);

  const ids = await uploadPhotos(app, token, 5);
  const res = await call(app, '/v1/records', {
    method: 'POST',
    token,
    body: { eat: '五张图', photoIds: ids },
  });
  assert.equal(res.status, 201, res.text);

  assert.equal(res.body.photos.length, 5);
  assert.deepEqual(
    res.body.photos.map((p: { photoId: string }) => p.photoId),
    ids,
    'photos 的顺序必须与提交顺序完全一致（顺序即用户选择顺序）',
  );

  /* 旧三字段 = 封面（photos[0]） */
  assert.equal(res.body.photoId, ids[0]);
  assert.equal(res.body.photo, res.body.photos[0].photo);
  assert.equal(res.body.photoThumb, res.body.photos[0].photoThumb);

  /* 响应里不应出现 photoIds[] —— id 已在 photos[].photoId 里，两处都给会漂移 */
  assert.equal(res.body.photoIds, undefined, '响应里不能有 photoIds[]');

  /* GET 单条也要一致 */
  const one = await call(app, `/v1/records/${res.body.id}`, { token });
  assert.equal(one.body.photos.length, 5);
  assert.equal(one.body.photoId, ids[0]);

  /* 列表里的同一条也一致 */
  const list = await call(app, '/v1/records?limit=10', { token });
  assert.equal(list.body.items[0].photos.length, 5);
  assert.equal(list.body.items[0].photoId, ids[0]);
});

test('AC-36 传 6 个 photoIds → 422 + fields.photoIds', async (t) => {
  const { app, close } = await makeApp();
  t.after(close);
  const token = await login(app);

  const ids = await uploadPhotos(app, token, 6);
  const res = await call(app, '/v1/records', {
    method: 'POST',
    token,
    body: { eat: '超上限', photoIds: ids },
  });
  assert.equal(res.status, 422);
  assert.equal(res.body.error.code, 'VALIDATION_FAILED');
  assert.ok(res.body.error.fields.photoIds, '必须有 fields.photoIds');
  assert.match(String(res.body.error.fields.photoIds), /最多 5 张照片/);

  /* PATCH 同样要拦 */
  const rec = await addRecord(app, token, { eat: '正常' });
  const patched = await call(app, `/v1/records/${rec.id}`, {
    method: 'PATCH',
    token,
    body: { photoIds: ids },
  });
  assert.equal(patched.status, 422);
  assert.ok(patched.body.error.fields.photoIds);
});

test('AC-36 photoIds 有重复 id → 422 + fields.photoIds', async (t) => {
  const { app, close } = await makeApp();
  t.after(close);
  const token = await login(app);

  const ids = await uploadPhotos(app, token, 2);
  const res = await call(app, '/v1/records', {
    method: 'POST',
    token,
    body: { eat: '重复图', photoIds: [ids[0], ids[1], ids[0]] },
  });
  assert.equal(res.status, 422);
  assert.ok(res.body.error.fields.photoIds);
  assert.match(String(res.body.error.fields.photoIds), /不能重复/);
});

test('AC-36 photoIds 里混入别人的 photoId → 422 + fields.photoIds', async (t) => {
  const { app, close } = await makeApp();
  t.after(close);
  const token = await login(app);
  const other = await login(app, 'other-user');

  const mine = await uploadPhotos(app, token, 1);
  const theirs = await uploadPhotos(app, other, 1);

  const res = await call(app, '/v1/records', {
    method: 'POST',
    token,
    body: { eat: '越权图', photoIds: [mine[0], theirs[0]] },
  });
  assert.equal(res.status, 422);
  assert.ok(res.body.error.fields.photoIds);
  assert.match(String(res.body.error.fields.photoIds), /照片不存在/);
});

test('AC-37 PATCH 带 photoIds → 整体替换（不是追加）', async (t) => {
  const { app, close } = await makeApp();
  t.after(close);
  const token = await login(app);

  const ids = await uploadPhotos(app, token, 5);
  const rec = await addRecord(app, token, { eat: '先五张', photoIds: ids.slice(0, 3) });
  assert.equal(rec.photos.length, 3);

  /* 换成 2 张 → 旧的那 3 张不该还在（整体替换，不是追加） */
  const res = await call(app, `/v1/records/${rec.id}`, {
    method: 'PATCH',
    token,
    body: { photoIds: ids.slice(3, 5) },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.photos.length, 2, '必须是整体替换，不能追加成 5 张');
  assert.deepEqual(
    res.body.photos.map((p: { photoId: string }) => p.photoId),
    ids.slice(3, 5),
  );
  assert.equal(res.body.photoId, ids[3], '封面跟着换');
});

test('AC-37 PATCH photoIds: [] → 清空（旧三字段 null、photos 空数组）', async (t) => {
  const { app, close } = await makeApp();
  t.after(close);
  const token = await login(app);

  const ids = await uploadPhotos(app, token, 2);
  const rec = await addRecord(app, token, { eat: '待清空', photoIds: ids });
  assert.equal(rec.photos.length, 2);

  const res = await call(app, `/v1/records/${rec.id}`, {
    method: 'PATCH',
    token,
    body: { photoIds: [] },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.photos, [], 'photos 必须是空数组（恒存在）');
  assert.equal(res.body.photo, null);
  assert.equal(res.body.photoThumb, null);
  assert.equal(res.body.photoId, null, '清空后旧三字段全为 null');

  /* 再取一次，确认真的落库了（不是响应层临时算的） */
  const again = await call(app, `/v1/records/${rec.id}`, { token });
  assert.deepEqual(again.body.photos, []);
  assert.equal(again.body.photoId, null);
});

test('AC-37 PATCH 不带 photoIds → 照片不动', async (t) => {
  const { app, close } = await makeApp();
  t.after(close);
  const token = await login(app);

  const ids = await uploadPhotos(app, token, 3);
  const rec = await addRecord(app, token, { eat: '只改文字', photoIds: ids });

  const res = await call(app, `/v1/records/${rec.id}`, {
    method: 'PATCH',
    token,
    body: { note: '只改了备注' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.photos.length, 3, '不带 photoIds → 照片集合保持原样');
  assert.deepEqual(
    res.body.photos.map((p: { photoId: string }) => p.photoId),
    ids,
  );
  assert.equal(res.body.photoId, ids[0]);
});

test('AC-36/37 旧字段 photoId 仍可用；与 photoIds 同时出现 → photoIds 优先且不报错', async (t) => {
  const { app, close } = await makeApp();
  t.after(close);
  const token = await login(app);

  const ids = await uploadPhotos(app, token, 3);

  /* 1) 只传旧字段 photoId → 等价 photoIds:[photoId] */
  const legacy = await call(app, '/v1/records', {
    method: 'POST',
    token,
    body: { eat: '旧字段', photoId: ids[0] },
  });
  assert.equal(legacy.status, 201, legacy.text);
  assert.equal(legacy.body.photos.length, 1);
  assert.equal(legacy.body.photos[0].photoId, ids[0]);
  assert.equal(legacy.body.photoId, ids[0]);

  /* 2) 两者同时出现 → photoIds 优先，不报错 */
  const both = await call(app, '/v1/records', {
    method: 'POST',
    token,
    body: { eat: '两字段并存', photoId: ids[0], photoIds: [ids[1], ids[2]] },
  });
  assert.equal(both.status, 201, '两者同时出现不报错');
  assert.deepEqual(
    both.body.photos.map((p: { photoId: string }) => p.photoId),
    [ids[1], ids[2]],
    'photoIds 优先，photoId 被忽略',
  );
  assert.equal(both.body.photoId, ids[1]);

  /* 3) PATCH 也一样：photoIds 优先 */
  const patched = await call(app, `/v1/records/${legacy.body.id}`, {
    method: 'PATCH',
    token,
    body: { photoId: ids[0], photoIds: [ids[2]] },
  });
  assert.equal(patched.status, 200);
  assert.deepEqual(
    patched.body.photos.map((p: { photoId: string }) => p.photoId),
    [ids[2]],
  );

  /* 4) 旧字段 photoId: null = 清空全部 */
  const cleared = await call(app, `/v1/records/${legacy.body.id}`, {
    method: 'PATCH',
    token,
    body: { photoId: null },
  });
  assert.equal(cleared.status, 200);
  assert.deepEqual(cleared.body.photos, []);
  assert.equal(cleared.body.photoId, null);

  /* 5) 旧字段触发校验时，fields 键仍是 photoId（保持旧行为） */
  const bad = await call(app, '/v1/records', {
    method: 'POST',
    token,
    body: { eat: '坏图', photoId: 'pho_nope' },
  });
  assert.equal(bad.status, 422);
  assert.ok(bad.body.error.fields.photoId, '旧字段的 errors 键必须仍是 photoId');
});

test('AC-36 photoIds 传错类型 → 422，fields 键仍是 photoIds（不是 photoIds.0）', async (t) => {
  const { app, close } = await makeApp();
  t.after(close);
  const token = await login(app);

  for (const bad of ['abc', { a: 1 }, [1, 2]]) {
    const res = await call(app, '/v1/records', {
      method: 'POST',
      token,
      body: { eat: '类型错', photoIds: bad },
    });
    assert.equal(res.status, 422, `${JSON.stringify(bad)} 应该 422`);
    assert.ok(res.body.error.fields.photoIds, '错误必须收拢在 photoIds 上');
    assert.equal(
      Object.keys(res.body.error.fields).some((k) => k !== 'photoIds'),
      false,
      `不应出现 photoIds.0 这类下标键：${JSON.stringify(res.body.error.fields)}`,
    );
  }
});

test('AC-37 PATCH photoIds: null → 同样清空（与 [] 等价）', async (t) => {
  const { app, close } = await makeApp();
  t.after(close);
  const token = await login(app);

  const ids = await uploadPhotos(app, token, 2);
  const rec = await addRecord(app, token, { eat: 'null 清空', photoIds: ids });

  const res = await call(app, `/v1/records/${rec.id}`, {
    method: 'PATCH',
    token,
    body: { photoIds: null },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.photos, []);
  assert.equal(res.body.photoId, null);
});

test('AC-38 级联：删一条 3 图记录 → 3 张全部软删；被别的记录引用的那张不删', async (t) => {
  const { app, close, services } = await makeApp();
  t.after(close);
  const token = await login(app);

  const ids = await uploadPhotos(app, token, 4);
  const rec = await addRecord(app, token, { eat: '三图记录', photoIds: ids.slice(0, 3) });
  /* 另一条记录引用 ids[1] → 这张不能被级联软删 */
  await addRecord(app, token, { eat: '还引用着', photoIds: [ids[1]] });

  await call(app, `/v1/records/${rec.id}`, { method: 'DELETE', token });

  assert.notEqual(services.store.getPhoto(ids[0])?.deletedAt, null, '不再被引用的应被软删');
  assert.equal(services.store.getPhoto(ids[1])?.deletedAt, null, '还被别的记录引用 → 不能软删');
  assert.notEqual(services.store.getPhoto(ids[2])?.deletedAt, null, '不再被引用的应被软删');
  assert.equal(services.store.getPhoto(ids[3])?.deletedAt, null, '没被引用的照片不受影响');
});

test('AC-38 恢复记录 → 它的每一张照片都恢复', async (t) => {
  const { app, close, services } = await makeApp();
  t.after(close);
  const token = await login(app);

  const ids = await uploadPhotos(app, token, 3);
  const rec = await addRecord(app, token, { eat: '待恢复', photoIds: ids });

  await call(app, `/v1/records/${rec.id}`, { method: 'DELETE', token });
  for (const id of ids) {
    assert.notEqual(services.store.getPhoto(id)?.deletedAt, null, '删除后照片应软删');
  }

  const restored = await call(app, `/v1/records/${rec.id}/restore`, { method: 'POST', token });
  assert.equal(restored.status, 200);
  assert.equal(restored.body.photos.length, 3);
  for (const id of ids) {
    assert.equal(services.store.getPhoto(id)?.deletedAt, null, '恢复记录应恢复它的每一张照片');
  }
});

test('AC-38 DELETE /photos/{id}：被多图记录引用 → 409 PHOTO_IN_USE', async (t) => {
  const { app, close } = await makeApp();
  t.after(close);
  const token = await login(app);

  const ids = await uploadPhotos(app, token, 3);
  await addRecord(app, token, { eat: '占着三张', photoIds: ids });

  /* 三张都被引用 → 都 409（不只是第一张） */
  for (const id of ids) {
    const res = await call(app, `/v1/photos/${id}`, { method: 'DELETE', token });
    assert.equal(res.status, 409, `照片 ${id} 被多图记录引用应 409`);
    assert.equal(res.body.error.code, 'PHOTO_IN_USE');
  }
});

test('AC-38 回收任务：软删且无人引用的照片被物理删除；被引用的保留', async (t) => {
  const { app, close, services } = await makeApp();
  t.after(close);
  const token = await login(app);

  const ids = await uploadPhotos(app, token, 3);
  /* rec 引用 3 张；删掉 rec 后 3 张全部软删且无人引用 → 应被回收 */
  const rec = await addRecord(app, token, { eat: '待回收', photoIds: ids });
  await call(app, `/v1/records/${rec.id}`, { method: 'DELETE', token });

  /* 另一张仍被活记录引用 → 不能删 */
  const keep = await uploadPhotos(app, token, 1);
  await addRecord(app, token, { eat: '活着的', photoIds: keep });
  /* 把它软删但保留记录引用（模拟"记录还在、照片被别的路径标软删"） */
  const keepPhoto = services.store.getPhoto(keep[0])!;
  keepPhoto.deletedAt = Date.now();
  services.store.updatePhoto(keepPhoto);

  const r = services.store.purgeSoftDeleted(30);
  assert.equal(r.photos, 3, '只有 3 张孤儿该被清理');
  for (const id of ids) {
    assert.equal(services.store.getPhoto(id), undefined, '无引用的软删照片应被物理删除');
  }
  assert.ok(services.store.getPhoto(keep[0]), '仍被活记录引用的照片必须保留');
});

test('SQLite 迁移：老库（有 photoId 无 photoIds）打开后读出 photoIds=[旧 id]', async (t) => {
  const file = `var/__mp_${Date.now()}.sqlite`;
  t.after(() => {
    try {
      unlinkSync(file);
    } catch {
      /* 文件可能不存在，忽略 */
    }
  });

  /* 造一个"老版本"的库：records 表有 photoId 列，没有 photoIds 列 */
  {
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(file);
    db.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY, wechatOpenid TEXT UNIQUE, deviceId TEXT UNIQUE,
        createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL
      );
      CREATE TABLE records (
        id TEXT PRIMARY KEY,
        userId TEXT NOT NULL REFERENCES users(id),
        eat TEXT NOT NULL, shop TEXT, shopId TEXT, city TEXT, district TEXT,
        rating INTEGER NOT NULL, atLocal TEXT NOT NULL, tzOffset TEXT NOT NULL,
        eatenAtUtc TEXT NOT NULL, note TEXT,
        photoId TEXT,
        version INTEGER NOT NULL, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
        deletedAt INTEGER, shareToken TEXT, sharedAt INTEGER
      );
      CREATE TABLE photos (
        id TEXT PRIMARY KEY, userId TEXT NOT NULL REFERENCES users(id),
        url TEXT NOT NULL, photoUrl TEXT NOT NULL, thumbUrl TEXT NOT NULL,
        width INTEGER NOT NULL, height INTEGER NOT NULL, size INTEGER NOT NULL,
        mime TEXT NOT NULL, status TEXT NOT NULL, createdAt INTEGER NOT NULL, deletedAt INTEGER
      );
      INSERT INTO users VALUES ('usr_old','openid_old',NULL,1,1);
      INSERT INTO photos VALUES ('pho_old','usr_old','u','u','u',4,3,10,'image/png','approved',1,NULL);
      INSERT INTO records VALUES
        ('rec_old','usr_old','老记录',NULL,NULL,NULL,NULL,5,'2026-01-01T12:00','+08:00',
         '2026-01-01T04:00:00Z',NULL,'pho_old',1,1,1,NULL,NULL,NULL);
    `);
    db.close();
  }

  /* 用新代码打开 → 迁移自动发生 */
  const store = await SqliteStore.open(file);
  t.after(() => store.close());

  const row = store.getRecord('rec_old');
  assert.ok(row, '老记录应能读出');
  assert.deepEqual(row.photoIds, ['pho_old'], '旧 photoId 必须折成 [photoId]');

  /* 新写入的行走 photoIds 列，旧 photoId 列不再被写入 */
  const fresh: RecordRow = {
    ...(row as RecordRow),
    id: 'rec_new',
    photoIds: ['pho_old', 'pho_other'],
  };
  store.updateRecord(fresh);
  const again = store.getRecord('rec_new');
  assert.deepEqual(again?.photoIds, ['pho_old', 'pho_other']);

  await store.close();
});

test('SQLite 迁移（回归）：清空照片后重启，旧 photoId 残留值不能把照片复活', async (t) => {
  const file = `var/__mp3_${Date.now()}.sqlite`;
  t.after(() => {
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        unlinkSync(file + suffix);
      } catch {
        /* 文件可能不存在，忽略 */
      }
    }
  });

  /* 造一个"老版本"的库：records 表有 photoId 列，没有 photoIds 列 */
  {
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(file);
    db.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY, wechatOpenid TEXT UNIQUE, deviceId TEXT UNIQUE,
        createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL
      );
      CREATE TABLE records (
        id TEXT PRIMARY KEY,
        userId TEXT NOT NULL REFERENCES users(id),
        eat TEXT NOT NULL, shop TEXT, shopId TEXT, city TEXT, district TEXT,
        rating INTEGER NOT NULL, atLocal TEXT NOT NULL, tzOffset TEXT NOT NULL,
        eatenAtUtc TEXT NOT NULL, note TEXT,
        photoId TEXT,
        version INTEGER NOT NULL, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
        deletedAt INTEGER, shareToken TEXT, sharedAt INTEGER
      );
      CREATE TABLE photos (
        id TEXT PRIMARY KEY, userId TEXT NOT NULL REFERENCES users(id),
        url TEXT NOT NULL, photoUrl TEXT NOT NULL, thumbUrl TEXT NOT NULL,
        width INTEGER NOT NULL, height INTEGER NOT NULL, size INTEGER NOT NULL,
        mime TEXT NOT NULL, status TEXT NOT NULL, createdAt INTEGER NOT NULL, deletedAt INTEGER
      );
      INSERT INTO users VALUES ('usr_old','openid_old',NULL,1,1);
      INSERT INTO photos VALUES ('pho_old','usr_old','u','u','u',4,3,10,'image/png','approved',1,NULL);
      INSERT INTO records VALUES
        ('rec_old','usr_old','老记录',NULL,NULL,NULL,NULL,5,'2026-01-01T12:00','+08:00',
         '2026-01-01T04:00:00Z',NULL,'pho_old',1,1,1,NULL,NULL,NULL);
    `);
    db.close();
  }

  /* 第一次打开：迁移 → 老 photoId 折成 [photoId] */
  const first = await SqliteStore.open(file);
  assert.deepEqual(first.getRecord('rec_old')?.photoIds, ['pho_old']);

  /* 用户在新版本里"清空照片" */
  const row = first.getRecord('rec_old')!;
  row.photoIds = [];
  row.version = 2;
  first.updateRecord(row);
  assert.deepEqual(first.getRecord('rec_old')?.photoIds, []);
  await first.close();

  /* 重启：迁移再跑一次。
     ⚠ 旧 photoId 列里还留着 'pho_old'（我们不再写它，也不删它）。
        如果回填条件把 photoIds = '[]' 也当成"未迁移"，这张图就会**复活** ——
        而且是静默的：HTTP 200、页面照常显示，用户明明删掉了。 */
  const second = await SqliteStore.open(file);
  assert.deepEqual(
    second.getRecord('rec_old')?.photoIds,
    [],
    '清空过的照片不能在重启后复活（NULL = 未迁移；\'[]\' = 已迁移且用户清空过）',
  );
  await second.close();
});

test('SQLite：多张照片往返保序；旧 photoId 列不再被写入', async (t) => {
  const file = `var/__mp2_${Date.now()}.sqlite`;
  t.after(() => {
    try {
      unlinkSync(file);
    } catch {
      /* 文件可能不存在，忽略 */
    }
  });

  const store = await SqliteStore.open(file);
  t.after(() => store.close());

  const { default: Database } = await import('better-sqlite3');
  const db = new Database(file);
  db.exec(`
    INSERT INTO users VALUES ('usr_s','openid_s',NULL,1,1);
    INSERT INTO photos VALUES
      ('pho_s1','usr_s','u1','u1','u1',4,3,10,'image/png','approved',1,NULL),
      ('pho_s2','usr_s','u2','u2','u2',4,3,10,'image/png','approved',1,NULL),
      ('pho_s3','usr_s','u3','u3','u3',4,3,10,'image/png','approved',1,NULL);
  `);
  db.close();

  const base: RecordRow = {
    id: 'rec_s',
    userId: 'usr_s',
    eat: 'sqlite 多图',
    shop: null,
    shopId: null,
    city: null,
    district: null,
    rating: 5,
    atLocal: '2026-01-01T12:00',
    tzOffset: '+08:00',
    eatenAtUtc: '2026-01-01T04:00:00Z',
    note: null,
    photoIds: ['pho_s3', 'pho_s1', 'pho_s2'],
    version: 1,
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
    shareToken: null,
    sharedAt: null,
  };
  store.insertRecord(base);

  const got = store.getRecord('rec_s');
  assert.deepEqual(got?.photoIds, ['pho_s3', 'pho_s1', 'pho_s2'], '多张照片往返必须保序');
  assert.deepEqual(
    store.listRecords('usr_s')[0]?.photoIds,
    ['pho_s3', 'pho_s1', 'pho_s2'],
    '列表读取也要保序',
  );

  /* 旧 photoId 列不再被写入（只保留历史痕迹） */
  const raw = new Database(file);
  const legacy = raw.prepare('SELECT photoId, photoIds FROM records WHERE id = ?').get('rec_s') as {
    photoId: string | null;
    photoIds: string | null;
  };
  raw.close();
  assert.equal(legacy.photoId, null, '旧 photoId 列不应再被写入');
  assert.equal(legacy.photoIds, '["pho_s3","pho_s1","pho_s2"]', 'photoIds 列存 JSON 数组串');

  await store.close();
});

test('MemoryStore hydrate：旧快照（有 photoId 无 photoIds）→ 折成 [photoId]', async (t) => {
  const { app, close, services } = await makeApp();
  t.after(close);
  const token = await login(app);

  const ids = await uploadPhotos(app, token, 1);
  const rec = await addRecord(app, token, { eat: '快照', photoIds: ids });

  /* 造一份旧形态快照：只有 photoId，没有 photoIds */
  const source = services.store as MemoryStore;
  const legacyRow = { ...(source.getRecord(rec.id) as RecordRow) } as RecordRow & {
    photoId?: string | null;
  };
  delete (legacyRow as { photoIds?: string[] }).photoIds;
  legacyRow.photoId = ids[0];

  const target = await MemoryStore.open();
  target.hydrate({ users: [], records: [legacyRow], photos: [], shops: [] });
  const hydrated = target.getRecord(rec.id);
  assert.ok(hydrated);
  assert.deepEqual(hydrated.photoIds, [ids[0]], '旧快照必须折成 [photoId]');

  /* 显式空数组 = 用户清空，不该回落旧字段 */
  const clearedRow = { ...legacyRow } as RecordRow & { photoId?: string | null };
  (clearedRow as { photoIds?: string[] }).photoIds = [];
  const target2 = await MemoryStore.open();
  target2.hydrate({ users: [], records: [clearedRow], photos: [], shops: [] });
  assert.deepEqual(target2.getRecord(rec.id)?.photoIds, [], '显式空数组不能被旧字段复活');
});

test('软删的照片从 photos 里剔除；剔除后为空 → photos=[] 且旧三字段 null', async (t) => {
  const { app, close, services } = await makeApp();
  t.after(close);
  const token = await login(app);

  const ids = await uploadPhotos(app, token, 2);
  const rec = await addRecord(app, token, { eat: '剔除测试', photoIds: ids });

  /* 把封面那张软删（但记录还引用它） */
  const cover = services.store.getPhoto(ids[0])!;
  cover.deletedAt = Date.now();
  services.store.updatePhoto(cover);

  const res = await call(app, `/v1/records/${rec.id}`, { token });
  assert.equal(res.body.photos.length, 1, '软删的那张要从 photos 里剔除');
  assert.equal(res.body.photos[0].photoId, ids[1]);
  assert.equal(res.body.photoId, ids[1], '封面取剔除后的第一张');

  /* 两张都软删 → photos 空、旧三字段全 null */
  const other = services.store.getPhoto(ids[1])!;
  other.deletedAt = Date.now();
  services.store.updatePhoto(other);
  const empty = await call(app, `/v1/records/${rec.id}`, { token });
  assert.deepEqual(empty.body.photos, []);
  assert.equal(empty.body.photo, null);
  assert.equal(empty.body.photoThumb, null);
  assert.equal(empty.body.photoId, null);
});

test('店铺页的记录也带全部照片（photos 完整、封面一致）', async (t) => {
  const { app, close } = await makeApp();
  t.after(close);
  const token = await login(app);

  const ids = await uploadPhotos(app, token, 3);
  const rec = await addRecord(app, token, { eat: '店里那道', shop: '老店', city: '成都', photoIds: ids });

  const res = await call(app, `/v1/shops/${rec.shopId}`, { token });
  assert.equal(res.status, 200);
  assert.equal(res.body.records.length, 1);
  assert.equal(res.body.records[0].photos.length, 3);
  assert.equal(res.body.records[0].photoId, ids[0]);
});
