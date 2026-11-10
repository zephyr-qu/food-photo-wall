/**
 * 预置图资源目录定位 —— `/v1/files/:name` 的第二回退目录。
 *
 * 为什么需要它：前端把 12 张预置菜品图 + 2 张分享封面交给「我方托管」
 * （见 packages/ui-taro/src/utils/asset.ts 的 resolveAssetUrl()：一旦设了
 * TARO_APP_ASSET_BASE，就把 `/static/img/x.jpg` 拍平成 `<base>/x.jpg` 发出去，
 * 主包体积因此只有 472.7 KB）。mock 一直在 `/files/:name` 里回退读
 * server/static/img（见 mock 的 routes.js），而本服务原先只认 `pho_*` 上传文件，
 * 于是「ASSET_BASE 指向真后端」时这 12 张图全部 404 —— 一个只在发布构建
 * 才会炸的坑：本地 .env.local 指向 mock，联调时永远看不到。
 *
 * 候选顺序（第一个命中的胜出）：
 *   1. PRESET_ASSET_DIR（部署时显式指到挂载盘 / CDN 回源目录）
 *   2. <server>/static/img（资源随服务一起发；容器镜像里最省事）
 *   3. workspace 内 photo-wall-mp/packages/ui-taro/src/static/img（仓库现状，唯一真源）
 *   4. workspace 内 photo-wall-mp/server/static/img（mock 的那份拷贝）
 *
 * 与 lib/core-src.ts 同一个教训：不写死绝对路径。工作区一旦整体搬迁
 * （换目录 / 换电脑 / CI 里 clone 到别处），硬编码路径的症状是「静默少跑一批
 * 东西」；这里更糟 —— 静默裂图。
 *
 * 找不到时返回 null（调用方据此只服务上传文件，并在启动日志里说清楚）。
 */
import { existsSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 本文件所在目录：<server>/src/lib 或 <server>/dist/src/lib */
const HERE = dirname(fileURLToPath(import.meta.url));

/** 目录里是否至少有一张图（只判空目录不够：空挂载盘要算「不可用」） */
function hasImages(dir: string): boolean {
  if (!existsSync(dir)) return false;
  try {
    return readdirSync(dir).some((f) => /\.(jpe?g|png|webp|gif)$/i.test(f));
  } catch {
    return false;
  }
}

export function resolvePresetAssetDir(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.PRESET_ASSET_DIR) {
    const explicit = resolve(env.PRESET_ASSET_DIR);
    return hasImages(explicit) ? explicit : null;
  }

  const candidates = [
    /* 随服务一起发的资源目录 */
    resolve(HERE, '..', '..', 'static', 'img'),
    /* src/lib → 上溯 4 层到 workspace；dist/src/lib 要多一层 */
    resolve(HERE, '..', '..', '..', '..', 'photo-wall-mp', 'packages', 'ui-taro', 'src', 'static', 'img'),
    resolve(HERE, '..', '..', '..', '..', '..', 'photo-wall-mp', 'packages', 'ui-taro', 'src', 'static', 'img'),
    /* mock 那份拷贝（老布局兜底） */
    resolve(HERE, '..', '..', '..', '..', 'photo-wall-mp', 'server', 'static', 'img'),
    resolve(HERE, '..', '..', '..', '..', '..', 'photo-wall-mp', 'server', 'static', 'img'),
  ];
  for (const c of candidates) {
    if (hasImages(c)) return c;
  }
  return null;
}
