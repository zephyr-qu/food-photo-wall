import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SqliteStore } from '../src/store/sqlite.js';
import type { IdempotencyRow, PhotoRow, RecordRow, RefreshRow, UserRow } from '../src/store/types.js';

const mkUser = (id: string): UserRow => ({
  id,
  wechatOpenid: null,
  deviceId: id,
  createdAt: 1,
  updatedAt: 1,
});

test('sqlite: user round-trip + indexes', async () => {
  const s = await SqliteStore.open(null);
  s.insertUser(mkUser('u1'));
  assert.equal(s.getUser('u1')?.id, 'u1');
  assert.equal(s.findUserByDevice('u1')?.id, 'u1');
  assert.equal(s.findUserByDevice('nope'), undefined);
  await s.close();
});

test('sqlite: idempotency single-write (INSERT OR IGNORE)', async () => {
  const s = await SqliteStore.open(null);
  const row: IdempotencyRow = {
    userId: 'u1',
    key: 'k1',
    status: 201,
    body: { ok: true },
    createdAt: Date.now(),
    expiresAt: Date.now() + 86_400_000,
  };
  s.putIdem(row);
  s.putIdem({ ...row, body: { ok: false } }); // 重放：应被 IGNORE，body 不变
  const got = s.getIdem('u1', 'k1');
  assert.deepEqual(got?.body, { ok: true }); // 第二次没覆盖
  await s.close();
});

test('sqlite: idempotency expiry', async () => {
  const s = await SqliteStore.open(null);
  s.putIdem({
    userId: 'u1',
    key: 'exp',
    status: 200,
    body: 1,
    createdAt: 1,
    expiresAt: Date.now() - 1000,
  });
  assert.equal(s.getIdem('u1', 'exp'), undefined);
  await s.close();
});

test('sqlite: refresh token expiry + delete', async () => {
  const s = await SqliteStore.open(null);
  s.insertUser(mkUser('u1'));
  const r: RefreshRow = {
    token: 'rt1',
    userId: 'u1',
    createdAt: 1,
    expiresAt: Date.now() - 1000,
  };
  s.insertRefresh(r);
  assert.equal(s.getRefresh('rt1'), undefined, 'expired refresh must not be returned');

  const r2: RefreshRow = {
    token: 'rt2',
    userId: 'u1',
    createdAt: 1,
    expiresAt: Date.now() + 86_400_000,
  };
  s.insertRefresh(r2);
  assert.equal(s.getRefresh('rt2')?.token, 'rt2');
  s.deleteRefresh('rt2');
  assert.equal(s.getRefresh('rt2'), undefined);
  await s.close();
});

test('sqlite: records soft-delete + purge', async () => {
  const s = await SqliteStore.open(null);
  s.insertUser(mkUser('u1'));
  const rec = (over: Partial<RecordRow>): RecordRow => ({
    id: 'r1',
    userId: 'u1',
    eat: 'b',
    shop: null,
    shopId: null,
    city: null,
    district: null,
    rating: 5,
    atLocal: '2026-01-01T12:00',
    tzOffset: '+08:00',
    eatenAtUtc: '2026-01-01T04:00:00Z',
    note: null,
    photoIds: [],
    version: 1,
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
    shareToken: null,
    sharedAt: null,
    ...over,
  });

  s.insertRecord(rec({ id: 'live' }));
  s.insertRecord(rec({ id: 'gone', deletedAt: 1 })); // 软删、且早于 cutoff
  const before = s.listRecords('u1').length;
  assert.equal(before, 1, '软删默认不被列出');

  const res = s.purgeSoftDeleted(30);
  assert.equal(res.records, 1, '过期的软删记录应被物理删除');
  assert.equal(s.listRecords('u1', { includeDeleted: true }).length, 1);
  await s.close();
});

test('sqlite: file persistence across reopen', async () => {
  const f = `var/__t_${Date.now()}.sqlite`;
  const a = await SqliteStore.open(f);
  a.insertUser(mkUser('persist'));
  await a.close();

  const b = await SqliteStore.open(f);
  assert.equal(b.getUser('persist')?.id, 'persist');
  await b.close();
  const { unlinkSync } = await import('node:fs');
  unlinkSync(f);
});

/** 造一条记录（带默认字段） */
const mkRecord = (id: string, userId: string, over: Partial<RecordRow> = {}): RecordRow => ({
  id,
  userId,
  eat: '菜',
  shop: null,
  shopId: null,
  city: null,
  district: null,
  rating: 5,
  atLocal: '2026-01-01T12:00',
  tzOffset: '+08:00',
  eatenAtUtc: '2026-01-01T04:00:00Z',
  note: null,
  photoIds: [],
  version: 1,
  createdAt: 1,
  updatedAt: 1,
  deletedAt: null,
  shareToken: null,
  sharedAt: null,
  ...over,
});

test('sqlite: countRecords 只数未删除的（登录用它拿 recordCount）', async () => {
  const s = await SqliteStore.open(null);
  s.insertUser(mkUser('u1'));
  s.insertUser(mkUser('u2'));
  s.insertRecord(mkRecord('r1', 'u1'));
  s.insertRecord(mkRecord('r2', 'u1'));
  s.insertRecord(mkRecord('r3', 'u1', { deletedAt: 1 })); // 软删，不该计入
  s.insertRecord(mkRecord('r4', 'u2')); // 别人的，不该计入

  assert.equal(s.countRecords('u1'), 2);
  assert.equal(s.countRecords('u2'), 1);
  assert.equal(s.countRecords('nope'), 0);
  await s.close();
});

test('sqlite: getPhotos 批量取，按传入顺序返回，缺失的跳过', async () => {
  const s = await SqliteStore.open(null);
  s.insertUser(mkUser('u1'));
  const photo = (id: string): PhotoRow => ({
    id,
    userId: 'u1',
    url: `http://x/${id}`,
    photoUrl: `http://x/${id}`,
    thumbUrl: `http://x/${id}`,
    width: 100,
    height: 100,
    size: 10,
    mime: 'image/png',
    status: 'approved',
    createdAt: 1,
    deletedAt: null,
  });
  s.insertPhoto(photo('p1'));
  s.insertPhoto(photo('p2'));

  /* 顺序必须由传入的 id 列表决定（封面 = photos[0]） */
  assert.deepEqual(s.getPhotos(['p2', 'p1']).map((p) => p.id), ['p2', 'p1']);
  /* 缺失的跳过，其余保持顺序 */
  assert.deepEqual(s.getPhotos(['p2', 'nope', 'p1']).map((p) => p.id), ['p2', 'p1']);
  /* 空输入不查库 */
  assert.deepEqual(s.getPhotos([]), []);
  await s.close();
});
