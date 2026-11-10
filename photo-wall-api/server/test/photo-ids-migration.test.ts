/**
 * 照片 id 兼容层（`src/store/photo-ids.ts`）与 SQLite 迁移的回归测试。
 *
 * 为什么单独一个文件、而不是并进 `multi-photo.test.ts`：
 *   · 这里测的是**存储层兼容语义**（老数据怎么折、新数据怎么存），
 *     而 `multi-photo.test.ts` 测的是**接口契约**（AC-36 ~ AC-38）；
 *   · 两类测试的失败含义不同：这里挂了 = 老用户数据会丢/复活，
 *     那里挂了 = 接口形状不对。混在一起以后不好定位。
 *
 * 背景（这条测试存在的理由）：
 *   旧库里 `records.photoId` 是单值列；新库 `records.photoIds` 是 JSON 数组串。
 *   两者的**空值语义完全不同**，这是整套兼容层最容易出错的地方：
 *
 *     photoIds IS NULL  → 这行**从来没写过**新列 = 老数据 → 折成 [photoId]
 *     photoIds = '[]'   → 这行迁移过，且**用户显式清空过** → 就是空，不能复活
 *
 *   一旦把这两者混为一谈（迁移回填时把 '[]' 也当成"没迁移过"），
 *   用户删掉的照片会在**每次重启后复活** —— 而且是静默的：
 *   HTTP 200、页面照常显示，用户明明已经删过了。
 *   （旧 `photoId` 列保留但不再写入，所以它一直留着旧值等着被错误回填。）
 *
 * 所以下面这组断言钉的是**"空"的两种含义必须分开**。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { unlinkSync } from 'node:fs';
import Database from 'better-sqlite3';
import {
  parsePhotoIds,
  readPhotoIds,
  readPhotoIdsColumn,
  referencedPhotoIds,
  serializePhotoIds,
} from '../src/store/photo-ids.js';

// ---------------------------------------------------------------- 读行语义

test('readPhotoIds：photoIds 是数组 → 原样采用；缺失 → 回落旧 photoId', () => {
  /* 新版：数组原样返回（含空数组 = 用户显式清空） */
  assert.deepEqual(readPhotoIds({ photoIds: ['a', 'b'] }), ['a', 'b']);
  assert.deepEqual(readPhotoIds({ photoIds: [] }), [], '空数组 = 显式清空，不是"没有该字段"');

  /* 旧版：没有 photoIds → 回落单个 photoId */
  assert.deepEqual(readPhotoIds({ photoId: 'pho_a' }), ['pho_a']);
  assert.deepEqual(readPhotoIds({ photoId: null }), []);
  assert.deepEqual(readPhotoIds({}), []);

  /* 两者都在 → photoIds 优先（旧字段忽略） */
  assert.deepEqual(readPhotoIds({ photoIds: ['x'], photoId: 'y' }), ['x']);

  /* 脏数据：非字符串元素被剔除，空串被剔除 */
  assert.deepEqual(readPhotoIds({ photoIds: ['a', '', 123, 'b'] as unknown as string[] }), ['a', 'b']);
});

test('readPhotoIdsColumn：NULL 回落旧列；\'[]\' 绝不回落旧列', () => {
  /* 老数据：photoIds 列是 NULL → 回落旧 photoId */
  assert.deepEqual(readPhotoIdsColumn(null, 'pho_a'), ['pho_a']);
  assert.deepEqual(readPhotoIdsColumn('', 'pho_a'), ['pho_a']);
  assert.deepEqual(readPhotoIdsColumn(undefined, 'pho_a'), ['pho_a']);

  /* 已迁移且用户清空过 → 保持空，**不能**被旧列复活 */
  assert.deepEqual(readPhotoIdsColumn('[]', 'pho_a'), [], "'[]' = 用户清空过，绝不回落旧列");
  assert.deepEqual(readPhotoIdsColumn('["pho_b"]', 'pho_a'), ['pho_b']);

  /* 都没有 → 空 */
  assert.deepEqual(readPhotoIdsColumn(null, null), []);
  assert.deepEqual(readPhotoIdsColumn(null, ''), []);
});

test('parsePhotoIds：脏数据一律当空数组（不能让一条坏行炸掉整页查询）', () => {
  assert.deepEqual(parsePhotoIds('["a","b"]'), ['a', 'b']);
  assert.deepEqual(parsePhotoIds('[]'), []);
  assert.deepEqual(parsePhotoIds('not json'), []);
  assert.deepEqual(parsePhotoIds('{"a":1}'), [], '不是数组 → 空');
  assert.deepEqual(parsePhotoIds('123'), [], '不是数组 → 空');
  assert.deepEqual(parsePhotoIds(null), []);
  assert.deepEqual(parsePhotoIds(undefined), []);
  assert.deepEqual(parsePhotoIds(42), []);
});

test('serializePhotoIds：空数组存 \'[]\' 而不是 NULL（NULL = 老数据）', () => {
  assert.equal(serializePhotoIds(['a', 'b']), '["a","b"]');
  assert.equal(serializePhotoIds([]), '[]');
  /* 往返一致 */
  assert.deepEqual(parsePhotoIds(serializePhotoIds(['a'])), ['a']);
  assert.deepEqual(parsePhotoIds(serializePhotoIds([])), []);
});

test('referencedPhotoIds：一行记录的**每一张**照片都算被引用', () => {
  const rows = [
    { photoIds: ['a', 'b', 'c'] },
    { photoIds: ['b'] },
    { photoId: 'd' }, // 旧形态
    { photoIds: [] },
  ];
  assert.deepEqual(
    [...referencedPhotoIds(rows)].sort(),
    ['a', 'b', 'c', 'd'],
    '多张照片要全部计入引用，不能只看第一张',
  );
});

// ---------------------------------------------------------------- SQLite 迁移

/** 造一个"老版本"的库：records 表有 photoId 列，没有 photoIds 列 */
function makeLegacyDb(file: string): void {
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

test('SQLite 迁移：老库行折成 [photoId]，且旧 photoId 列不再被写入', async (t) => {
  const file = `var/__pidm1_${Date.now()}.sqlite`;
  t.after(() => {
    for (const s of ['', '-wal', '-shm']) {
      try {
        unlinkSync(file + s);
      } catch {
        /* 文件可能不存在 */
      }
    }
  });

  makeLegacyDb(file);

  const { SqliteStore } = await import('../src/store/sqlite.js');
  const store = await SqliteStore.open(file);
  t.after(() => store.close());

  const row = store.getRecord('rec_old');
  assert.ok(row, '老记录应能读出');
  assert.deepEqual(row.photoIds, ['pho_old'], '旧 photoId 必须折成 [photoId]');

  /* 写一条新记录：旧 photoId 列不该再被写入 */
  const fresh = { ...row, id: 'rec_new', photoIds: ['pho_old', 'pho_other'] };
  store.updateRecord(fresh);
  assert.deepEqual(store.getRecord('rec_new')?.photoIds, ['pho_old', 'pho_other']);

  const raw = new Database(file)
    .prepare('SELECT photoId, photoIds FROM records WHERE id = ?')
    .get('rec_new') as { photoId: string | null; photoIds: string | null };
  assert.equal(raw.photoId, null, '旧 photoId 列保留但不再写入');
  assert.equal(raw.photoIds, '["pho_old","pho_other"]', 'photoIds 存 JSON 数组串');
});

test('SQLite 迁移（回归）：清空照片后重启，旧 photoId 残留值不能把照片复活', async (t) => {
  const file = `var/__pidm2_${Date.now()}.sqlite`;
  t.after(() => {
    for (const s of ['', '-wal', '-shm']) {
      try {
        unlinkSync(file + s);
      } catch {
        /* 文件可能不存在 */
      }
    }
  });

  makeLegacyDb(file);
  const { SqliteStore } = await import('../src/store/sqlite.js');

  /* 第一次打开：迁移 → 老 photoId 折成 [photoId] */
  const first = await SqliteStore.open(file);
  assert.deepEqual(first.getRecord('rec_old')?.photoIds, ['pho_old']);

  /* 用户在新版本里"清空照片"（PATCH photoIds: []） */
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

  /* 再重启一次：反复重启也不能复活（迁移是幂等的） */
  const third = await SqliteStore.open(file);
  assert.deepEqual(third.getRecord('rec_old')?.photoIds, [], '迁移必须幂等');
  await third.close();
});

test('SQLite 迁移：photoIds 已有值的老行不被覆盖（迁移只碰 NULL 的行）', async (t) => {
  const file = `var/__pidm3_${Date.now()}.sqlite`;
  t.after(() => {
    for (const s of ['', '-wal', '-shm']) {
      try {
        unlinkSync(file + s);
      } catch {
        /* 文件可能不存在 */
      }
    }
  });

  /* 造一个"迁移过一次、且用户改过照片集合"的库：
     photoIds 列已有内容，旧 photoId 列还留着最初的旧值。 */
  {
    const db = new Database(file);
    db.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY, wechatOpenid TEXT UNIQUE, deviceId TEXT UNIQUE,
        createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL
      );
      CREATE TABLE records (
        id TEXT PRIMARY KEY, userId TEXT NOT NULL REFERENCES users(id),
        eat TEXT NOT NULL, shop TEXT, shopId TEXT, city TEXT, district TEXT,
        rating INTEGER NOT NULL, atLocal TEXT NOT NULL, tzOffset TEXT NOT NULL,
        eatenAtUtc TEXT NOT NULL, note TEXT,
        photoId TEXT, photoIds TEXT,
        version INTEGER NOT NULL, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
        deletedAt INTEGER, shareToken TEXT, sharedAt INTEGER
      );
      CREATE TABLE photos (
        id TEXT PRIMARY KEY, userId TEXT NOT NULL REFERENCES users(id),
        url TEXT NOT NULL, photoUrl TEXT NOT NULL, thumbUrl TEXT NOT NULL,
        width INTEGER NOT NULL, height INTEGER NOT NULL, size INTEGER NOT NULL,
        mime TEXT NOT NULL, status TEXT NOT NULL, createdAt INTEGER NOT NULL, deletedAt INTEGER
      );
      INSERT INTO users VALUES ('usr_x','openid_x',NULL,1,1);
      INSERT INTO photos VALUES ('pho_a','usr_x','u','u','u',4,3,10,'image/png','approved',1,NULL);
      INSERT INTO photos VALUES ('pho_b','usr_x','u','u','u',4,3,10,'image/png','approved',1,NULL);
      INSERT INTO records VALUES
        ('rec_x','usr_x','改过图',NULL,NULL,NULL,NULL,5,'2026-01-01T12:00','+08:00',
         '2026-01-01T04:00:00Z',NULL,'pho_a','["pho_a","pho_b"]',2,1,1,NULL,NULL,NULL);
    `);
    db.close();
  }

  const { SqliteStore } = await import('../src/store/sqlite.js');
  const store = await SqliteStore.open(file);
  t.after(() => store.close());

  assert.deepEqual(
    store.getRecord('rec_x')?.photoIds,
    ['pho_a', 'pho_b'],
    'photoIds 列已有值的行，迁移不能动它（哪怕旧 photoId 列还留着别的值）',
  );
});
