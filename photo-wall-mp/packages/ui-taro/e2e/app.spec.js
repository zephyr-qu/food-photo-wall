// @ts-check
/**
 * Taro H5 端的端到端测试（Playwright）。
 *
 * 为什么跑 H5 而不是微信模拟器：Taro 的 weapp 与 h5 共用同一套 React 组件树
 * （差异只在平台适配层），所以**交互逻辑、状态机、请求流程**在 H5 上验证
 * 等价有效，而 H5 可以用 Playwright 自动化 —— 微信开发者工具的自动化 API
 * 需要额外开窗口、跑得更慢，不适合每次提交都跑。真机/模拟器的专属行为
 * （胶囊让位、隐私弹窗、分享卡片）另由人工核对清单覆盖。
 *
 * 前置：
 *   1. 真后端跑在 8787（`cd photo-wall-api/server && PORT=8787 node dist/src/index.js`）；
 *   2. H5 产物已构建（`npm run build:h5`）并被静态服务托管在 BASE。
 *      webServer 会自动起一个 `serve`，也可以复用已存在的 5195。
 *
 * 数据隔离：每个用例用独立的 `deviceId`（localStorage 注入 token），
 * 互不影响；用例内部自己造数据，不依赖预置种子。
 */
import { test, expect } from '@playwright/test';

const BASE = process.env.E2E_BASE ?? 'http://127.0.0.1:5195/';
const API = process.env.E2E_API ?? 'http://127.0.0.1:8787/v1';

/**
 * H5 产物是**构建期**决定后端地址的；这里用运行时覆盖 `?api=` 指向 E2E 专用后端
 * （关限流 + 空库，见 server/scripts/e2e-server.mjs）。
 * 不带这个参数就会打到构建时配的 8787 —— 那个实例有限流，连跑十几个用例必 429。
 */
const API_ORIGIN = API.replace(/\/v1$/, '');

/** 用匿名登录换一个干净的账号，返回 token（每个用例一个独立用户） */
async function freshUser(request) {
  /* deviceId 必须**全局唯一**：后端按 deviceId 找/建用户，两个用例撞上同一个
     deviceId 就会共享账号 —— 表现为"A 造的数据出现在 B 里"，是极难定位的随机
     失败。用 randomUUID 而不是 Date.now()+Math.random()，后者在快速连续调用时
     仍有碰撞概率。 */
  const deviceId = `e2e-${crypto.randomUUID()}`;
  const res = await request.post(`${API}/auth/anonymous`, {
    data: { deviceId },
  });
  expect(res.ok(), `匿名登录失败：${res.status()}`).toBeTruthy();
  return (await res.json()).accessToken;
}

/** 直接打接口造记录（比走 UI 快，且让用例聚焦在要验证的交互上） */
async function seedRecords(request, token, rows) {
  for (const r of rows) {
    const res = await request.post(`${API}/records`, {
      headers: { Authorization: `Bearer ${token}` },
      data: r,
    });
    expect(res.status(), `造数据失败: ${JSON.stringify(r)}`).toBe(201);
  }
}

/**
 * 把 token 注入 localStorage（Taro 的 storage 是 `{data: ...}` 包装），
 * 然后打开页面 —— 等效于"这个设备已经登录过"。
 *
 * 实现要点：用 `page.addInitScript` 在**页面任何脚本执行之前**写入 localStorage。
 * 为什么不能"先 goto 再 evaluate"：那样第一次 goto 时 localStorage 还是空的，
 * 应用会按构建期默认（8787）发起请求 —— 而 8787 是联调实例、有限流，
 * 于是首屏聚合请求全 429，墙看起来是空的（E2E 里表现为随机失败）。
 * addInitScript 保证应用第一次求值 `getApiBaseUrl()` 时就已经指向 E2E 后端。
 */
async function openAsUser(page, token, hash = '#/pages/wall/index') {
  await page.addInitScript(
    ({ t, origin }) => {
      localStorage.setItem('photo-wall:api-origin', origin);
      localStorage.setItem(
        'photo-wall:tokens:v1',
        JSON.stringify({
          data: { accessToken: t, refreshToken: 'e2e-not-used', expiresAt: Date.now() + 3_600_000 },
        }),
      );
    },
    { t: token, origin: API_ORIGIN },
  );

  await page.goto(`${BASE}${hash}`, { waitUntil: 'domcontentloaded' });

  /* 等首屏请求落地：骨架/空态/墙/错误四者必有其一。
     ⚠ 这里偶尔会慢（后端刚造完数据、或 H5 chunk 首次加载），
     所以给足超时；仍然超时的话把当前 DOM 打出来便于定位。 */
  const firstScreen = page.locator('.tile, .wall--skeleton, .empty-state, .wall-error');
  try {
    await expect(firstScreen.first()).toBeVisible({ timeout: 25_000 });
  } catch (e) {
    const dump = await page.evaluate(() => ({
      hash: location.hash,
      api: localStorage.getItem('photo-wall:api-origin'),
      hasToken: !!localStorage.getItem('photo-wall:tokens:v1'),
      html: document.body.innerHTML.slice(0, 400),
    }));
    throw new Error(`首屏未渲染：${JSON.stringify(dump)}\n原始错误：${e}`, { cause: e });
  }
}

test.describe('照片墙 · 首屏与状态', () => {
  test('新用户是空墙 + 统计全 0（AC-01 的前端表现）', async ({ page, request }) => {
    const token = await freshUser(request);
    await openAsUser(page, token);

    await expect(page.locator('.empty-state')).toBeVisible();
    await expect(page.locator('.tile')).toHaveCount(0);

    /* 统计浮层：拍过 0 张 / 去过 0 座城市 */
    await page.locator('.iconbtn', { hasText: '统计' }).click();
    await expect(page.locator('.stats-sheet').first()).toBeVisible();
    await expect(page.getByText('0 张照片')).toBeVisible();
  });

  test('有数据时墙渲染、照片全部加载成功、顶栏概数正确', async ({ page, request }) => {
    const token = await freshUser(request);
    await seedRecords(request, token, [
      { eat: 'E2E 龙抄手', city: '成都', rating: 5, at: '2026-10-01T12:00' },
      { eat: 'E2E 钵钵鸡', city: '乐山', rating: 4, at: '2026-09-15T12:00' },
      { eat: 'E2E 烤鸭', city: '北京', rating: 0, at: '2026-09-02T12:00' },
    ]);
    await openAsUser(page, token);

    await expect(page.locator('.tile')).toHaveCount(3);

    /* 概数「3 张 · 3 城」（全量口径，不吃筛选） */
    await expect(page.locator('.brand__sum')).toHaveText('3 张 · 3 城');

    /* 预置配图必须真的能加载出来（路径错会静默变白块，这是历史踩过的坑）。
       ⚠ 墙用了 `lazyLoad`：视口外的图**本来就不该**已经加载；
       ⚠ 而且懒加载是异步的，刚渲染完那一瞬间 `complete` 还是 false。
       所以：先等首图 loaded（给懒加载一点时间），再只检查"视口内且已进入加载队列"的图。 */
    await page.locator('.tile img').first().evaluate(
      (img) => img.complete && img.naturalWidth > 0
        ? Promise.resolve()
        : new Promise((res) => {
            img.addEventListener('load', () => res(undefined), { once: true });
            img.addEventListener('error', () => res(undefined), { once: true });
          }),
    );

    const imgStats = await page.evaluate(async () => {
      const imgs = [...document.querySelectorAll('.tile img')];
      const inView = imgs.filter((i) => {
        const r = i.getBoundingClientRect();
        return r.top < window.innerHeight && r.bottom > 0;
      });
      /* 给懒加载 1.5s 收尾（IntersectionObserver 是异步的） */
      await new Promise((r) => setTimeout(r, 1500));
      return {
        total: imgs.length,
        inView: inView.length,
        brokenInView: inView.filter((i) => !(i.complete && i.naturalWidth > 0)).length,
        srcSample: imgs[0]?.getAttribute('src') ?? null,
      };
    });
    expect(imgStats.inView, '视口内应该至少有图片').toBeGreaterThan(0);
    expect(
      imgStats.brokenInView,
      `视口内有图片没加载（src 示例：${imgStats.srcSample}）`,
    ).toBe(0);
  });
});

test.describe('日期分组与月轴', () => {
  test('打开日期 → 出现分组与月轴；点某月跳到该月且不漏第一条', async ({ page, request }) => {
    const token = await freshUser(request);
    /* 两个月，每月两条；十月最新一条是"十月-新"，它必须能被月轴跳转带出来 */
    await seedRecords(request, token, [
      { eat: '十月-新', city: '成都', rating: 5, at: '2026-10-20T12:00' },
      { eat: '十月-旧', city: '成都', rating: 4, at: '2026-10-05T12:00' },
      { eat: '九月-新', city: '北京', rating: 3, at: '2026-09-18T12:00' },
      { eat: '九月-旧', city: '北京', rating: 2, at: '2026-09-02T12:00' },
    ]);
    await openAsUser(page, token);

    /* 默认没有月轴（日期分组关着） */
    await expect(page.locator('.axis__m')).toHaveCount(0);

    await page.locator('.iconbtn', { hasText: '日期' }).click();
    await expect(page.locator('.month')).toHaveCount(2); // 两个月份标题
    await expect(page.locator('.axis__m')).toHaveCount(2); // 轴上两个月份

    /* 点「09」跳九月 */
    await page.locator('.axis__m', { hasText: '09' }).click();
    await expect(page.locator('.axis__m--on')).toHaveText('09');

    /* 关键断言：九月最新那条「九月-新」必须在墙上（B7 的坑：用 firstCursor
       而不是 firstCursorInclusive 会把它漏掉） */
    await expect(page.locator('.tile__name', { hasText: '九月-新' })).toBeVisible();
    /* 十月的记录应该不在了（从该月第一条开始重铺） */
    await expect(page.locator('.tile__name', { hasText: '十月-新' })).toHaveCount(0);
  });
});

test.describe('删除与撤销', () => {
  test('删除后弹撤销条；点撤销记录回到墙上', async ({ page, request }) => {
    const token = await freshUser(request);
    await seedRecords(request, token, [{ eat: '待删除的菜', city: '成都', rating: 3 }]);
    await openAsUser(page, token);

    /* 进详情 */
    await page.locator('.tile').first().click();
    await expect(page.locator('.dp__name')).toHaveText('待删除的菜');

    /* 删除（无二次确认，直接删） */
    await page.locator('.dp__act', { hasText: '删除' }).click();

    /* 撤销条必须出现 */
    await expect(page.locator('.undo')).toBeVisible();
    await expect(page.locator('.undo__t')).toHaveText('已删除');

    /* A2：撤销窗口内不能再点「编辑/删除」。
       记录已在服务端软删，此时点编辑会进一个必然 404 的死链页面。 */
    await expect(page.locator('.dp__act', { hasText: '编辑' })).toHaveCount(0);
    await expect(page.locator('.dp__act', { hasText: '删除' })).toHaveCount(0);

    /* 点撤销 → 记录回来 */
    await page.locator('.undo__btn').click();
    await expect(page.locator('.undo')).toHaveCount(0);
    /* 撤销后操作入口回来 */
    await expect(page.locator('.dp__act', { hasText: '编辑' })).toBeVisible();

    /* 回墙确认记录还在 */
    await page.goto(`${BASE}?api=${encodeURIComponent(API_ORIGIN)}#/pages/wall/index`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.tile__name', { hasText: '待删除的菜' })).toBeVisible({ timeout: 10_000 });
  });

  test('撤销条 5 秒后自动消失（不点就真的删了）', async ({ page, request }) => {
    const token = await freshUser(request);
    await seedRecords(request, token, [{ eat: '五秒后消失', city: '成都', rating: 3 }]);
    await openAsUser(page, token);

    await page.locator('.tile').first().click();
    await page.locator('.dp__act', { hasText: '删除' }).click();
    await expect(page.locator('.undo')).toBeVisible();

    /* 等超过 5 秒窗口 */
    await expect(page.locator('.undo')).toHaveCount(0, { timeout: 8_000 });
  });
});

test.describe('编辑与返回刷新', () => {
  test('编辑保存后返回详情页，立即显示新内容', async ({ page, request }) => {
    const token = await freshUser(request);
    await seedRecords(request, token, [{ eat: '编辑前的菜', city: '成都', rating: 3 }]);
    await openAsUser(page, token);

    /* 进详情 → 编辑 */
    await page.locator('.tile').first().click();
    await expect(page.locator('.dp__name')).toHaveText('编辑前的菜', { timeout: 15_000 });
    await page.locator('.dp__act', { hasText: '编辑' }).click();

    /* 编辑页回填（编辑态是"从服务端/缓存拉回"的，等表单填好）。
       ⚠ 不能用 `.field__input--lead` 或 getByPlaceholder：Taro H5 的 Input 外层是
       <taro-input-core>、真正可填的是里面的 <input class="weui-input">，按 tag+placeholder 定位最稳。 */
    const eatInput = page.locator('input[placeholder="比如 甜水面"]');
    await expect(eatInput).toHaveValue('编辑前的菜', { timeout: 15_000 });
    await eatInput.fill('编辑后的菜');

    /* 保存 → 自动返回详情页；详情页必须重拉并显示新值（回归：P1-1） */
    await page.locator('.bar__main').click();
    await expect(page.locator('.dp__name')).toHaveText('编辑后的菜', { timeout: 20_000 });
  });
});

test.describe('城市筛选', () => {
  test('按城市筛选后墙上只剩该城市', async ({ page, request }) => {
    const token = await freshUser(request);
    /* 四川下要有**两个**城市才会进入二级 —— CityPicker 对"省内只有一城"
       （如北京/上海这类直辖市）是点一下直接落定的。 */
    await seedRecords(request, token, [
      { eat: '成都菜', city: '成都', rating: 5 },
      { eat: '乐山菜', city: '乐山', rating: 4 },
      { eat: '北京菜', city: '北京', rating: 4 },
    ]);
    await openAsUser(page, token);
    await expect(page.locator('.tile')).toHaveCount(3);

    /* 打开城市选择器 */
    await page.locator('.iconbtn', { hasText: '城市' }).click();
    await expect(page.locator('.citypick')).toBeVisible();
    /* 省份行来自 /records/cities（异步）：先等它出现再点，
       否则可能点到一个只有「全部」的空选择器 */
    await expect(page.locator('.citypick__row--prov').first()).toBeVisible({ timeout: 15_000 });

    /* 一级：省份行。用 .citypick__row--prov 精确定位，
       否则 hasText:'四川' 也可能命中城市名（虽然这里不会，但保持精确更稳） */
    await page.locator('.citypick__row--prov', { hasText: '四川' }).first().click();

    /* 二级：头部变成省名（动画 0.16s，toHaveText 自带轮询） */
    await expect(page.locator('.citypick__h')).toHaveText('四川');

    /* 二级：城市行（不带 --prov） */
    await page.locator('.citypick__row:not(.citypick__row--prov):not(.citypick__row--back)',
      { hasText: '成都' }).first().click();

    await expect(page.locator('.tile')).toHaveCount(1);
    await expect(page.locator('.tile__name', { hasText: '成都菜' })).toBeVisible();
    await expect(page.locator('.tile__name', { hasText: '乐山菜' })).toHaveCount(0);
    await expect(page.locator('.tile__name', { hasText: '北京菜' })).toHaveCount(0);

    /* A4：**筛选态**下点顶栏「城市」应该打开选择器，而不是清空筛选。
       以前这里会 applyCity(null) + 全量重载，换个城市要两步。 */
    await page.locator('.iconbtn', { hasText: '成都' }).click();
    await expect(page.locator('.citypick')).toBeVisible();
    /* 筛选没有被清掉：墙仍然只有成都那一条 */
    await expect(page.locator('.tile')).toHaveCount(1);
  });

  test('只有一城的省（北京）点一下直接落定，不进入二级', async ({ page, request }) => {
    const token = await freshUser(request);
    await seedRecords(request, token, [
      { eat: '北京菜', city: '北京', rating: 4 },
      { eat: '成都菜', city: '成都', rating: 5 },
      { eat: '乐山菜', city: '乐山', rating: 3 },
    ]);
    await openAsUser(page, token);

    await page.locator('.iconbtn', { hasText: '城市' }).click();
    await expect(page.locator('.citypick')).toBeVisible();
    await expect(page.locator('.citypick__row--prov').first()).toBeVisible({ timeout: 15_000 });

    /* 一级的「北京」省份行（直辖市省名=市名，所以必须用 --prov 限定，
       否则会同时匹配到可能存在的城市行） */
    await page.locator('.citypick__row--prov', { hasText: '北京' }).first().click();

    /* 直接生效，选择器关闭 */
    await expect(page.locator('.citypick')).toHaveCount(0);
    await expect(page.locator('.tile')).toHaveCount(1);
    await expect(page.locator('.tile__name', { hasText: '北京菜' })).toBeVisible();
  });
});

test.describe('分享落地页', () => {
  test('未登录也能打开被分享的记录，且没有任何操作入口（编辑/删除/这家店）', async ({ request, context }) => {
    const token = await freshUser(request);
    /* 带店名：A8 要求分享落地页连「这家店」入口也不出现
       （后端 /shops/by-name 按浏览者账号过滤，访客点了只会看到空店） */
    await seedRecords(request, token, [
      { eat: '分享出去的菜', shop: '分享小馆', city: '成都', rating: 5 },
    ]);

    /* 通过接口开分享，拿 token 与记录 id */
    const listRes = await request.get(`${API}/records?limit=1`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const { items } = await listRes.json();
    const rec = items[0];
    const shareRes = await request.post(`${API}/records/${rec.id}/share`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const { shareToken } = await shareRes.json();

    /* 全新 context（无任何 localStorage）= 模拟"从没登录过的人"。
       用 `?api=` 一次性打开：页面首次加载就能读到 query，origin 立即生效。 */
    const anonPage = await context.newPage();
    await anonPage.goto(
      `${BASE}?api=${encodeURIComponent(API_ORIGIN)}#/pages/detail/index?id=${encodeURIComponent(rec.id)}&share=${encodeURIComponent(shareToken)}`,
      { waitUntil: 'domcontentloaded' },
    );

    await expect(anonPage.locator('.dp__name')).toHaveText('分享出去的菜', { timeout: 15_000 });
    /* 只读：不该出现编辑/删除 */
    await expect(anonPage.locator('.dp__act')).toHaveCount(0);
    /* 也不该写入登录态（落地页是免登录的） */
    const hasToken = await anonPage.evaluate(() => !!localStorage.getItem('photo-wall:tokens:v1'));
    expect(hasToken, '分享落地页不应触发登录').toBe(false);

    await anonPage.close();
  });

  test('撤销分享后旧链接打不开', async ({ request, context }) => {
    const token = await freshUser(request);
    await seedRecords(request, token, [{ eat: '即将失效', city: '成都', rating: 4 }]);
    const listRes = await request.get(`${API}/records?limit=1`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const rec = (await listRes.json()).items[0];
    const shareRes = await request.post(`${API}/records/${rec.id}/share`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const { shareToken } = await shareRes.json();
    await request.delete(`${API}/records/${rec.id}/share`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    const anonPage = await context.newPage();
    await anonPage.goto(
      `${BASE}?api=${encodeURIComponent(API_ORIGIN)}#/pages/detail/index?id=${encodeURIComponent(rec.id)}&share=${encodeURIComponent(shareToken)}`,
      { waitUntil: 'domcontentloaded' },
    );
    /* 应落到「这一条已经不在了」空态，而不是内容 */
    await expect(anonPage.locator('.dp__name')).toHaveCount(0, { timeout: 15_000 });
    await anonPage.close();
  });
});

test.describe('运行时后端覆盖白名单', () => {
  test('localStorage 里的公网后端会被拒绝并清掉', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('photo-wall:api-origin', 'https://evil.example');
    });
    await page.goto(`${BASE}#/pages/wall/index`, { waitUntil: 'domcontentloaded' });
    /* 应用启动（首个请求解析 baseURL）时不采用该值：localStorage 必须被清掉。
       旧实现会原样保留并把请求发过去，这条断言就会失败。 */
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('photo-wall:api-origin')), {
        timeout: 20_000,
      })
      .toBeNull();
  });
});

/* 放在最后：它会切换网络状态，虽然 finally 恢复，但排最后更稳 */
test.describe('离线只读降级', () => {
  test('断网后：不白屏，且写操作不会假装成功', async ({ page, request, context }) => {
    const token = await freshUser(request);
    await seedRecords(request, token, [{ eat: '离线也能看', city: '成都', rating: 5 }]);
    /* 记住记录 id：断网后要直接导航到详情页（点 tile 会因为墙进骨架态而不可点） */
    const listRes = await request.get(`${API}/records?limit=1`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const firstRecordId = (await listRes.json()).items[0].id;

    await openAsUser(page, token);
    await expect(page.locator('.tile')).toHaveCount(1);

    /* 先联网进一次详情，再回来。
       为什么必须这样：H5 的详情页是**按路由懒加载**的独立 chunk，
       从没访问过时断网根本拿不到那个 chunk（页面会空白 —— 那是资源加载
       失败，不是我们的降级逻辑）。先访问一次让 chunk 进缓存，
       才能测"已加载的应用在 API 失败时如何降级"。 */
    await page.locator('.tile').first().click();
    await expect(page.locator('.dp__name')).toHaveText('离线也能看', { timeout: 15_000 });
    await page.goto(`${BASE}#/pages/wall/index`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.tile')).toHaveCount(1);

    /* 断网。**不能 reload** —— 页面资源在本地静态服务上，断网后连 HTML 都拿不到。 */
    await context.setOffline(true);

    try {
      /* 再进详情。这里**直接导航到详情 hash**，而不是点 tile：
         断网后回墙时 onShow 会触发 refreshIfStale → 失败 → 墙可能进骨架/错误态，
         此时 tile 不可点。直接导航更贴近"用户手上有链接/后退回到详情"的场景，
         也避开与本次要验证的东西（API 失败时的降级）无关的干扰。 */
      await page.goto(
        `${BASE}#/pages/detail/index?id=${encodeURIComponent(firstRecordId)}`,
        { waitUntil: 'domcontentloaded' },
      );
      const detailState = page.locator('.dp');
      await expect(detailState.first()).toBeVisible({ timeout: 15_000 });

      /* 如果渲染出了删除按钮，点它绝不能出现撤销条 */
      const del = page.locator('.dp__act', { hasText: '删除' });
      if (await del.count()) {
        await del.click();
        await expect(page.locator('.undo')).toHaveCount(0, { timeout: 3_000 });
      }
    } finally {
      /* ⚠ 必须在 finally 里恢复：若上面任何断言失败，offline 状态会泄漏到
         后续用例（Playwright 的 context 按用例隔离，但同一 worker 复用浏览器，
         某些情况下残留会影响网络层），表现为"莫名连不上后端"的连锁失败。 */
      await context.setOffline(false);
    }

    /* 恢复网络后确认数据没被真删 */
    const check = await request.get(`${API}/records?limit=5`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = await check.json();
    expect(body.total, '离线时不该真的删掉记录').toBe(1);
  });
});
