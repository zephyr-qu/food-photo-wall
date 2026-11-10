/**
 * 从只读源码（同级 workspace 的 photo-wall-mp/packages/core/src）抽取四份数据：
 *   1. CITY_PROVINCE  208 城 / 34 省  → src/data/geo-cities.ts
 *   2. CITY_DISTRICTS 城市 → 区/县     → src/data/geo-cities.ts（含 districtsOf 助手）
 *   3. REAL_RECORDS   12 条预置记录   → src/data/seed-records.ts
 *   4. FIELD_LIMITS / FIELD_LABELS / MAX_PHOTOS → src/data/shared-limits.ts
 *
 * 目的：后端这些"会与前端各写一份、漂移就出 bug"的常量，由**前端 core**
 * 这个唯一事实来源生成，后端只引用生成产物、不再手抄。改一处只在前端改，
 * 重跑 gen-data 即同步；残留的手写双份（FIELD_LIMITS / MAX_PHOTOS）从后端
 * 常量里移除，消除契约 §3.7 记的 422 漂移坑。
 * 运行：node scripts/gen-data.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * 前端 core 源码目录 —— 复用 src/lib/core-src.ts 的探测逻辑（编译产物在
 * ../dist/src/lib/core-src.js）。
 *
 * 为什么不写死绝对路径（教训）：
 *   早期版本把源码位置写死在某台机器的绝对路径下，工作区一旦整体搬迁
 *   （换目录 / 换电脑 / CI 里 clone 到别处），那条路径直接失效，
 *   而症状是「找不到常量」——离真正原因（整块目录被搬了）很远。
 */
async function resolveCoreSrc() {
  try {
    const mod = await import('../dist/src/lib/core-src.js');
    return mod.resolveCoreSrc();
  } catch {
    /* dist 还没构建：退回本地探测 */
    const { existsSync } = await import('node:fs');
    const { dirname, join, resolve: r } = await import('node:path');
    const here = dirname(import.meta.filename ?? import.meta.dirname);
    const candidates = [
      r(here, '..', '..', '..', 'photo-wall-mp', 'packages', 'core', 'src'),
    ];
    for (const c of candidates) {
      if (existsSync(join(c, 'geo.ts'))) return c;
    }
    return candidates[0];
  }
}

const SRC = await resolveCoreSrc();
const OUT = resolve(import.meta.dirname, '../src/data');
mkdirSync(OUT, { recursive: true });

/** 从文本里截取 `export const NAME ... = <literal>;` 的 literal 源码 */
function sliceLiteral(text, name, open, close) {
  const declRe = new RegExp(`export\\s+const\\s+${name}\\b[^=]*=\\s*\\${open}`);
  const m = declRe.exec(text);
  if (!m) throw new Error(`找不到 ${name}`);
  const start = m.index + m[0].length - 1; // 指向 open 字符
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
  if (depth !== 0) throw new Error(`${name} 括号未闭合`);
  return text.slice(start, i + 1);
}

const geoText = readFileSync(resolve(SRC, 'geo.ts'), 'utf8');

/**
 * REAL_RECORDS 在哪个文件 —— 两个布局都兼容。
 *
 * 背景：core 重构后，预置记录从 `records.ts` 搬到了 `demo.ts`
 * （`records.ts` 只留纯逻辑，演示数据单独成文件）。
 * 写死 `records.ts` 的话，gen-data 会报"找不到 REAL_RECORDS"——
 * 症状离真正原因（文件搬家了）很远，所以这里按序探测。
 */
function findRecordsFile() {
  for (const f of ['demo.ts', 'records.ts']) {
    const p = resolve(SRC, f);
    if (existsSync(p) && readFileSync(p, 'utf8').includes('REAL_RECORDS')) return p;
  }
  throw new Error(
    `在 ${SRC} 下既没找到 demo.ts 也没找到 records.ts 里的 REAL_RECORDS\n` +
      `  （core 的预置记录文件可能又改名了 —— 检查 packages/core/src/）`,
  );
}

const recText = readFileSync(findRecordsFile(), 'utf8');

const cityProvinceLit = sliceLiteral(geoText, 'CITY_PROVINCE', '{', '}');
const cityDistrictsLit = sliceLiteral(geoText, 'CITY_DISTRICTS', '{', '}');
const recordsLit = sliceLiteral(recText, 'REAL_RECORDS', '[', ']');

// 字面量是合法 JS（中文标识符 + 字符串 + null），可直接求值
const cityProvince = new Function(`return (${cityProvinceLit});`)();
const cityDistricts = new Function(`return (${cityDistrictsLit});`)();
const records = new Function(`return (${recordsLit});`)();

// ---- 校验：与文档口径一致 ----
const cities = Object.keys(cityProvince);
const provinces = [...new Set(Object.values(cityProvince))];
if (cities.length !== 208) throw new Error(`城市数 ${cities.length} != 208`);
if (provinces.length !== 34) throw new Error(`省数 ${provinces.length} != 34`);
if (cityProvince['景德镇'] !== '江西') throw new Error('景德镇 应归 江西');
// CITY_DISTRICTS 必须覆盖全部 CITY_PROVINCE 城市（不允许静默漏掉）
for (const c of cities) {
  if (!(c in cityDistricts)) throw new Error(`CITY_DISTRICTS 缺城市 ${c}`);
}
if (records.length !== 12) throw new Error(`预置记录 ${records.length} != 12`);

const ratingSum = records.reduce((s, r) => s + r.rating, 0);
const five = records.filter((r) => r.rating === 5).length;
const citySet = new Set(records.map((r) => r.city).filter(Boolean));
const shopSet = new Set(records.map((r) => r.shop).filter(Boolean));
const expect = { ratingSum: 53, five: 7, cities: 7, shops: 10 };
if (ratingSum !== expect.ratingSum) throw new Error(`评分和 ${ratingSum}`);
if (five !== expect.five) throw new Error(`五分 ${five}`);
if (citySet.size !== expect.cities) throw new Error(`城市 ${citySet.size}`);
if (shopSet.size !== expect.shops) throw new Error(`店铺 ${shopSet.size}`);

// ---- 生成 geo-cities.ts ----
const provMap = new Map();
for (const [city, province] of Object.entries(cityProvince)) {
  if (!provMap.has(province)) provMap.set(province, []);
  provMap.get(province).push(city);
}
const geoOut = `/* 由 scripts/gen-data.mjs 从 packages/core/src/geo.ts 生成，请勿手改。 */
export const GEO_VERSION = '2026-10-01';
export const GEO_UPDATED_AT = '2026-10-01T00:00:00Z';
export const OTHER_PROVINCE = '其他';

/** 城市 → 省/直辖市（208 城 / 34 省，与前端逐字一致） */
export const CITY_PROVINCE: Readonly<Record<string, string>> = ${JSON.stringify(cityProvince, null, 2)} as const;

/** 省 → 城市[]（原始顺序，展示前由服务端按码点序排序） */
export const PROVINCE_CITIES: Readonly<Record<string, readonly string[]>> = ${JSON.stringify(Object.fromEntries(provMap), null, 2)} as const;

/** 城市 → 区/县[]（三级选择最细一级，JSON 字符串键，与前端逐字一致）。
 *  未收录 / 没有更细粒度的城市（香港 / 澳门 / 长白山 / 曼谷 …）值为空数组。 */
export const CITY_DISTRICTS: Readonly<Record<string, readonly string[]>> = ${JSON.stringify(cityDistricts, null, 2)} as const;

/**
 * 给定城市，返回其可选的区/县列表（与前端 core districtsOf 口径一致）：
 * 未选 / 表外 / 无更细粒度 / 只有一个「自己」的直筒子市，均返回 []。
 */
export function districtsOf(city: string | null | undefined): readonly string[] {
  if (!city) return [];
  const list = CITY_DISTRICTS[city];
  if (!list || list.length === 0) return [];
  const ADMIN_SUFFIX = /(特别行政区|自治区|自治州|地区|省|市|县|区)$/u;
  const bare = city.replace(ADMIN_SUFFIX, '');
  if (list.length === 1 && list[0].replace(ADMIN_SUFFIX, '') === bare) return [];
  return list;
}
`;
writeFileSync(resolve(OUT, 'geo-cities.ts'), geoOut);

// ---- 生成 seed-records.ts ----
const seedOut = `/* 由 scripts/gen-data.mjs 从 packages/core/src/records.ts 生成，请勿手改。
   12 条预置记录：新用户示例数据（§11 待确认 2）。
   photo 故意为 null —— 前端 photoOf() 会回落到包内预置配图，无需真实 CDN 图。 */
export interface SeedRecord {
  id: string;
  eat: string;
  shop: string | null;
  city: string | null;
  district: string | null;
  rating: number;
  at: string;
  note: string | null;
}

export const SEED_RECORDS: readonly SeedRecord[] = ${JSON.stringify(
  records.map((r) => ({
    id: r.id,
    eat: r.eat,
    shop: r.shop ?? null,
    city: r.city ?? null,
    district: r.district ?? null,
    rating: r.rating,
    at: r.at,
    note: r.note ?? null,
  })),
  null,
  2,
)} as const;
`;
writeFileSync(resolve(OUT, 'seed-records.ts'), seedOut);

// ---- 生成 shared-limits.ts（字段长度 / 多图上限 / 中文名，单一真源 = 前端 core）----
const recText2 = readFileSync(resolve(SRC, 'records.ts'), 'utf8');
const fieldLimitsLit = sliceLiteral(recText2, 'FIELD_LIMITS', '{', '}');
const fieldLabelsLit = sliceLiteral(recText2, 'FIELD_LABELS', '{', '}');
const fieldLimits = new Function(`return (${fieldLimitsLit});`)();
const fieldLabels = new Function(`return (${fieldLabelsLit});`)();
const maxPhotosM = /export\s+const\s+MAX_PHOTOS\s*=\s*(\d+)/.exec(recText2);
if (!maxPhotosM) throw new Error('找不到 MAX_PHOTOS');
const maxPhotos = Number(maxPhotosM[1]);
if (!Number.isInteger(maxPhotos) || maxPhotos <= 0) throw new Error(`MAX_PHOTOS 非法: ${maxPhotosLit}`);
const limitKeys = Object.keys(fieldLimits);
for (const k of limitKeys) {
  if (!Number.isInteger(fieldLimits[k]) || fieldLimits[k] <= 0) throw new Error(`FIELD_LIMITS.${k} 非法`);
  if (!(k in fieldLabels)) throw new Error(`FIELD_LABELS 缺键 ${k}`);
}

const limitsOut = `/* 由 scripts/gen-data.mjs 从 packages/core/src/records.ts 生成，请勿手改。
 * 单一真源 = 前端 core 的 FIELD_LIMITS / FIELD_LABELS / MAX_PHOTOS。
 * 后端 zod 校验与前端 <Input maxlength> 共用同一份数字，杜绝 §3.7 的 422 漂移。 */
export const FIELD_LIMITS = ${JSON.stringify(fieldLimits)} as const;

export type FieldName = keyof typeof FIELD_LIMITS;

/** 字段中文名（错误提示用，与前端文案口径一致） */
export const FIELD_LABELS: Record<FieldName, string> = ${JSON.stringify(fieldLabels)} as const;

/** 一条记录至多 ${maxPhotos} 张照片（与前端 MAX_PHOTOS 逐字一致） */
export const MAX_PHOTOS = ${maxPhotos};
`;
writeFileSync(resolve(OUT, 'shared-limits.ts'), limitsOut);

console.log('✅ geo-cities.ts  %d 城 / %d 省', cities.length, provinces.length);
console.log('✅ seed-records.ts %d 条（评分和 %d / 五分 %d / 城市 %d / 店铺 %d）', records.length, ratingSum, five, citySet.size, shopSet.size);
console.log('✅ shared-limits.ts FIELD_LIMITS(%s) / MAX_PHOTOS=%d', limitKeys.join(','), maxPhotos);
