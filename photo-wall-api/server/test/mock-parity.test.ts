/**
 * mock 后端（`photo-wall-mp/server`，零依赖 JS，端口 8788）与真后端（本工程）
 * 的**形状一致性**测试 —— 补的是 P1-3 的护栏缺口。
 *
 * ---------- 为什么需要它 ----------
 * 同一个契约有两份实现：mock 给人离线联调用，真后端是交付物。两份都不改
 * 就谁也不报错，直到「前端对着 mock 写好了、接真后端字段不见了」。
 * 已有 `aggregate-parity.test.ts` 钉住「真后端聚合 vs 前端 core 纯函数」的口径，
 * 但**没有人钉 mock vs 真后端**：这份就是干这个的。
 *
 * 它抓到过的真问题（留档，别删）：
 *   · mock 的 record DTO 缺 `photos` 数组 —— 而契约 §5 明写 `photos` **恒存在**
 *     （0–5 张，`photos[0]` 是封面）。前端 `record.photos.map(...)` 对着 mock
 *     写出来，接真后端反而对，接回来就炸；已在本测试落地后修好 mock。
 *
 * ---------- 比什么、不比什么 ----------
 * 比 **status + JSON 结构**（键名/嵌套/基本类型），不比具体值 ——
 * 两边 id、token、时间戳必然不同。
 * 状态必须对齐：mock 默认给新用户灌 101 条演示记录（`SEED_NEW_USERS`，
 * 契约允许），真后端 `seedDemoRecords:false` 是空的。所以先把 mock 的种子
 * 关掉再比，否则比的是「数据不同」而不是「形状不同」。
 *
 * 未覆盖：multipart 上传（`POST /photos`）、DELETE 的 If-Match 语义、
 * 多图 `photoIds`（mock 只落地单张，见 mock 侧注释）。
 *
 * mock 源码不可用（SKIP_SOURCE_CHECK=1 或 photo-wall-mp 不在工作区）时跳过 ——
 * 它验证的是「两份实现是否一致」，不能替代任何一方的单测。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createApp } from '../src/app.js';

const HERE = dirname(fileURLToPath(import.meta.url));
/** HERE = photo-wall-api/server/test → 三次上跳 = 工作区根 */
const MOCK_ENTRY = resolve(HERE, '..', '..', '..', 'photo-wall-mp', 'server', 'src', 'index.js');
const available = !process.env.SKIP_SOURCE_CHECK && existsSync(MOCK_ENTRY);
const skip = available ? false : `mock 源码不在（找不到 ${MOCK_ENTRY}）`;

/** 把响应体压成「形状」：键名排序 + 基本类型；空数组单独标记 */
function shapeOf(v: unknown, depth = 0): unknown {
  if (v === null) return 'null';
  if (Array.isArray(v)) {
    if (depth > 3) return 'array';
    return v.length === 0 ? 'array<empty>' : [shapeOf(v[0], depth + 1)];
  }
  if (typeof v === 'object') {
    if (depth > 3) return 'object';
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = shapeOf((v as Record<string, unknown>)[k], depth + 1);
    }
    return out;
  }
  return typeof v;
}

interface Hit {
  status: number;
  body: unknown;
}

type Caller = (method: string, path: string, init?: { body?: unknown; token?: string }) => Promise<Hit>;

test('mock 与真后端的响应形状一致', { skip }, async () => {
  /* mock 的种子开关是模块级状态，必须在起服务前关掉 */
  const mockStoreUrl = pathToFileURL(resolve(HERE, '..', '..', '..', 'photo-wall-mp', 'server', 'src', 'store.js')).href;
  const mockStore: {
    setSeedNewUsers(on: boolean): void;
    resetStore(opts?: { seedNewUsers?: boolean }): void;
  } = await import(mockStoreUrl);
  mockStore.setSeedNewUsers(false);
  mockStore.resetStore({ seedNewUsers: false });

  const mockEntry = await import(pathToFileURL(MOCK_ENTRY).href);
  const mock = await mockEntry.startServer({ port: 0 });

  const real = await createApp({
    persist: false,
    config: {
      storageDir: 'var/test-uploads',
      publicBaseUrl: 'http://localhost:8787',
      rateLimit: { enabled: false, defaultPerMin: 1000, photoPerMin: 1000, authPerMin: 1000 },
      seedDemoRecords: false,
      strictWechatCodes: false,
    },
  });

  const json = (t: string): unknown => (t ? JSON.parse(t) : null);

  const callMock: Caller = async (method, path, init = {}) => {
    const res = await fetch(mock.url + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
    return { status: res.status, body: json(await res.text()) };
  };

  const callReal: Caller = async (method, path, init = {}) => {
    const res = await real.app.request(path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
    return { status: res.status, body: json(await res.text()) };
  };

  const diffs: string[] = [];
  /** 同一串请求打两边，形状不同就记一条（一次报全，别一个个撞） */
  const same = async (label: string, method: string, path: string, body?: unknown) => {
    const [m, r] = await Promise.all([callMock(method, path, { body, token: mt }), callReal(method, path, { body, token: rt })]);
    const shapeM = JSON.stringify(shapeOf(m.body));
    const shapeR = JSON.stringify(shapeOf(r.body));
    if (m.status !== r.status) diffs.push(`${label}: status mock=${m.status} real=${r.status}`);
    else if (shapeM !== shapeR) diffs.push(`${label}: ${m.status}\n    mock=${shapeM}\n    real=${shapeR}`);
    return { mock: m, real: r };
  };

  let mt: string | undefined;
  let rt: string | undefined;

  try {
    /* 无鉴权端点 */
    await same('healthz', 'GET', '/v1/healthz');
    await same('geo/cities', 'GET', '/v1/geo/cities');

    /* 登录：token 值不同，比形状；之后各自用各自的 token */
    const ml = await callMock('POST', '/v1/auth/anonymous', { body: { deviceId: 'dev_mock_parity' } });
    const rl = await callReal('POST', '/v1/auth/anonymous', { body: { deviceId: 'dev_mock_parity' } });
    if (ml.status !== rl.status) diffs.push(`auth/anonymous: status mock=${ml.status} real=${rl.status}`);
    else if (JSON.stringify(shapeOf(ml.body)) !== JSON.stringify(shapeOf(rl.body))) {
      diffs.push(`auth/anonymous: shape\n    mock=${JSON.stringify(shapeOf(ml.body))}\n    real=${JSON.stringify(shapeOf(rl.body))}`);
    }
    mt = (ml.body as { accessToken: string }).accessToken;
    rt = (rl.body as { accessToken: string }).accessToken;

    /* 空库读：三条聚合 + 列表 */
    await same('records(空)', 'GET', '/v1/records?limit=10');
    await same('records/cities', 'GET', '/v1/records/cities');
    await same('records/months', 'GET', '/v1/records/months');
    await same('stats', 'GET', '/v1/stats');

    /* 写一条再读：DTO 字段集是这次的重点（`photos` 就是这么被抓到的） */
    const payload = {
      eat: '烤鸭',
      shop: '全聚德',
      city: '北京',
      district: '东城区',
      rating: 4,
      at: '2026-10-09T12:30',
      tzOffset: '+08:00',
      note: '皮脆',
    };
    const created = await same('records(POST)', 'POST', '/v1/records', payload);
    await same('records(一条)', 'GET', '/v1/records?limit=10');
    await same('records/random', 'GET', '/v1/records/random');
    await same('shops/by-name', 'GET', `/v1/shops/by-name?name=${encodeURIComponent('全聚德')}`);

    /* 版本冲突口径（§3.5 / §6.2.4）：两边的 409 必须同时成立，且**写法都要认**。
       裸数字是契约示例、也是前端实际发的；带引号的是 HTTP 标准 ETag 形态。
       以前真后端只认裸数字、带引号回 400，mock 却两种都认 —— 就是这么漂的。 */
    const mockId = (created.mock.body as { id: string }).id;
    const realId = (created.real.body as { id: string }).id;
    for (const header of ['999', '"999"', 'W/"999"']) {
      const patchOne = async (base: 'mock' | 'real', id: string, token: string) => {
        const body = JSON.stringify({ rating: 5 });
        const headers = {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'If-Match': header,
        };
        const res =
          base === 'mock'
            ? await fetch(`${mock.url}/v1/records/${id}`, { method: 'PATCH', headers, body })
            : await real.app.request(`/v1/records/${id}`, { method: 'PATCH', headers, body });
        return { status: res.status, body: json(await res.text()) };
      };
      const [mp, rp] = await Promise.all([patchOne('mock', mockId, mt), patchOne('real', realId, rt)]);
      if (mp.status !== rp.status) diffs.push(`PATCH If-Match=${header}: status mock=${mp.status} real=${rp.status}`);
      else if (mp.status !== 409) diffs.push(`PATCH If-Match=${header}: 期望 409，实际 mock=${mp.status} real=${rp.status}`);
    }

    assert.deepEqual(diffs, [], `mock 与真后端形状不一致：\n${diffs.join('\n')}`);
  } finally {
    await real.close();
    await new Promise<void>((res) => mock.server.close(() => res()));
  }
});
