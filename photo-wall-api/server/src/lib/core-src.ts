/**
 * 定位前端 core 源码目录（`packages/core/src`）。
 *
 * 为什么要单独一个文件：这个路径被 **scripts/gen-data.mjs** 和
 * **test/aggregate-parity.test.ts**、**test/shared-limits.test.ts** 三处用到，
 * 各自抄一份探测逻辑迟早会抄歪。
 *
 * 为什么不写死绝对路径（教训）：
 *   早期版本把源码位置写死在某台机器的绝对路径下，工作区一旦整体搬迁
 *   （换目录 / 换电脑 / CI 里 clone 到别处），那条路径直接失效，
 *   而症状是「找不到常量 / 跳过前端一致性校验」——
 *   离真正的原因（整块目录被搬了）很远，且**不报错**，
 *   只会悄悄少跑一批测试。
 *
 * 候选顺序：
 *   1. 环境变量 PHOTO_WALL_SRC（显式指定优先，便于非标准布局）
 *   2. 同级 workspace 里的 photo-wall-mp/packages/core/src（当前布局，相对探测）
 *
 * 找不到时返回第一个候选 —— 让调用方的报错信息里带上真实路径，
 * 而不是静默跳过。
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 本文件所在目录（dist/ 与 src/ 都会被编译到，路径深度相同） */
const HERE = dirname(fileURLToPath(import.meta.url));

export function resolveCoreSrc(): string {
  if (process.env.PHOTO_WALL_SRC) return resolve(process.env.PHOTO_WALL_SRC);

  const candidates = [
    // <workspace>/photo-wall-api/server/{src,dist}/lib → 上溯到 <workspace>
    resolve(HERE, '..', '..', '..', '..', 'photo-wall-mp', 'packages', 'core', 'src'),
  ];
  for (const c of candidates) {
    if (existsSync(join(c, 'geo.ts'))) return c;
  }
  return candidates[0];
}

/** 前端 core 源码是否可用（不可用时相关测试应跳过，而不是失败） */
export function coreSrcAvailable(src: string = resolveCoreSrc()): boolean {
  return (
    existsSync(join(src, 'geo.ts')) &&
    existsSync(join(src, 'stats.ts')) &&
    existsSync(join(src, 'records.ts'))
  );
}
