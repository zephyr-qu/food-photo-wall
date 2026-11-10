/**
 * 生成一个带 12 条示例记录的演示账号，并打印 token（便于前端联调）。
 * 用法：npm run seed [deviceId]
 *      默认 deviceId = demo-device
 */
import { createApp } from '../src/app.js';

const deviceId = process.argv[2] ?? 'demo-device';

const { app, services, close } = await createApp({
  config: { seedDemoRecords: true },
});

try {
  const loginRes = await app.request('/v1/auth/anonymous', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId }),
  });
  const session = (await loginRes.json()) as {
    accessToken: string;
    refreshToken: string;
    userId: string;
    isNewUser: boolean;
    user: { recordCount: number };
  };

  const auth = { Authorization: `Bearer ${session.accessToken}` };
  const stats = (await (await app.request('/v1/stats', { headers: auth })).json()) as {
    total: number;
    fiveCount: number;
    cities: number;
    shops: number;
    avgRating: number;
  };

  if (!session.isNewUser && session.user.recordCount === 0) {
    console.warn('⚠ 该 deviceId 已存在但没有记录；示例数据只注入新用户。换个 deviceId 再试。');
  }

  console.log('\n=== 演示账号 ===');
  console.log('deviceId     ', deviceId);
  console.log('userId       ', session.userId);
  console.log('记录数       ', stats.total);
  console.log('统计         ', `五分 ${stats.fiveCount} / 城市 ${stats.cities} / 店铺 ${stats.shops} / 均分 ${stats.avgRating}`);
  console.log('\naccessToken  ', session.accessToken);
  console.log('refreshToken ', session.refreshToken);
  console.log('\n试一下：');
  console.log(`  curl -H "Authorization: Bearer <token>" http://localhost:${services.cfg.port}/v1/records?limit=3`);
  console.log(`  存储后端：${services.cfg.storage}${services.cfg.storage === 'sqlite' ? ` (${services.cfg.sqliteFile})` : '（纯内存）'}\n`);
} finally {
  await close();
}
