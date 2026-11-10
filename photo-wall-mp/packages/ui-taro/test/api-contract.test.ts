/**
 * API 契约测试（P1-11）
 * ----------------------------------------------------------------
 * 把 `packages/ui-taro/src/api/index.ts` 里**真正发出的**接口调用，
 * 跟 `docs/api/openapi.yaml` 契约逐条对碰，校验前端只调用了契约里
 * 允许的表面（method + 路径存在）、只发送契约里声明的 query 参数、
 * 并且鉴权姿态（公开 / 需登录）与契约一致。
 *
 * 设计要点：
 *   · 不依赖 Taro 运行时，也不 mock `Taro.request`。直接**静态抽取**
 *     `request(...)` / `upload(...)` 的字面量实参 + 选项对象，所以一旦
 *     `src/api/index.ts` 与契约漂移，本测试会**红**。
 *   · 反向（契约里每个接口前端都实现）属于“覆盖率”目标，容易因
 *     某些接口前端暂未使用而误报，这里不做硬性断言，只在报告里跟踪。
 *
 * 运行：`npm test`（= `node --test test/*.test.ts`，Node ≥ 22.6 原生去类型）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const HERE = dirname(fileURLToPath(import.meta.url));
// 契约查找顺序（见 tools/sync-contract.mjs）：
//   1. CONTRACT_OPENAPI 环境变量（显式指定）
//   2. 兄弟仓库真源（本地开发，永远最新）
//   3. test/fixtures/openapi.yaml（CI / 本仓独立检出）
const SIBLING_OPENAPI = join(
  HERE,
  '..',
  '..',
  '..',
  '..',
  'photo-wall-api',
  'docs',
  'api',
  'openapi.yaml',
);
const FIXTURE_OPENAPI = join(HERE, 'fixtures', 'openapi.yaml');
const OPENAPI_PATH = [process.env.CONTRACT_OPENAPI, SIBLING_OPENAPI, FIXTURE_OPENAPI].find(
  (p): p is string => Boolean(p) && existsSync(p as string),
);
const INDEX_PATH = join(HERE, '..', 'src', 'api', 'index.ts');

// ---------- 路径归一化：把路径参数占位统一成 `{}` ----------
//   源码：`/records/${encodeURIComponent(id)}` → `/records/{}`
//   契约：`/records/{id}`                  → `/records/{}`
function normalizePath(p: string): string {
  return p
    .replace(/\$\{[^}]*\}/g, '{}') // 模板字符串里的 ${...}
    .replace(/\{[^}]*\}/g, '{}'); // 契约里的 {paramName}
}

// ---------- 从源码静态抽取 request / upload 调用 ----------
interface CallSite {
  fn: 'request' | 'upload';
  method: string;
  path: string;
  queryKeys: string[];
  auth: boolean; // 显式 auth:false → false；其余（含缺省）→ true
  line: number;
}

function skipWs(s: string, i: number): number {
  while (i < s.length && /\s/.test(s[i])) i++;
  return i;
}

function readString(s: string, i: number): { value: string; next: number } {
  const quote = s[i];
  assert.ok(
    quote === "'" || quote === '"' || quote === '`',
    `期望字符串字面量，位置 ${i}`,
  );
  let j = i + 1;
  let out = '';
  while (j < s.length && s[j] !== quote) {
    if (quote === '`' && s[j] === '$' && s[j + 1] === '{') {
      // 把模板字符串里的 ${...} 插值记成 `{}` 占位，便于后续归一化
      let depth = 0;
      let k = j + 1;
      for (; k < s.length; k++) {
        if (s[k] === '{') depth++;
        else if (s[k] === '}') {
          depth--;
          if (depth === 0) break;
        }
      }
      out += '{}';
      j = k + 1;
      continue;
    }
    if (s[j] === '\\') {
      out += s[j + 1];
      j += 2;
    } else {
      out += s[j];
      j++;
    }
  }
  return { value: out, next: j + 1 };
}

function readBalanced(s: string, i: number): { value: string; next: number } {
  assert.equal(s[i], '{', `期望 {，位置 ${i}`);
  let depth = 0;
  let j = i;
  for (; j < s.length; j++) {
    const c = s[j];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        return { value: s.slice(i, j + 1), next: j + 1 };
      }
    } else if (c === "'" || c === '"' || c === '`') {
      // 跳过字符串里的括号，避免误判深度
      const q = c;
      j++;
      while (j < s.length && s[j] !== q) {
        if (s[j] === '\\') j++;
        j++;
      }
    }
  }
  throw new Error(`未闭合的 {，位置 ${i}`);
}

function extractCalls(src: string): CallSite[] {
  const calls: CallSite[] = [];
  const re = /\b(request|upload)\s*(?:<[^>]*>)?\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const fn = m[1] as 'request' | 'upload';
    let i = skipWs(src, re.lastIndex);
    const line = src.slice(0, m.index).split('\n').length;

    let method: string;
    let path: string;
    if (fn === 'request') {
      const ms = readString(src, i);
      method = ms.value.toUpperCase();
      i = skipWs(src, ms.next);
      assert.equal(src[i], ',', `request 第二参数前应有逗号，位置 ${i}`);
      i = skipWs(src, i + 1);
      const ps = readString(src, i);
      path = ps.value;
      i = ps.next;
    } else {
      // upload(path, filePath, options?)
      const ps = readString(src, i);
      path = ps.value;
      method = 'POST';
      i = ps.next;
    }

    // 选项对象（第三个参数）：跳过逗号与空白后，若遇到 { 则读取它
    let optionsStr = '';
    i = skipWs(src, i);
    if (src[i] === ',') {
      i = skipWs(src, i + 1);
      if (src[i] === '{') {
        const bal = readBalanced(src, i);
        optionsStr = bal.value;
      }
    }

    // query 对象的键集合
    const queryKeys: string[] = [];
    const qm = /query\s*:\s*\{/.exec(optionsStr);
    if (qm) {
      const bal = readBalanced(optionsStr, qm.index + qm[0].length - 1);
      const inner = bal.value.slice(1, -1);
      // 只取对象属性键：必须紧跟在 {（对象首键）或 , 之后
      // （排除三元表达式里的 `true:`/`false:`）。首键前没有 , 所以用 ^ 兜底。
      const km = /(^|[{,])\s*([A-Za-z_$][\w$]*)\s*:/g;
      let k: RegExpExecArray | null;
      while ((k = km.exec(inner))) queryKeys.push(k[2]);
    }

    // auth 姿态
    const am = /auth\s*:\s*(false|true)/.exec(optionsStr);
    const auth = am ? am[1] === 'true' : true;

    calls.push({ fn, method, path, queryKeys, auth, line });
  }
  return calls;
}

// ---------- 从 openapi 解析契约期望 ----------
interface Expected {
  method: string;
  path: string; // 归一化
  queryParams: Set<string>;
  publicAccess: boolean; // true = 免鉴权（security: []）
}

function buildExpected(doc: any): Map<string, Expected> {
  const map = new Map<string, Expected>();
  const params = doc.components?.parameters ?? {};
  const globalSecurity = doc.security;

  const resolveParam = (p: any): any => {
    if (p && p.$ref) {
      const name = p.$ref.split('/').pop();
      return params[name];
    }
    return p;
  };

  for (const [rawPath, pathItem] of Object.entries<any>(doc.paths ?? {})) {
    const normPath = normalizePath(rawPath);
    for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
      const op = pathItem?.[method];
      if (!op) continue;

      const queryParams = new Set<string>();
      for (const p of op.parameters ?? []) {
        const rp = resolveParam(p);
        if (rp && rp.in === 'query' && rp.name) queryParams.add(rp.name);
      }

      // 鉴权：operation > path > global；显式 [] 即公开
      const sec = op.security ?? pathItem.security ?? globalSecurity;
      const publicAccess = Array.isArray(sec) && sec.length === 0;

      map.set(`${method.toUpperCase()} ${normPath}`, {
        method: method.toUpperCase(),
        path: normPath,
        queryParams,
        publicAccess,
      });
    }
  }
  return map;
}

// ---------- 主测试 ----------
test('前端 API 调用全部符合 openapi 契约', () => {
  assert.ok(
    OPENAPI_PATH,
    `找不到契约文件。查找过：CONTRACT_OPENAPI、${SIBLING_OPENAPI}、${FIXTURE_OPENAPI}。\n` +
      '在本仓独立检出的环境里请先 sync 一次快照：npm run sync:contract',
  );
  const openapiRaw = readFileSync(OPENAPI_PATH!, 'utf8');
  const doc = yaml.load(openapiRaw) as any;
  const expected = buildExpected(doc);

  const src = readFileSync(INDEX_PATH, 'utf8');
  const calls = extractCalls(src);

  assert.ok(calls.length > 0, '没从 src/api/index.ts 抽取到任何 request/upload 调用');
  assert.ok(expected.size > 0, '契约里没有任何路径，openapi.yaml 可能没解析到');

  const extraEndpoints = new Set<string>(); // 契约里没有、前端却发的
  for (const c of calls) {
    const key = `${c.method} ${normalizePath(c.path)}`;
    const exp = expected.get(key);
    if (!exp) {
      extraEndpoints.add(`L${c.line}: ${key}`);
      continue;
    }
    // 1) query 参数必须是契约声明的子集
    for (const q of c.queryKeys) {
      assert.ok(
        exp.queryParams.has(q),
        `L${c.line}: ${key} 发送了契约未声明的 query 参数 "${q}"（契约允许：${[
          ...exp.queryParams,
        ].join(', ') || '（无）'}）`,
      );
    }
    // 2) 鉴权姿态必须匹配
    if (exp.publicAccess) {
      assert.equal(
        c.auth,
        false,
        `L${c.line}: ${key} 是免鉴权接口（契约 security: []），但前端没传 auth:false`,
      );
    } else {
      assert.notEqual(
        c.auth,
        false,
        `L${c.line}: ${key} 是需登录接口，但前端显式传了 auth:false`,
      );
    }
  }

  assert.equal(
    extraEndpoints.size,
    0,
    `前端调用了契约里不存在的接口：\n  - ${[...extraEndpoints].join('\n  - ')}`,
  );
});
