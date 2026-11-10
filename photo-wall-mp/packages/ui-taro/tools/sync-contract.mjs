/* ================================================================
   契约快照同步（P1-9 CI 门禁的一部分）

   契约的真源在兄弟仓库 `photo-wall-api/docs/api/openapi.yaml`；
   但它不在本仓库里，CI 检出本仓库时拿不到 —— 于是把一份快照
   vendor 到 `test/fixtures/openapi.yaml`，契约测试按优先级查找：

     1. `CONTRACT_OPENAPI` 环境变量（显式指定）
     2. 兄弟仓库的真源（本地开发，永远最新）
     3. `test/fixtures/openapi.yaml`（CI / 独立检出）

   契约变更后在本仓跑一次 `npm run sync:contract` 更新快照。
   ================================================================ */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(HERE, '..');
const SRC =
  process.env.CONTRACT_OPENAPI ??
  resolve(PKG, '..', '..', '..', 'photo-wall-api', 'docs', 'api', 'openapi.yaml');
const DST = join(PKG, 'test', 'fixtures', 'openapi.yaml');

if (!existsSync(SRC)) {
  console.error(`[contract] 找不到真源：${SRC}`);
  console.error('[contract] 用 CONTRACT_OPENAPI=<path> 指定，或在含 photo-wall-api 的目录布局下运行');
  process.exit(1);
}
mkdirSync(dirname(DST), { recursive: true });
copyFileSync(SRC, DST);
console.log(`[contract] 已同步 ${SRC} -> ${DST}`);
