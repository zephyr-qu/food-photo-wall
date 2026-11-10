/* ================================================================
   种子数据生成器：从 packages/core 的 TS 源码抽出纯数据，落成 ESM 模块。

   为什么不在运行时 import core 的 .ts：
   Node 直接跑 .ts 需要 --experimental-strip-types 之类的开关，
   而且 core 的模块互相 import 带 .ts 后缀，在 mock server 里不稳。
   契约要求「数据必须与前端逐字一致」，所以用一次性生成 + 提交产物：
   改了 core 的数据，重跑 `node server/scripts/gen-seed-data.mjs` 即可。

   只读 packages/core，只写 server/src/data/。
   ================================================================ */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const CORE = resolve(ROOT, 'packages/core/src');
const OUT = resolve(HERE, '../src/data');

mkdirSync(OUT, { recursive: true });

/** 取 `export const NAME ... = [ ... ];` 之间的正文（按行扫描，避免正则贪婪） */
function sliceBlock(source, startMarker) {
  const start = source.indexOf(startMarker);
  if (start < 0) throw new Error(`找不到起始标记: ${startMarker}`);
  const bodyStart = source.indexOf('\n', start) + 1;
  // 从 bodyStart 开始找第一个「顶格」的 `];` / `};`
  const rest = source.slice(bodyStart);
  const m = /\n(\]|\});/.exec(rest);
  if (!m) throw new Error(`找不到结束标记: ${startMarker}`);
  return rest.slice(0, m.index);
}

/** TS 对象字面量 → JSON。
 *  分三步走，避免正则误伤字符串内容：
 *  ① 单引号串先换成占位符（内容不参与后续替换）
 *  ② 未加引号的 key 补引号（支持中文 key，行首也算）
 *  ③ 占位符还原成 JSON 双引号串
 */
function literalToJson(text) {
  const strings = [];
  let out = text
    .replace(/\/\*[\s\S]*?\*\//g, '') // 块注释
    .replace(/\/\/[^\n]*/g, '') // 行注释
    .replace(/'((?:[^'\\]|\\.)*)'/g, (_, s) => {
      strings.push(s);
      return `\uE000${strings.length - 1}\uE000`;
    });

  out = out
    .replace(/([{,]|^)(\s*)([^\s:'"{}[\],\uE000]+)\s*:/gm, '$1$2"$3":') // key 补引号
    .replace(/,(\s*[}\]])/g, '$1') // 块内尾逗号
    .replace(/,\s*$/, ''); // 块末尾（闭合括号已被 slice 掉）的尾逗号

  return out.replace(/\uE000(\d+)\uE000/g, (_, i) => JSON.stringify(strings[Number(i)]));
}

/* ---------------- 1. REAL_RECORDS ----------------
   REAL_RECORDS 已从 records.ts 挪到 demo.ts（让 records.ts 只做纯函数，不夹带示例数据）。
   这里优先读 demo.ts，找不到再回退 records.ts，避免改位置后脚本报错。 */
const recordsFile = ['demo.ts', 'records.ts'].find((f) =>
  readFileSync(resolve(CORE, f), 'utf8').includes('export const REAL_RECORDS'),
);
if (!recordsFile) throw new Error('找不到 REAL_RECORDS 所在文件（demo.ts / records.ts）');
const recordsSrc = readFileSync(resolve(CORE, recordsFile), 'utf8');
const recordsBlock = sliceBlock(recordsSrc, 'export const REAL_RECORDS');
const REAL_RECORDS = JSON.parse(`[${literalToJson(recordsBlock)}]`);

/* ---------------- 2. CITY_PROVINCE ---------------- */
const geoSrc = readFileSync(resolve(CORE, 'geo.ts'), 'utf8');
const geoBlock = sliceBlock(geoSrc, 'export const CITY_PROVINCE');
const CITY_DISTRICTS_BLOCK = sliceBlock(geoSrc, 'export const CITY_DISTRICTS');
const CITY_PROVINCE = JSON.parse(`{${literalToJson(geoBlock)}}`);
const CITY_DISTRICTS = JSON.parse(`{${literalToJson(CITY_DISTRICTS_BLOCK)}}`);

/* ---------------- 校验规模（与文档附录 A 对齐） ---------------- */
const cityCount = Object.keys(CITY_PROVINCE).length;
const provinceCount = new Set(Object.values(CITY_PROVINCE)).size;
if (REAL_RECORDS.length !== 12) throw new Error(`REAL_RECORDS 应为 12 条，实际 ${REAL_RECORDS.length}`);
if (cityCount !== 208) throw new Error(`CITY_PROVINCE 应为 208 城，实际 ${cityCount}`);
if (provinceCount !== 34) throw new Error(`CITY_PROVINCE 应为 34 省，实际 ${provinceCount}`);
// CITY_DISTRICTS 必须覆盖全部 CITY_PROVINCE 城市
for (const c of Object.keys(CITY_PROVINCE)) {
  if (!(c in CITY_DISTRICTS)) throw new Error(`CITY_DISTRICTS 缺城市 ${c}`);
}

const BANNER = `/* ================================================================
   ⚠ 自动生成，勿手改。
   来源：packages/core/src/${'{file}'}
   生成：node server/scripts/gen-seed-data.mjs
   与前端逐字一致是硬要求（契约 §2.4），改数据请改 core 源文件后重跑脚本。
   ================================================================ */`;

/* 按省分组输出，便于人工 diff；键顺序 = core 里的书写顺序 */
function geoLiteral() {
  const groups = [];
  for (const [city, province] of Object.entries(CITY_PROVINCE)) {
    let g = groups.find((x) => x.province === province);
    if (!g) {
      g = { province, cities: [] };
      groups.push(g);
    }
    g.cities.push(city);
  }
  const lines = groups.map(
    (g) => `  /* ${g.province} */\n${g.cities.map((c) => `  ${c}: '${g.province}',`).join('\n')}`,
  );
  return lines.join('\n\n');
}

writeFileSync(
  resolve(OUT, 'records.js'),
  `${BANNER.replace('{file}', recordsFile)}

/** 12 条真实记录（逐字保留；photo 一律 null = 用包内预置图） */
export const REAL_RECORDS = ${JSON.stringify(REAL_RECORDS, null, 2)
    .replace(/"([A-Za-z_$][\w$]*)":/g, '$1:')
    .replace(/"/g, "'")};
`,
  'utf8',
);

writeFileSync(
  resolve(OUT, 'geo.js'),
  `${BANNER.replace('{file}', 'geo.ts')}

/** 表外城市归「其他」 */
export const OTHER_PROVINCE = '其他';

/** 常见城市 → 省/直辖市（${cityCount} 城 / ${provinceCount} 省）。表外城市走「其他」。 */
export const CITY_PROVINCE = {
${geoLiteral()}
};

/** 「厦门市」「闽侯县」这类带行政后缀的写法：去掉后缀再查一次 */
const ADMIN_SUFFIX = /(特别行政区|自治区|自治州|地区|省|市|县|区)$/u;

/** 城市 → 省；表外/空 → null（对齐 core/geo.ts:107-115） */
export function provinceOf(city) {
  const raw = (city ?? '').trim();
  if (!raw) return null;
  const direct = CITY_PROVINCE[raw];
  if (direct) return direct;
  const bare = raw.replace(ADMIN_SUFFIX, '');
  if (bare && bare !== raw) return CITY_PROVINCE[bare] ?? null;
  return null;
}

/** 码点序（不依赖 ICU，三端一致；对齐 core/geo.ts:131） */
export const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** 全量字典：省按码点序、省内城市按码点序（对齐 core/geo.ts:165-178） */
export function provinceCatalogue() {
  const groups = new Map();
  for (const [city, province] of Object.entries(CITY_PROVINCE)) {
    let g = groups.get(province);
    if (!g) {
      g = { province, cities: [] };
      groups.set(province, g);
    }
    g.cities.push(city);
  }
  const list = [...groups.values()];
  for (const g of list) g.cities.sort(byName);
  list.sort((a, b) => byName(a.province, b.province));
  return list;
}

/** 城市 → 区/县[]（三级选择最细一级，与前端逐字一致）。
 *  未收录 / 无更细粒度的城市（香港 / 澳门 / 长白山 / 曼谷 …）值为空数组。 */
export const CITY_DISTRICTS = ${JSON.stringify(CITY_DISTRICTS, null, 2)
    .replace(/"([A-Za-z_$][\w$]*)":/g, '$1:')
    .replace(/"/g, "'")};

/**
 * 给定城市返回可选区/县列表（与前端 core districtsOf 口径一致）：
 * 未选 / 表外 / 无更细粒度 / 只有一个「自己」的直筒子市，都返回 []。
 */
export function districtsOf(city) {
  if (!city) return [];
  const list = CITY_DISTRICTS[city];
  if (!list || list.length === 0) return [];
  const bare = city.replace(ADMIN_SUFFIX, '');
  if (list.length === 1 && list[0].replace(ADMIN_SUFFIX, '') === bare) return [];
  return list;
}
`,
  'utf8',
);

console.log(
  `✓ records.js: ${REAL_RECORDS.length} 条；geo.js: ${cityCount} 城 / ${provinceCount} 省`,
);
