/* ================================================================
   请求层（`src/api/client.ts`）的单元测试 —— 这一层以前**一条测试都没有**。

   为什么不靠"跑起来看一眼"：这层出错的形态全都不是"报错"，而是
   「墙是空的 / 点了没反应 / 一直转圈」这类**看不见的**故障：
     · token 快过期时还当有效会话用 → 并发请求全 401 → 并发 refresh →
       服务端 refreshToken 轮换让 N-1 发失败 → 登录限流被打爆；
     · 401 后没清会话 → 旧 token 一直在 storage 里 → 永远 401、页面永远空；
     · 204/304 空体被适配器当 JSON 解析失败 → DELETE"看起来失败、其实已删"
       → store 乐观回滚 → 卡片复活、再删报错；
     · 429 不带 Retry-After → 用户狂点把限流窗口彻底打死。
   这些都是状态机问题，只有把 Taro 换成假实现、自己控时序才测得出来。

   做法：
     · `mock.module` 把 `@tarojs/taro` 换成内存实现（Taro 真实包在 Node 里
       加载不了：@tarojs/runtime 依赖构建期注入的全局量）；
     · `Taro.request` 由每个用例自己排队响应，于是"401 → refresh → 重放一次"、
       "并发 ensureSession 只登录一次"这类时序都能确定性地复现；
     · client.ts 的模块级状态（tokens / loginTask / refreshTask / 退避窗口）
       需要每个用例之间隔离 —— 所以用**每次全新的动态 import**（查询串
       cache-bust）拿一份干净模块。
   ================================================================ */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

/* ---------------- 假的 Taro 运行时 ---------------- */

type Req = {
  url: string;
  method?: string;
  data?: unknown;
  header?: Record<string, string>;
};
type Res = { statusCode: number; data: unknown; header?: Record<string, string> };

const storage = new Map<string, unknown>();

/** 每个用例自己 push 一个 handler 队列，按顺序消费；空队列就抛错（便于发现多发请求） */
let queue: Array<Res | ((req: Req) => Res | Promise<Res>)> = [];
let seen: Req[] = [];

const fakeTaro = {
  getStorageSync: (k: string) => (storage.has(k) ? storage.get(k) : ''),
  setStorageSync: (k: string, v: unknown) => void storage.set(k, v),
  removeStorageSync: (k: string) => void storage.delete(k),
  login: async () => ({ code: 'wx-code-1' }),
  request: async (req: Req) => {
    seen.push(req);
    const h = queue.shift();
    if (!h) throw { errMsg: 'request:fail 用例没有安排响应' };
    return typeof h === 'function' ? h(req) : h;
  },
  uploadFile: async (req: Req) => {
    seen.push(req);
    const h = queue.shift();
    if (!h) throw { errMsg: 'uploadFile:fail 用例没有安排响应' };
    return typeof h === 'function' ? h(req) : h;
  },
  base64ToArrayBuffer: (s: string) => new Uint8Array(Buffer.from(s, 'base64')).buffer,
};

mock.module('@tarojs/taro', { defaultExport: fakeTaro });

/* ---------------- 工具 ---------------- */

let seq = 0;
/** 拿一份干净的 client 模块（模块级单飞/退避状态互不串味） */
async function freshClient() {
  seq += 1;
  return import(`../src/api/client.ts?case=${seq}`);
}

function reset() {
  storage.clear();
  queue = [];
  seen = [];
}

/** 一个不会过期的 token（payload 里带 sub，供 currentUserId 用） */
function jwt(sub: string): string {
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64({ alg: 'HS256' })}.${b64({ sub, exp: 9e9 })}.sig`;
}

function tokens(over: Partial<{ accessToken: string; refreshToken: string; expiresAt: number }> = {}) {
  return {
    accessToken: over.accessToken ?? jwt('u1'),
    refreshToken: over.refreshToken ?? 'rt-1',
    expiresAt: over.expiresAt ?? Date.now() + 3600_000,
  };
}

/** 把 token 直接塞进 storage（模拟"上次运行留下的会话"） */
function seedStorage(t: ReturnType<typeof tokens>) {
  storage.set('photo-wall:tokens:v1', t);
}

const ok = (data: unknown = { hello: 1 }): Res => ({ statusCode: 200, data, header: {} });
const err401 = (code = 'TOKEN_EXPIRED'): Res => ({
  statusCode: 401,
  data: { error: { code, message: '登录已过期' } },
  header: {},
});

/* ---------------- 用例 ---------------- */

test('没有会话时先静默登录，再带 Bearer 发业务请求', async () => {
  reset();
  queue = [
    () => ok({ accessToken: jwt('u1'), refreshToken: 'rt-1', expiresIn: 7200 }), // /auth/anonymous
    (req) => {
      assert.equal(req.header?.Authorization, `Bearer ${jwt('u1')}`);
      return ok({ id: 'rec_1' });
    },
  ];
  const c = await freshClient();
  const out = await c.request('GET', '/records/rec_1');
  assert.deepEqual(out, { id: 'rec_1' });
  assert.equal(seen.length, 2);
  assert.equal(seen[0].url.endsWith('/v1/auth/anonymous'), true);
  assert.equal(seen[1].url.endsWith('/v1/records/rec_1'), true);
});

test('并发 ensureSession 只登录一次（单飞）', async () => {
  reset();
  queue = [() => ok({ accessToken: jwt('u1'), refreshToken: 'rt-1', expiresIn: 7200 })];
  const c = await freshClient();
  const [a, b, d] = await Promise.all([c.ensureSession(), c.ensureSession(), c.ensureSession()]);
  assert.equal(a.accessToken, b.accessToken);
  assert.equal(b.accessToken, d.accessToken);
  assert.equal(seen.length, 1);
});

test('token 还有 59s 就到期：不直接用，先 refresh（60s 提前量）', async () => {
  reset();
  const t = tokens({ expiresAt: Date.now() + 59_000, accessToken: jwt('u1'), refreshToken: 'rt-old' });
  seedStorage(t);
  queue = [(req) => {
    assert.equal((req.data as { refreshToken: string }).refreshToken, 'rt-old');
    return ok({ accessToken: jwt('u1'), refreshToken: 'rt-new', expiresIn: 7200 });
  }];
  const c = await freshClient();
  const got = await c.ensureSession();
  assert.equal(got.refreshToken, 'rt-new');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url.endsWith('/v1/auth/refresh'), true);
});

test('token 还有 61s 才到期：直接复用，零往返', async () => {
  reset();
  seedStorage(tokens({ expiresAt: Date.now() + 61_000 }));
  const c = await freshClient();
  await c.ensureSession();
  assert.equal(seen.length, 0);
  assert.equal(c.hasSession(), true);
});

test('401 → refresh → 重放一次（且只重放一次）', async () => {
  reset();
  seedStorage(tokens({ accessToken: jwt('u1'), refreshToken: 'rt-1', expiresAt: Date.now() + 3600_000 }));
  queue = [
    () => err401(),                                                        // 业务请求 401
    () => ok({ accessToken: jwt('u2'), refreshToken: 'rt-2', expiresIn: 7200 }), // refresh
    (req) => {
      assert.equal(req.header?.Authorization, `Bearer ${jwt('u2')}`);
      return ok({ id: 'rec_9' });                                          // 重放
    },
  ];
  const c = await freshClient();
  assert.deepEqual(await c.request('GET', '/records/rec_9'), { id: 'rec_9' });
  assert.equal(seen.length, 3);
});

test('401 且 refresh 也失败 → 清会话 + 重新登录 + 重放', async () => {
  reset();
  seedStorage(tokens({ accessToken: jwt('u1'), refreshToken: 'rt-dead', expiresAt: Date.now() + 3600_000 }));
  queue = [
    () => err401(),
    () => err401('REFRESH_INVALID'),                                     // refresh 失败
    () => ok({ accessToken: jwt('u3'), refreshToken: 'rt-3', expiresIn: 7200 }), // 重新登录
    (req) => {
      assert.equal(req.header?.Authorization, `Bearer ${jwt('u3')}`);
      return ok({ id: 'rec_1' });
    },
  ];
  const c = await freshClient();
  assert.deepEqual(await c.request('GET', '/records/rec_1'), { id: 'rec_1' });
  assert.equal(seen.map((r) => r.url.replace(/^.*\/v1/, '')).join(','), '/records/rec_1,/auth/refresh,/auth/anonymous,/records/rec_1');
});

test('二次 401：清掉会话再抛（不无限重放）', async () => {
  reset();
  seedStorage(tokens({ refreshToken: 'rt-1' }));
  queue = [
    () => err401(),
    () => ok({ accessToken: jwt('u2'), refreshToken: 'rt-2', expiresIn: 7200 }),
    () => err401('NOPE'),           // 重放又 401
  ];
  const c = await freshClient();
  await assert.rejects(() => c.request('GET', '/records/x'), (e: any) => e.status === 401);
  assert.equal(c.hasSession(), false);
  assert.equal(seen.length, 3);
});

test('204 / 304 空体按成功返回 null，不当成解析失败', async () => {
  reset();
  seedStorage(tokens());
  queue = [{ statusCode: 204, data: '', header: {} }];
  const c = await freshClient();
  assert.equal(await c.request('DELETE', '/records/rec_1', { headers: { 'If-Match': '"v1"' } }), null);
});

test('错误体 → ApiError（code/message/fields 全带上）', async () => {
  reset();
  seedStorage(tokens());
  queue = [
    {
      statusCode: 422,
      data: { error: { code: 'VALIDATION_FAILED', message: '参数不合法', fields: { dishName: '必填' } } },
      header: {},
    },
  ];
  const c = await freshClient();
  await assert.rejects(
    () => c.request('POST', '/records', { body: { dishName: '' } }),
    (e: any) => {
      assert.equal(e.status, 422);
      assert.equal(e.code, 'VALIDATION_FAILED');
      assert.deepEqual(c.getErrorFields(e), { dishName: '必填' });
      assert.equal(c.firstFieldMessage(c.getErrorFields(e)), '必填');
      return true;
    },
  );
});

test('429 把 Retry-After 带进 ApiError.retryAfter（坏值当没有）', async () => {
  reset();
  seedStorage(tokens());
  queue = [
    { statusCode: 429, data: { error: { code: 'RATE_LIMITED', message: '太频繁' } }, header: { 'Retry-After': '30' } },
    { statusCode: 429, data: { error: { code: 'RATE_LIMITED', message: '太频繁' } }, header: { 'Retry-After': 'soon' } },
  ];
  const c = await freshClient();
  await assert.rejects(() => c.request('POST', '/photos'), (e: any) => e.retryAfter === 30);
  await assert.rejects(() => c.request('POST', '/photos'), (e: any) => e.retryAfter === undefined);
});

test('网络层异常（errMsg）包成 NetworkError，超时也走同一条路', async () => {
  reset();
  seedStorage(tokens());
  queue = [() => { throw { errMsg: 'request:fail timeout' }; }];
  const c = await freshClient();
  await assert.rejects(() => c.request('GET', '/records'), (e: any) => {
    assert.equal(e.name, 'NetworkError');
    assert.match(e.message, /timeout/);
    return true;
  });
});

test('currentUserId 从 JWT sub 取，坏 token 返回 null 而不是抛', async () => {
  reset();
  seedStorage(tokens({ accessToken: jwt('user-42') }));
  const c = await freshClient();
  assert.equal(c.currentUserId(), 'user-42');

  storage.set('photo-wall:tokens:v1', { accessToken: 'not-a-jwt', refreshToken: 'r', expiresAt: Date.now() + 9e6 });
  const c2 = await freshClient();
  assert.equal(c2.currentUserId(), null);
});

test('登录失败后 5s 内不再打 /auth（退避），直接快速失败', async () => {
  reset();
  queue = [() => { throw { errMsg: 'request:fail 429' }; }];
  const c = await freshClient();
  await assert.rejects(() => c.request('GET', '/records'), (e: any) => e.name === 'NetworkError');
  assert.equal(seen.length, 1);

  /* 第二次：退避窗口内，不该再发请求 */
  await assert.rejects(() => c.ensureSession(), (e: any) => {
    assert.equal(e.name, 'NetworkError');
    assert.match(e.message, /登录暂时不可用/);
    return true;
  });
  assert.equal(seen.length, 1);
});
