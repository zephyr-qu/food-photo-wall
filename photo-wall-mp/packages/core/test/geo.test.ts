/* ================================================================
   geo.ts 单测 —— 两级城市选择的「省」从哪来

   这张表是静态常识，但它是 UI 分组的唯一依据：
   · 表外城市必须落到「其他」而不是消失
   · 「厦门市 / 闽侯县」这类带行政后缀的写法要能命中
   · 分组相加上限必须等于总数（不丢记录）
   ================================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  OTHER_PROVINCE,
  CITY_PROVINCE,
  provinceOf,
  groupCitiesByProvince,
  provinceCatalogue,
} from '../src/geo.ts';
import { REAL_RECORDS } from '../src/demo.ts';
import { countByCity } from '../src/records.ts';

test('provinceOf：常见城市与直辖市', () => {
  assert.equal(provinceOf('成都'), '四川');
  assert.equal(provinceOf('乐山'), '四川');
  assert.equal(provinceOf('佛山'), '广东');
  assert.equal(provinceOf('厦门'), '福建');
  assert.equal(provinceOf('北京'), '北京');
  assert.equal(provinceOf('上海'), '上海');
});

test('provinceOf：带行政后缀的写法也能命中', () => {
  assert.equal(provinceOf('厦门市'), '福建');
  assert.equal(provinceOf('闽侯县'), '福建');
  assert.equal(provinceOf('成都市'), '四川');
});

test('provinceOf：表外/空值返回 null', () => {
  assert.equal(provinceOf('五味'), null);
  assert.equal(provinceOf(''), null);
  assert.equal(provinceOf('   '), null);
  assert.equal(provinceOf(null), null);
  assert.equal(provinceOf(undefined), null);
});

test('groupCitiesByProvince：按省聚合、计数相加、省与省内城市都降序', () => {
  const rows: Array<[string, number]> = [
    ['成都', 3],
    ['乐山', 2],
    ['佛山', 1],
    ['厦门', 1],
    ['北京', 1],
  ];
  const groups = groupCitiesByProvince(rows);
  // 数量降序；同数量的省按码点序（北 U+5317 < 广 U+5E7F < 福 U+798F）
  assert.deepEqual(
    groups.map((g) => [g.province, g.count]),
    [
      ['四川', 5],
      ['北京', 1],
      ['广东', 1],
      ['福建', 1],
    ],
  );
  const sichuan = groups.find((g) => g.province === '四川')!;
  assert.deepEqual(sichuan.cities, [
    { city: '成都', count: 3 },
    { city: '乐山', count: 2 },
  ]);
});

test('groupCitiesByProvince：未记不参与分组，表外城市进「其他」', () => {
  const groups = groupCitiesByProvince([
    ['成都', 2],
    ['', 3],
    ['五味', 1],
  ]);
  assert.deepEqual(
    groups.map((g) => g.province),
    ['四川', OTHER_PROVINCE],
  );
  // 空城市没有被算进任何省
  assert.equal(groups.reduce((s, g) => s + g.count, 0), 3);
  const other = groups.find((g) => g.province === OTHER_PROVINCE)!;
  assert.deepEqual(other.cities, [{ city: '五味', count: 1 }]);
});

test('groupCitiesByProvince：真实数据的省计数之和 = 有城市的记录数', () => {
  const rows = countByCity(REAL_RECORDS);
  const groups = groupCitiesByProvince(rows);
  const grouped = groups.reduce((s, g) => s + g.count, 0);
  const withCity = rows
    .filter(([city]) => city)
    .reduce((s, [, n]) => s + n, 0);
  assert.equal(grouped, withCity);
  // 12 条里 11 条有城市（r6 没记城市）
  assert.equal(withCity, 11);
  const sichuan = groups.find((g) => g.province === '四川')!;
  assert.equal(sichuan.count, 5); // 成都 3 + 乐山 2
});

test('provinceCatalogue：全量城市表覆盖映射表，每个城市只出现一次', () => {
  const groups = provinceCatalogue();
  const cities = groups.flatMap((g) => g.cities.map((c) => c.city));
  assert.equal(cities.length, Object.keys(CITY_PROVINCE).length);
  assert.equal(new Set(cities).size, cities.length);
  // 每条都归在自己的省下（写错一行表就会在这里露出来）
  for (const g of groups) {
    for (const c of g.cities) assert.equal(provinceOf(c.city), g.province);
  }
});

test('provinceCatalogue：直辖市是一个省一座城，全量表不带计数', () => {
  const groups = provinceCatalogue();
  const bj = groups.find((g) => g.province === '北京')!;
  assert.deepEqual(bj.cities, [{ city: '北京', count: 0 }]);
  assert.ok(groups.every((g) => g.count === 0));
  assert.ok(groups.every((g) => g.cities.every((c) => c.count === 0)));
});
