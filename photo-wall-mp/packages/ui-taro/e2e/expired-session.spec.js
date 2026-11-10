// @ts-check
/**
 * 回归验证：accessToken 过期后的首屏 / 详情 / 随机一道。
 *
 * 背景（用户报的 bug）：
 *   「点击美食详情加载有点久啊，而且随机一道 又卡住了」
 *
 * 根因：accessToken 过期后，墙首屏并发发出 4 个请求（records/cities/months/stats），
 * 它们**全部**看到过期 token → 全部 401 → 全部去 refresh；
 * 而服务端的 refreshToken 是**轮换**的（旧的立刻作废），并发刷新只有一发成功，
 * 输的那些又各自清会话 + 重新登录 —— 登录接口限流 10/min/IP，
 * 几轮就把额度打光 → 429 → 墙是空的 / 详情加载不出来 / 随机一道点了没反应。
 *
 * 本用例断言：过期 token 下，首屏**一次登录**就能拿到数据（不触发限流），
 * 详情能打开，随机一道能出结果。
 */
import { test, expect } from '@playwright/test';

const BASE = process.env.E2E_BASE ?? 'http://127.0.0.1:5195/';
const API = process.env.E2E_API ?? 'http://127.0.0.1:8787/v1';
const API_ORIGIN = API.replace(/\/v1$/, '');

async function freshSession() {
  const deviceId = `exp-${crypto.randomUUID()}`;
  const res = await fetch(`${API}/auth/anonymous`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId }),
  });
  expect(res.ok, `匿名登录失败：${res.status}`).toBeTruthy();
  return res.json();
}

async function seed(token, rows) {
  for (const r of rows) {
    const res = await fetch(`${API}/records`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(r),
    });
    expect(res.status, `造数据失败: ${JSON.stringify(r)} → ${res.status}`).toBe(201);
  }
}

/**
 * 注入一个「accessToken 已过期、refreshToken 仍有效」的会话。
 *
 * 这正是用户长时间不用之后回到 App 的状态（accessToken TTL 2h）。
 */
async function openWithExpiredToken(page, refreshToken) {
  await page.addInitScript(
    ({ rt, origin }) => {
      localStorage.setItem('photo-wall:api-origin', origin);
      localStorage.setItem(
        'photo-wall:tokens:v1',
        JSON.stringify({
          data: {
            accessToken: 'EXPIRED.access.token.value',
            refreshToken: rt,
            expiresAt: Date.now() - 1000, // 已过期
          },
        }),
      );
    },
    { rt: refreshToken, origin: API_ORIGIN },
  );
  await page.goto(`${BASE}#/pages/wall/index`, { waitUntil: 'domcontentloaded' });
}

test.describe('过期会话 · 自愈', () => {
  test('accessToken 过期：首屏一次登录即可恢复，不触发限流', async ({ page }) => {
    const session = await freshSession();
    await seed(session.accessToken, [
      { eat: '过期恢复 龙抄手', city: '成都', rating: 5, at: '2026-10-01T12:00' },
      { eat: '过期恢复 钵钵鸡', city: '乐山', rating: 4, at: '2026-09-15T12:00' },
    ]);

    /* 记录 /auth/* 的调用次数：自愈路径**最多一次** refresh（不是 4 次） */
    const authCalls = [];
    page.on('response', (res) => {
      if (res.url().includes('/auth/')) {
        authCalls.push({ url: res.url().replace(API_ORIGIN, ''), status: res.status() });
      }
    });

    await openWithExpiredToken(page, session.refreshToken);

    /* 墙必须真的渲染出记录（不是空墙、不是错误态） */
    await expect(page.locator('.tile')).toHaveCount(2, { timeout: 20_000 });

    /* 关键断言：/auth 只应被调用**一次**（单飞刷新）。
       以前是 4 次并发 refresh + 若干次重新登录 → 429。 */
    const refreshCalls = authCalls.filter((c) => c.url.includes('/auth/refresh'));
    expect(
      refreshCalls.length,
      `并发刷新次数应为 1，实际 ${refreshCalls.length}：${JSON.stringify(authCalls)}`,
    ).toBeLessThanOrEqual(1);
    expect(
      authCalls.filter((c) => c.status === 429).length,
      `不应出现 429：${JSON.stringify(authCalls)}`,
    ).toBe(0);
  });

  test('accessToken 过期：详情页能打开', async ({ page }) => {
    const session = await freshSession();
    await seed(session.accessToken, [
      { eat: '过期详情 龙抄手', city: '成都', rating: 5, at: '2026-10-01T12:00' },
    ]);
    await openWithExpiredToken(page, session.refreshToken);
    await expect(page.locator('.tile')).toHaveCount(1, { timeout: 20_000 });

    await page.locator('.tile').first().click();
    await expect(page.locator('.dp__name')).toHaveText('过期详情 龙抄手', { timeout: 20_000 });
  });

  test('accessToken 过期：随机一道能出结果', async ({ page }) => {
    const session = await freshSession();
    await seed(session.accessToken, [
      { eat: '过期随机 龙抄手', city: '成都', rating: 5, at: '2026-10-01T12:00' },
    ]);
    await openWithExpiredToken(page, session.refreshToken);
    await expect(page.locator('.tile')).toHaveCount(1, { timeout: 20_000 });

    await page.locator('.dice').click();
    await expect(page.locator('.spot')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('.spot__name')).toHaveText('过期随机 龙抄手');
  });

  test('双击「随机一道」不会并发打出多个请求', async ({ page }) => {
    const session = await freshSession();
    await seed(session.accessToken, [
      { eat: '双击测试 A', city: '成都', rating: 5, at: '2026-10-01T12:00' },
      { eat: '双击测试 B', city: '乐山', rating: 4, at: '2026-09-15T12:00' },
    ]);
    await openWithExpiredToken(page, session.refreshToken);
    await expect(page.locator('.tile')).toHaveCount(2, { timeout: 20_000 });

    const randomCalls = [];
    page.on('request', (req) => {
      if (req.url().includes('/records/random')) randomCalls.push(req.url());
    });

    /* 快速双击 */
    const dice = page.locator('.dice');
    await dice.click();
    await dice.click({ force: true }).catch(() => {});
    await page.waitForTimeout(1500);

    expect(
      randomCalls.length,
      `双击应只发出 1 个随机请求，实际 ${randomCalls.length}`,
    ).toBeLessThanOrEqual(1);
  });
});
