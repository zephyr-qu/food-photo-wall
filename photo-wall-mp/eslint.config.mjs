/* ================================================================
   ESLint 扁平配置（ESLint 9）

   目标不是"零警告"，而是抓住三类真实问题：
   1. 未使用变量/导入（项目里曾有一批没人引用的死函数）
   2. 明显的逻辑坑（比如再赋值、丢 return）
   3. TS 层面的可疑写法
   ================================================================ */
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  /* 不检查产物与依赖 */
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/dist-web/**',
      '**/dist-h5/**',
      '**/.swc/**',
      '**/.taro/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  /* 通用：TS/TSX 源码 */
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.browser,
        /* Taro 的编译期宏 */
        defineAppConfig: 'readonly',
        definePageConfig: 'readonly',
      },
    },
    rules: {
      /* 死代码：未使用的变量/参数是本次评审发现最多的问题 */
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      /* 允许显式 any（项目 strict=false，逐步收紧，不追求一次到位） */
      '@typescript-eslint/no-explicit-any': 'off',
      /* 空接口/空函数在此项目里偶有用途（如空 catch） */
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/no-empty-function': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
      /* 允许 console（小项目直接用 console.warn 留痕） */
      'no-console': 'off',
      eqeqeq: ['error', 'smart'],
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },

  /* 测试文件：允许用 node:test 的断言风格 */
  {
    files: ['**/test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },

  /* 配置文件是 CommonJS */
  {
    files: ['**/*.config.js', '**/config/**/*.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
      'no-undef': 'off',
    },
  },

  /* 构建/检查脚本是 ESM 的 .mjs：需要 node globals（process/console/fetch/setTimeout）。
     以前这里没配，`npm run lint` 会因为这批文件报 60+ 个 no-undef —— 于是
     「提交前跑 verify」实际上没人跑 lint，lint 长期是红的（本次评审发现）。 */
  {
    files: ['**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },

  /* Playwright 端到端用例跑在 Node 里，但 page.evaluate / addInitScript 的
     回调体是在**浏览器**里执行的（localStorage/document/window/fetch）。
     两套 globals 都要给，否则要么误报 no-undef，要么有人加 eslint-disable
     把整段检查关掉。 */
  {
    files: ['**/e2e/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser },
    },
  },
);
