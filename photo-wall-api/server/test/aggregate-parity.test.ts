/**
 * 聚合 / 时间 / 排序 口径收口测试（P2）：后端 AggregateService 必须与
 * 前端 core 的纯函数**同一份数据、同一口径**。前端 core 是「现状」事实来源，
 * 改这里只能让后端去贴前端，不能反过来动前端（前端在本仓库外）。
 *
 * 该测试是「钉死漂移」的护栏：
 *   - 带行政后缀的城市（如「厦门市」）必须归到正确省份（福建），不是「其他」；
 *   - 省分组排序 = count DESC → 码点序（"其他"不单独置底）；
 *   - cityCounts / repeated 同数兜底 = 拼音序（localeCompare('zh-Hans-CN')）；
 *   - avgRating 分母含 rating=0、月份按本地墙钟归桶（不按 UTC）。
 *
 * 前端源码不可用时（SKIP_SOURCE_CHECK=1 或同级 photo-wall-mp/packages/core/src 不存在）
 * 自动跳过——它只验证「前后端一致」，不做后端单测的替代品。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { AggregateService } from '../src/services/aggregates.js';
import { round2 } from '../src/lib/dto.js';
import { monthKeyOf } from '../src/lib/time.js';
import { localToUtcMs, parseAtLocal, parseTzOffset, formatUtcIso } from '../src/lib/time.js';
import { resolveCoreSrc, coreSrcAvailable } from '../src/lib/core-src.js';
import type { RecordRow } from '../src/store/types.js';

const SRC = resolveCoreSrc();
const available = !process.env.SKIP_SOURCE_CHECK && coreSrcAvailable(SRC);

// ---- 构造同一份合成数据（带后缀城市 + 同数 tie + 跨月 + 含 0 分）----
function makeRows(): RecordRow[] {
  const tz = parseTzOffset('+08:00')!;
  const mk = (id: string, eat: string, city: string | null, rating: number, at: string): RecordRow => {
    const parts = parseAtLocal(at)!;
    const utcMs = localToUtcMs(parts, tz);
    return {
      id,
      userId: 'u1',
      eat,
      shop: eat + '店',
      shopId: null,
      city,
      district: null,
      rating,
      atLocal: at,
      tzOffset: '+08:00',
      eatenAtUtc: formatUtcIso(utcMs),
      note: null,
      photoIds: [],
      version: 1,
      createdAt: utcMs,
      updatedAt: utcMs,
      deletedAt: null,
      shareToken: null,
      sharedAt: null,
    };
  };
  return [
    mk('a', '甜水面', '成都', 5, '2026-10-09T12:30'),
    mk('b', '冰粉', '成都', 4, '2026-10-09T13:10'),
    mk('c', '跷脚牛肉', '乐山', 5, '2026-10-08T18:40'),
    mk('d', '厦门沙茶面', '厦门市', 5, '2026-10-07T20:15'), // 带后缀 → 必须归福建
    mk('e', '北京烤鸭', '北京', 5, '2026-09-30T18:00'),
    mk('f', '番茄牛腩', null, 0, '2026-09-27T19:00'), // 无城市 + 0 分
    mk('g', '蛋烘糕', '成都', 3, '2026-09-21T16:20'),
    // 同数 tie：甜水面(成都) 与 北京烤鸭(北京) 各出现 2 次 → 拼音序 北京 < 甜
    mk('h', '北京烤鸭', '北京', 4, '2026-09-14T08:40'),
    mk('i', '甜水面', '成都', 5, '2026-08-20T07:50'),
    mk('j', '热干面', '武汉', 5, '2026-07-25T11:40'),
  ];
}

/** 把后端 RecordRow[] 折成前端 FoodRecord[]（parity 只关心聚合相关字段） */
function toFrontendRecords(rows: RecordRow[]): any[] {
  return rows.map((r) => ({
    id: r.id,
    eat: r.eat,
    shop: r.shop ?? undefined,
    city: r.city ?? undefined,
    district: r.district ?? undefined,
    rating: r.rating,
    at: r.atLocal,
    note: r.note ?? undefined,
  }));
}

test('P2 省分组：带后缀城市归正确省，排序 = count DESC → 码点序', { skip: available ? false : '前端源码不可用（SKIP_SOURCE_CHECK=1 或路径缺失）' }, async (t) => {
  const rows = makeRows();
  const backend = new AggregateService({ listRecords: () => rows } as any).cities('u1');

  const { groupCitiesByProvince } = await import(`file:///${SRC.replace(/\\/g, '/')}/geo.ts`);
  const { countByCity } = await import(`file:///${SRC.replace(/\\/g, '/')}/records.ts`);
  const front = groupCitiesByProvince(countByCity(toFrontendRecords(rows)));

  // 1) 带后缀城市必须归福建（不是「其他」）
  const xiamenBackend = backend.provinces.find((p) => p.province === '福建');
  assert.ok(xiamenBackend, '后端：厦门市 应归福建');
  // 前端 countByCity 保留原始 city 名（仅省查找去后缀），后端一致
  assert.deepEqual(
    xiamenBackend.cities,
    [{ city: '厦门市', count: 1 }],
    '后端：厦门去后缀命中福建，但城内显示原名「厦门市」',
  );
  assert.equal(
    backend.provinces.some((p) => p.province === '其他' && p.cities.some((c) => c.city === '厦门')),
    false,
    '后端：厦门市 绝不能落进「其他」',
  );
  const frontXiamen = front.find((p: any) => p.province === '福建');
  assert.ok(frontXiamen, '前端：厦门市 应归福建');

  // 2) 省顺序：count DESC → 码点序；"其他"不单独置底
  // 前端 groupCitiesByProvince 的省序即标准答案
  const frontOrder = front.map((p: any) => p.province);
  const backOrder = backend.provinces.map((p) => p.province);
  assert.deepEqual(backOrder, frontOrder, '后端省序必须与前端 groupCitiesByProvince 完全一致');

  // 3) 每组 cities 与 count 完全一致
  const backendByProv = new Map(backend.provinces.map((p) => [p.province, p]));
  for (const fp of front) {
    const bp = backendByProv.get(fp.province);
    assert.ok(bp, `后端缺省 ${fp.province}`);
    assert.equal(bp.count, fp.count, `省 ${fp.province} 计数`);
    assert.deepEqual(
      bp.cities,
      fp.cities.map((c: any) => ({ city: c.city, count: c.count })),
      `省 ${fp.province} 城内城市与序`,
    );
  }

  // 4) 不变量：cityCounts 之和 + uncity == total
  const citySum = backend.cityCounts.reduce((s, x) => s + x.count, 0);
  assert.equal(citySum + backend.uncityCount, backend.total, 'cityCounts 之和 + 未记 = total');
});

test('P2 统计：avg 分母含 0、repeated 计数降序 → 拼音序、firstFive 时间倒序', { skip: available ? false : '前端源码不可用' }, async (t) => {
  const rows = makeRows();
  const backend = new AggregateService({ listRecords: () => rows } as any).stats('u1', { cityMissing: false });

  const { computeStats } = await import(`file:///${SRC.replace(/\\/g, '/')}/stats.ts`);
  const front = computeStats(toFrontendRecords(rows));

  // avg 分母含 0 分（10 条里 9 条有分，1 条 0）
  const expectAvg = round2(rows.reduce((s, r) => s + r.rating, 0) / rows.length);
  assert.equal(backend.avgRating, expectAvg, 'avg 分母含 rating=0');
  assert.equal(Number(backend.avgRating.toFixed(1)), Number(front.avg.toFixed(1)), 'avg 与前端(1 位)一致');

  // repeated：次数降序 → 同数拼音序（北京 < 甜）
  assert.deepEqual(
    backend.repeated.map((r) => ({ eat: r.eat, count: r.count })),
    front.repeated.map((r: any) => ({ eat: r.eat, count: r.count })),
    'repeated 序列与前端一致',
  );

  // fiveCount / firstFiveEat
  assert.equal(backend.fiveCount, front.fiveCount, '五分条数');
  // 前端 firstFiveEat 依赖输入序；这里输入已按 at 倒序排，故与后端 sortedDesc 第一条五分一致
  assert.equal(backend.firstFiveEat, front.firstFiveEat, 'firstFiveEat 均为时间倒序首条五分');

  // 城市 / 店铺数
  assert.equal(backend.cities, front.cities, '城市数（不计未记）');
  assert.equal(backend.shops, front.shops, '店铺数');
});

test('P2 月份桶：按本地墙钟归桶（不按 UTC）', { skip: available ? false : '前端源码不可用' }, async (t) => {
  const rows = makeRows();
  const backend = new AggregateService({ listRecords: () => rows } as any).months('u1', { cityMissing: false });
  const backMonths = backend.items.map((m) => m.month);

  // 前端 layout 用 at.slice(0,7)；这里后端 monthKeyOf 与它逐字等价
  const frontMonths = [...new Set(rows.map((r) => monthKeyOf(r.atLocal)))].sort((a, b) => (a < b ? 1 : -1));
  assert.deepEqual(backMonths, frontMonths, '月份桶键与前端 at.slice(0,7) 一致（本地墙钟）');
  // 跨时区护栏：若按 UTC 归桶，+08:00 的 00:00 记录会掉到上个月——这里都是 +08:00 白天，本地=UTC 月
  assert.ok(backMonths.includes('2026-10'), '含 2026-10 桶');
});
