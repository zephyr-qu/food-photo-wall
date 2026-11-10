/* ================================================================
   照片上传（契约 §6.5 / 验收 AC-28~AC-31、D-14、D-15）
   零依赖手写 multipart：这里同时验证解析器本身。
   ================================================================ */
/* global Buffer, fetch */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  api,
  createRecord,
  loginFresh,
  multipartBody,
  resetStore,
  tinyJpeg,
  tinyPng,
  uploadPhoto,
  withServer,
} from './helpers.js';

let srv;
let request;
let token;

before(async () => {
  srv = await withServer();
  request = api(srv.url);
});

after(() => srv.close());

beforeEach(async () => {
  resetStore({ seedNewUsers: false });
  ({ token } = await loginFresh(srv.url, `photo-${Math.random().toString(36).slice(2)}`));
});

describe('AC-28 正常上传', () => {
  it('201；返回三个 URL + 尺寸 + approved；字节能被 GET 取回且 Content-Type 正确', async () => {
    const jpeg = tinyJpeg();
    const res = await uploadPhoto(srv.url, token, jpeg, { filename: 'IMG_0001.jpg' });
    assert.equal(res.status, 201, JSON.stringify(res.body));

    const body = res.body;
    assert.match(body.photoId, /^pho_/);
    assert.ok(body.url && body.photo && body.photoThumb);
    for (const u of [body.url, body.photo, body.photoThumb]) {
      assert.match(u, /^http:\/\/.+\/v1\/files\//);
    }
    assert.equal(body.size, jpeg.length);
    assert.equal(body.mime, 'image/jpeg');
    assert.equal(body.status, 'approved');
    assert.ok(body.createdAt);
    // 尺寸能读出来（1x1 的测试图）
    assert.equal(body.width, 1);
    assert.equal(body.height, 1);

    // 三个 URL 都能匿名取回，且 Content-Type 正确
    const main = await fetch(body.photo);
    assert.equal(main.status, 200);
    assert.equal(main.headers.get('content-type'), 'image/jpeg');
    const bytes = Buffer.from(await main.arrayBuffer());
    assert.deepEqual(bytes, jpeg, '取回的字节必须与上传的一致');

    const thumb = await fetch(body.photoThumb);
    assert.equal(thumb.status, 200);
    assert.equal(thumb.headers.get('content-type'), 'image/jpeg');

    const orig = await fetch(body.url);
    assert.equal(orig.status, 200);
    assert.equal(orig.headers.get('content-type'), 'image/jpeg');
  });

  it('PNG 上传：mime/尺寸正确，回读 Content-Type 为 image/png', async () => {
    const png = tinyPng(120, 90);
    const res = await uploadPhoto(srv.url, token, png, {
      filename: 'a.png',
      contentType: 'image/png',
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.mime, 'image/png');
    assert.equal(res.body.width, 120);
    assert.equal(res.body.height, 90);

    const got = await fetch(res.body.photo);
    assert.equal(got.status, 200);
    assert.equal(got.headers.get('content-type'), 'image/png');
  });
});

describe('AC-29 图片限制', () => {
  it('11 MiB → 413 FILE_TOO_LARGE', async () => {
    const big = Buffer.concat([tinyJpeg(), Buffer.alloc(11 * 1024 * 1024, 0)]);
    const res = await uploadPhoto(srv.url, token, big, { filename: 'big.jpg' });
    assert.equal(res.status, 413, JSON.stringify(res.body));
    assert.equal(res.body.error.code, 'FILE_TOO_LARGE');
  });

  it('gif / pdf → 415 UNSUPPORTED_MEDIA_TYPE（按魔数判断，不信扩展名）', async () => {
    const gif = Buffer.from('GIF89a' + '\0'.repeat(100), 'latin1');
    const gifRes = await uploadPhoto(srv.url, token, gif, { filename: 'a.gif', contentType: 'image/gif' });
    assert.equal(gifRes.status, 415);
    assert.equal(gifRes.body.error.code, 'UNSUPPORTED_MEDIA_TYPE');

    // 扩展名伪装成 .jpg 也要被拒
    const disguised = await uploadPhoto(srv.url, token, gif, {
      filename: 'a.jpg',
      contentType: 'image/jpeg',
    });
    assert.equal(disguised.status, 415, '不能只看扩展名/Content-Type');

    const pdf = Buffer.from('%PDF-1.4\n' + 'x'.repeat(100), 'latin1');
    const pdfRes = await uploadPhoto(srv.url, token, pdf, { filename: 'a.pdf', contentType: 'application/pdf' });
    assert.equal(pdfRes.status, 415);
  });

  it('无 file 字段 → 422 VALIDATION_FAILED', async () => {
    const { boundary, body } = multipartBody(Buffer.from('x'), { fieldName: 'notfile' });
    const res = await fetch(`${srv.url}/v1/photos`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body,
    });
    assert.equal(res.status, 422);
    assert.equal((await res.json()).error.code, 'VALIDATION_FAILED');
  });

  it('非 multipart 请求 → 415', async () => {
    const res = await request('POST', '/v1/photos', {
      token,
      body: { fake: true },
    });
    assert.equal(res.status, 415);
  });
});

describe('AC-30 内容安全（mock 审核开关）', () => {
  it('X-Mock-Reject-Image: 1 → 422 IMAGE_REJECTED', async () => {
    const res = await uploadPhoto(srv.url, token, tinyJpeg(), {
      headers: { 'X-Mock-Reject-Image': '1' },
    });
    assert.equal(res.status, 422);
    assert.equal(res.body.error.code, 'IMAGE_REJECTED');
  });
});

describe('AC-18 / AC-31 照片与记录关联', () => {
  it('上传后写进记录：photo/photoThumb/photoId 都被回填', async () => {
    const up = await uploadPhoto(srv.url, token, tinyJpeg());
    assert.equal(up.status, 201);

    const { status, body } = await createRecord(srv.url, token, {
      eat: '有图的',
      photoId: up.body.photoId,
    });
    assert.equal(status, 201);
    assert.equal(body.photoId, up.body.photoId);
    assert.equal(body.photo, up.body.photo);
    assert.equal(body.photoThumb, up.body.photoThumb);
  });

  it('PATCH photoId 换图；photoId: null 清除回预置图', async () => {
    const a = await uploadPhoto(srv.url, token, tinyJpeg());
    const b = await uploadPhoto(srv.url, token, tinyJpeg());
    const created = await createRecord(srv.url, token, { eat: '换图', photoId: a.body.photoId });

    const swapped = await request('PATCH', `/v1/records/${created.body.id}`, {
      token,
      body: { photoId: b.body.photoId },
    });
    assert.equal(swapped.status, 200);
    assert.equal(swapped.body.photoId, b.body.photoId);
    assert.equal(swapped.body.photo, b.body.photo);

    const cleared = await request('PATCH', `/v1/records/${created.body.id}`, {
      token,
      body: { photoId: null },
    });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.photoId, null);
    assert.equal(cleared.body.photo, null);
    assert.equal(cleared.body.photoThumb, null);
  });

  it('引用不存在的 photoId / 别人的 photoId → 422 fields.photoId', async () => {
    const missing = await createRecord(srv.url, token, { eat: 'x', photoId: 'pho_nope' });
    assert.equal(missing.status, 422);
    assert.ok(missing.body.error.fields.photoId);

    const other = await loginFresh(srv.url, 'photo-other-user');
    const theirs = await uploadPhoto(srv.url, other.token, tinyJpeg());
    const stolen = await createRecord(srv.url, token, { eat: 'x', photoId: theirs.body.photoId });
    assert.equal(stolen.status, 422, '不能引用别人的照片');
    assert.ok(stolen.body.error.fields.photoId);
  });

  it('照片被记录引用时 DELETE /photos/{id} → 409 PHOTO_IN_USE', async () => {
    const up = await uploadPhoto(srv.url, token, tinyJpeg());
    const created = await createRecord(srv.url, token, { eat: '占用', photoId: up.body.photoId });

    const inUse = await request('DELETE', `/v1/photos/${up.body.photoId}`, { token });
    assert.equal(inUse.status, 409);
    assert.equal(inUse.body.error.code, 'PHOTO_IN_USE');

    // 删掉记录后即可删除照片
    await request('DELETE', `/v1/records/${created.body.id}`, { token });
    const ok = await request('DELETE', `/v1/photos/${up.body.photoId}`, { token });
    assert.equal(ok.status, 204);
  });
});
