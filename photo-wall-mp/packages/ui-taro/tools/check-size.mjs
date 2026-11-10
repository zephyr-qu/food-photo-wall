/* ================================================================
   主包体积门禁（P1-8 / P1-9）

   微信小程序主包上限 2 MiB（2,097,152 B），超了直接拒绝上传。
   这里在构建后量一次 `dist/`，超过预算就让 CI 变红：
     · 默认 FAIL 1,650,000 B（留 ~430 KB 余量给后续迭代）
     · 默认 WARN 1,450,000 B
   可用 SIZE_FAIL_BYTES / SIZE_WARN_BYTES 覆盖。

   同时打印 static/ 占比 —— 它是最容易被忽视、也最容易一次性搬走的部分
   （配置 TARO_APP_ASSET_BASE 后 static 会从产物里消失）。

   用法：npm run size（跑之前先 npm run build:weapp）
   ================================================================ */
import { readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = dirname(dirname(fileURLToPath(import.meta.url))); // tools/ 的上一级
const DIST = join(PKG, 'dist');

const FAIL_BYTES = Number(process.env.SIZE_FAIL_BYTES ?? 1_650_000);
const WARN_BYTES = Number(process.env.SIZE_WARN_BYTES ?? 1_450_000);

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else out.push({ path: p.slice(DIST.length + 1).replace(/\\/g, '/'), size: st.size });
  }
  return out;
}

const human = (n) => `${(n / 1024).toFixed(1)} KB`;

if (!statSync(DIST, { throwIfNoEntry: false })) {
  console.error(`[size] 找不到 ${DIST}，先跑 npm run build:weapp`);
  process.exit(1);
}

const files = walk(DIST);
const total = files.reduce((s, f) => s + f.size, 0);
const staticBytes = files
  .filter((f) => f.path.startsWith('static/'))
  .reduce((s, f) => s + f.size, 0);
const codeBytes = total - staticBytes;

const pct = (n) => `${((n / total) * 100).toFixed(1)}%`;
console.log(`[size] 主包 ${human(total)}（${total} B）= 微信上限的 ${((total / 2097152) * 100).toFixed(1)}%`);
console.log(`[size]   static/ ${human(staticBytes)}（${pct(staticBytes)}）  code ${human(codeBytes)}（${pct(codeBytes)}）`);
console.log(`[size] 预算 warn=${human(WARN_BYTES)} / fail=${human(FAIL_BYTES)}`);

/* 找出最大的几个文件，超预算时便于定位 */
const top = [...files].sort((a, b) => b.size - a.size).slice(0, 8);
if (total > WARN_BYTES) {
  console.log('[size] 最大的文件：');
  for (const f of top) console.log(`[size]   ${f.path}  ${human(f.size)}`);
}

if (total > FAIL_BYTES) {
  console.error(`[size] ✗ 主包超预算：${total} > ${FAIL_BYTES}`);
  console.error('[size]   优先考虑：TARO_APP_ASSET_BASE 把静态图搬 CDN / 压缩预置图 / 分包');
  process.exit(1);
}
if (total > WARN_BYTES) {
  console.warn(`[size] ⚠ 主包接近预算：${total}（warn ${WARN_BYTES}）`);
}
console.log('[size] ✓ 通过');
