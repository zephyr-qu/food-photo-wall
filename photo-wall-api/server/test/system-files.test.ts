/**
 * 预置图托管回归（P0）：`/v1/files/:name` 必须能服务预置菜品图。
 *
 * 背景：前端 `packages/ui-taro/src/utils/asset.ts` 的 resolveAssetUrl() 在设了
 * TARO_APP_ASSET_BASE 时，会把 `/static/img/kaoya.jpg` 拍平成 `<base>/kaoya.jpg`
 * 发出去（主包体积因此只有 472.7 KB）。本服务原先的 `/files/:name` 只认
 * `pho_*` 上传文件，于是「ASSET_BASE 指向真后端」时这 12 张预置图 + 2 张分享
 * 封面全部 404 —— 只在发布构建才炸，本地（指向 mock）永远看不到。
 *
 * 预置图目录不存在时跳过（CI 里 photo-wall-mp 是嵌套仓库，可能没 checkout）：
 * 这个用例验证的是「有资源就该给」，不是「资源必须存在」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolvePresetAssetDir } from '../src/lib/preset-assets.js';
import { call, makeApp } from './helpers.js';

const presetDir = resolvePresetAssetDir();
const available = !process.env.SKIP_SOURCE_CHECK && presetDir !== null;
const skip = available ? false : '预置图目录不存在（见 src/lib/preset-assets.ts 的候选顺序）';

/* 图片是二进制：走 app.request 取 arrayBuffer，别用 call()（它按文本读，会毁掉字节） */
async function getBytes(app: Awaited<ReturnType<typeof makeApp>>['app'], path: string) {
  const res = await app.request(path);
  return { status: res.status, headers: res.headers, bytes: Buffer.from(await res.arrayBuffer()) };
}

test('预置图：扁平名 `/v1/files/kaoya.jpg` 可访问且是真 JPEG', { skip }, async (t) => {
  const { app, close } = await makeApp();
  t.after(close);

  const res = await getBytes(app, '/v1/files/kaoya.jpg');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/jpeg');
  /* 不可变缓存：预置图永远不会变，重复请求不该回源 */
  assert.match(res.headers.get('cache-control') ?? '', /immutable/);
  assert.ok(res.bytes.length > 1000, `响应体必须是一张真图，实际 ${res.bytes.length} 字节`);
  assert.deepEqual([...res.bytes.subarray(0, 2)], [0xff, 0xd8], '必须 JPEG 魔数，而不是 404 页面');
});

test('预置图：带前缀 `/v1/files/static/img/kaoya.jpg` 同样成立（对齐 mock）', { skip }, async (t) => {
  const { app, close } = await makeApp();
  t.after(close);

  const flat = await getBytes(app, '/v1/files/kaoya.jpg');
  const prefixed = await getBytes(app, '/v1/files/static/img/kaoya.jpg');
  assert.equal(prefixed.status, 200);
  assert.equal(prefixed.headers.get('content-type'), 'image/jpeg');
  assert.equal(prefixed.bytes.length, flat.bytes.length, '两种形态必须是同一份字节');
});

test('预置图：非法文件名一律 404（不泄露目录、不允许路径穿越）', { skip }, async (t) => {
  const { app, close } = await makeApp();
  t.after(close);

  const bad = [
    '/v1/files/..%2Fpackage.json',
    '/v1/files/%2E%2E%2F%2E%2E%2Fetc%2Fpasswd',
    '/v1/files/kaoya.txt',
    '/v1/files/.env',
    '/v1/files/pho_x.exe',
    '/v1/files/%2E%2E',
  ];
  for (const path of bad) {
    const res = await call(app, path);
    assert.equal(res.status, 404, `${path} 必须 404，实际 ${res.status}`);
  }
});

test('预置图：PRESET_ASSET_DIR 指错时明确退化为 null（不静默指向别处）', () => {
  const prev = process.env.PRESET_ASSET_DIR;
  process.env.PRESET_ASSET_DIR = 'var/definitely-not-here';
  try {
    assert.equal(resolvePresetAssetDir(), null);
  } finally {
    if (prev === undefined) delete process.env.PRESET_ASSET_DIR;
    else process.env.PRESET_ASSET_DIR = prev;
  }
});

test('上传文件仍走 storageDir：预置图目录里没有的 `pho_*` 名字返回 404', { skip }, async (t) => {
  const { app, close } = await makeApp();
  t.after(close);

  const res = await call(app, '/v1/files/pho_missing.jpg');
  assert.equal(res.status, 404);
});
