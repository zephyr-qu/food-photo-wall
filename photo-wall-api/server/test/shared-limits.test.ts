/**
 * 反漂移测试：后端由 gen-data.mjs 生成的常量（FIELD_LIMITS / MAX_PHOTOS /
 * 城市字典 / 预置记录）必须与前端 core 逐字一致。一旦前端改了上限却忘了重跑
 * `npm run gen-data`，本测试在 CI 直接挂，杜绝契约 §3.7 的 422 漂移坑。
 *
 * 前端仓库不在默认路径时（如只跑后端 CI），通过 SKIP_SOURCE_CHECK=1 跳过源码对拍，
 * 只做生成产物的内部不变量校验。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveCoreSrc } from '../src/lib/core-src.js';

const ROOT = resolve(import.meta.dirname, '..');
const SRC = resolveCoreSrc();

function sliceLiteral(text: string, name: string, open: string, close: string): string {
  const declRe = new RegExp(`export\\s+const\\s+${name}\\b[^=]*=\\s*\\${open}`);
  const m = declRe.exec(text);
  if (!m) throw new Error(`找不到 ${name}`);
  const start = m.index + m[0].length - 1;
  let depth = 0;
  let i = start;
  for (; i < text.length; i++) {
    const ch = text[i];
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) break;
    }
  }
  return text.slice(start, i + 1);
}

test('生成产物内部不变量：FIELD_LIMITS / MAX_PHOTOS', async () => {
  const { FIELD_LIMITS, MAX_PHOTOS, FIELD_LABELS } = await import('../src/data/shared-limits.js');
  assert.equal(MAX_PHOTOS, 5);
  const expect = { eat: 60, shop: 80, city: 40, district: 40, note: 200 };
  assert.deepEqual({ ...FIELD_LIMITS }, expect);
  for (const k of Object.keys(expect)) {
    assert.ok(k in FIELD_LABELS, `FIELD_LABELS 缺键 ${k}`);
  }
});

test('gen-data 输出与前端 core 单一真源逐字一致', { skip: process.env.SKIP_SOURCE_CHECK === '1' ? '源不可达' : false }, async () => {
  const recordsTs = resolve(SRC, 'records.ts');
  const geoTs = resolve(SRC, 'geo.ts');
  if (!existsSync(recordsTs) || !existsSync(geoTs)) {
    test.skip(`前端源码不在 ${SRC}（设 PHOTO_WALL_SRC 或 SKIP_SOURCE_CHECK=1 跳过）`);
    return;
  }

  const recText = readFileSync(recordsTs, 'utf8');
  const geoText = readFileSync(geoTs, 'utf8');

  // 前端常量
  const fieldLimits = new Function(`return (${sliceLiteral(recText, 'FIELD_LIMITS', '{', '}')});`)();
  const fieldLabels = new Function(`return (${sliceLiteral(recText, 'FIELD_LABELS', '{', '}')});`)();
  const maxPhotos = Number(/export\s+const\s+MAX_PHOTOS\s*=\s*(\d+)/.exec(recText)?.[1]);
  const cityProvince = new Function(`return (${sliceLiteral(geoText, 'CITY_PROVINCE', '{', '}')});`)();

  // 后端生成产物
  const gen = await import('../src/data/shared-limits.js');
  const geo = await import('../src/data/geo-cities.js');
  const seed = await import('../src/data/seed-records.js');

  assert.deepEqual({ ...gen.FIELD_LIMITS }, { ...fieldLimits }, 'FIELD_LIMITS 与前端不一致，重跑 npm run gen-data');
  assert.deepEqual({ ...gen.FIELD_LABELS }, { ...fieldLabels }, 'FIELD_LABELS 与前端不一致，重跑 npm run gen-data');
  assert.equal(gen.MAX_PHOTOS, maxPhotos, 'MAX_PHOTOS 与前端不一致，重跑 npm run gen-data');
  assert.deepEqual({ ...geo.CITY_PROVINCE }, { ...cityProvince }, '城市字典漂移，重跑 npm run gen-data');
  assert.equal(seed.SEED_RECORDS.length, 12, '预置记录数漂移');
});
