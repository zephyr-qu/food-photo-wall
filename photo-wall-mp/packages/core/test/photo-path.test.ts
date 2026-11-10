import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isLocalFilePath,
  isRemoteUrl,
  isPackagePath,
  photoKind,
} from '../src/photo-path.ts';

/* ---------------- isLocalFilePath ---------------- */

test('isLocalFilePath: saveFile 的 wxfile:// 持久路径算本机文件', () => {
  assert.equal(isLocalFilePath('wxfile://usr/abc123.jpg'), true);
});

test('isLocalFilePath: 开发者工具的 http://tmp/ 临时图算本机文件（不是 remote）', () => {
  assert.equal(isLocalFilePath('http://tmp/3b9f.jpg'), true);
});

test('isLocalFilePath: 真机临时目录 .../temp/xxx.jpg 算本机文件', () => {
  assert.equal(isLocalFilePath('https://usr/temp/xyz.jpg'), true);
  assert.equal(isLocalFilePath('wxfile://temp/xyz.jpg'), true);
});

test('isLocalFilePath: blob / file 协议算本机文件（H5 选图）', () => {
  assert.equal(isLocalFilePath('blob:http://localhost/9f0'), true);
  assert.equal(isLocalFilePath('file:///sdcard/a.jpg'), true);
});

test('isLocalFilePath: 包内静态图、云 URL、空值都不是本机文件', () => {
  assert.equal(isLocalFilePath('/static/img/kaoya.jpg'), false);
  assert.equal(isLocalFilePath('https://cdn.example.com/a.jpg'), false);
  assert.equal(isLocalFilePath(''), false);
  assert.equal(isLocalFilePath(null), false);
  assert.equal(isLocalFilePath(undefined), false);
});

/* ---------------- isRemoteUrl ---------------- */

test('isRemoteUrl: https / http 公网地址是 remote', () => {
  assert.equal(isRemoteUrl('https://cdn.example.com/a.jpg'), true);
  assert.equal(isRemoteUrl('http://cdn.example.com/a.jpg'), true);
});

test('isRemoteUrl: http://tmp/ 不是 remote（是本机临时文件）', () => {
  assert.equal(isRemoteUrl('http://tmp/3b9f.jpg'), false);
});

test('isRemoteUrl: 包内路径与 wxfile 不是 remote', () => {
  assert.equal(isRemoteUrl('/static/img/kaoya.jpg'), false);
  assert.equal(isRemoteUrl('wxfile://usr/a.jpg'), false);
  assert.equal(isRemoteUrl(''), false);
});

/* ---------------- isPackagePath ---------------- */

test('isPackagePath: 必须 / 开头；相对路径不算（会 404，见 records.ts 注释）', () => {
  assert.equal(isPackagePath('/static/img/kaoya.jpg'), true);
  assert.equal(isPackagePath('static/img/kaoya.jpg'), false);
  assert.equal(isPackagePath('https://cdn/a.jpg'), false);
  assert.equal(isPackagePath(null), false);
});

/* ---------------- photoKind ---------------- */

test('photoKind: 四种形态各归其类', () => {
  assert.equal(photoKind('wxfile://usr/a.jpg'), 'local');
  assert.equal(photoKind('https://cdn.example.com/a.jpg'), 'remote');
  assert.equal(photoKind('/static/img/kaoya.jpg'), 'package');
  assert.equal(photoKind('static/img/kaoya.jpg'), 'none');
  assert.equal(photoKind(''), 'none');
  assert.equal(photoKind(null), 'none');
});

test('photoKind: 真实 12 条预置数据的包内图都能认成 package', () => {
  const paths = [
    '/static/img/tiantianmian.jpg',
    '/static/img/kaoya.jpg',
    '/static/img/shengjianbao.jpg',
  ];
  for (const p of paths) {
    assert.equal(photoKind(p), 'package', p);
  }
});
