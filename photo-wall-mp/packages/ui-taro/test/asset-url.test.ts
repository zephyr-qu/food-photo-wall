/* ================================================================
   预置图外链的形状（P0）—— 前端这一半。

   `src/utils/asset.ts` 与后端 `/v1/files/:name` 是一对：设了
   TARO_APP_ASSET_BASE 后，前端把 `/static/img/kaoya.jpg` 拍平成
   `<base>/kaoya.jpg`（单段文件名），后端就得能吃单段文件名。
   以前后端只认 `pho_*` 上传文件，于是「本地指 mock、发布指真后端」时
   12 张预置菜图 + 2 张分享封面全部 404，而本地永远复现不出来。

   两边各钉一半：
     · 这里 —— 前端拼出来的 URL 形状（扁平、无 /static/img 前缀、无重复斜杠）；
     · photo-wall-api/server/test/system-files.test.ts —— 后端能取到那些文件。

   asset.ts 在模块加载时读 env，所以先写 env 再动态 import（本文件独立进程）。
   ================================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.TARO_APP_ASSET_BASE = 'http://127.0.0.1:8787/v1/files///';
const { resolveAssetUrl, ASSET_CDN_ENABLED } = await import('../src/utils/asset.ts');

const BASE = 'http://127.0.0.1:8787/v1/files';

test('ASSET_CDN_ENABLED 为真，且末尾多余的斜杠被吃掉（不拼出 //）', () => {
  assert.equal(ASSET_CDN_ENABLED, true);
  assert.equal(resolveAssetUrl('/static/img/kaoya.jpg'), `${BASE}/kaoya.jpg`);
});

test('12 张预置菜图 + 2 张分享封面：都是 `<base>/<文件名>` 形态', () => {
  for (const file of [
    'bingfen.jpg',
    'boboboji.jpg',
    'danhonggao.jpg',
    'douzhier.jpg',
    'fanqieniunan.jpg',
    'kaoya.jpg',
    'qiaojiaoniurou.jpg',
    'reganmian.jpg',
    'shachamian.jpg',
    'shengjianbao.jpg',
    'tangyoubaba.jpg',
    'tiantianmian.jpg',
    'share-cover.jpg',
    'share-timeline.jpg',
  ]) {
    const out = resolveAssetUrl(`/static/img/${file}`);
    /* 单段文件名：不能残留 /static/img/，否则后端 NAME_RE 直接 404 */
    assert.equal(out, `${BASE}/${file}`);
    assert.ok(!out.includes('/static/'), `${file} 不该带 /static/ 前缀：${out}`);
  }
});

test('png 图标（camera/dice）留在包内，不走远端', () => {
  assert.equal(resolveAssetUrl('/static/img/camera.png'), '/static/img/camera.png');
  assert.equal(resolveAssetUrl('/static/img/dice.png'), '/static/img/dice.png');
});

test('非包内路径一律原样返回（http(s) / 本机临时文件 / 空值）', () => {
  for (const p of [
    'https://cdn.example.com/photo-wall/kaoya.jpg',
    'wxfile://tmp_abc.jpg',
    '/var/tmp/photo.jpg',
    '',
  ]) {
    assert.equal(resolveAssetUrl(p), p);
  }
});
