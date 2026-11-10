/**
 * Taro 工程配置。
 *
 * 1. designWidth: 750 —— 尺寸一律用 rpx 书写（750rpx = 屏宽 = 390pt），
 *    pxtransform 保持开启，由框架换算。样式里不要混写 px。
 * 2. 导航栏：用**原生**导航栏（app.config.ts 的 window 配色跟随页面底色），
 *    没有开 navigationStyle: 'custom'。
 * 3. sass 只用于变量，具体样式还是写 scss。
 */
const path = require('path');

/* 目标平台：Taro CLI 在加载本配置之前就写好了 TARO_ENV（cli.js 里 args.type）。
   默认按小程序处理，只有明确 build h5 时才切到 h5。 */
const isH5 = process.env.TARO_ENV === 'h5';

/* 产物目录必须跟着平台走，而且要放在**顶层** outputRoot 上。
   原因：Taro 清空输出目录时用的是 ctx.paths.outputPath，
   它来自 Kernel.initPaths → `this.initialConfig.outputRoot`（顶层），
   并不看 h5.outputRoot。之前顶层恒为 'dist'，于是 `build:h5` 会把
   小程序产物整个清空，再把 h5 产物写进 dist-web —— 一次 h5 构建就把
   微信开发者工具里的包清成空壳。 */
const outputRoot = isH5 ? 'dist-web' : 'dist';

/* 静态资源 CDN（P1-8）：设置 TARO_APP_ASSET_BASE 时，jpg 引用改走远端
   （见 src/utils/asset.ts），这里跳过把 src/static/img/*.jpg 拷进产物 —— 主包少 ~820 KB；
   png（UI 图标）始终留包内。未设置时 jpg+png 全进包，行为完全不变。
   ⚠ 前提：jpg 已按文件名上传到该 base（${base}/boboboji.jpg 之类能 200）。 */
const assetBase = (process.env.TARO_APP_ASSET_BASE || '').trim();

/* ---------------- 生产构建守卫（P1-7） ----------------
   正式发版必须显式配置后端 origin：否则产物会把 `http://localhost:8787`
   内联进去，真机首屏全部连不上（H5 侧会退回"页面同 host:8787"，同样不可信）。
   为什么用独立的 RELEASE=1 而不是只看 NODE_ENV：本地 `npm run verify`、
   E2E 构建、日常预览也都走 NODE_ENV=production，不能一刀切卡死。
   用法：RELEASE=1 TARO_APP_API_ORIGIN=https://api.example.com npm run build:weapp
   注意在 Windows cmd 下请用 `set RELEASE=1` 或 bash；CI 里直接写环境变量即可。 */
if (process.env.NODE_ENV === 'production' && process.env.RELEASE === '1') {
  const apiOrigin = (process.env.TARO_APP_API_ORIGIN || '').trim();
  if (!apiOrigin) {
    throw new Error(
      '[build] RELEASE=1 但没有设置 TARO_APP_API_ORIGIN：拒绝产出一个真机连不上后端的包。\n' +
        '  示例：RELEASE=1 TARO_APP_API_ORIGIN=https://api.example.com npm run build:weapp',
    );
  }
  if (!/^https?:\/\/[^/]+/.test(apiOrigin)) {
    throw new Error(
      `[build] TARO_APP_API_ORIGIN 必须是完整的 http(s) origin（不要带路径）：${apiOrigin}`,
    );
  }
}

const config = {
  projectName: 'photo-wall-taro',
  date: '2026-10-26',
  designWidth: 750,
  deviceRatio: {
    640: 2.34 / 2,
    750: 1,
    828: 1.81 / 2,
  },
  sourceRoot: 'src',
  outputRoot,
  plugins: [],
  defineConstants: {},
  /* monorepo：@photo-wall/core 是 workspace 包，源码在 ../core/src。
     这里显式加别名，避免依赖 node_modules 软链（Windows 上软链常出问题）。 */
  alias: {
    '@photo-wall/core': path.resolve(__dirname, '../../core/src/index.ts'),
  },
  /* 静态图片必须显式 copy：Taro 只处理 JS/样式里的引用，
     `src/static/img/*.jpg` 不会被自动打进产物，导致 <Image src> 404。
     to 是相对项目根，只往当前平台的产物目录拷一份（以前两个目录都拷，
     结果 build:h5 时在 dist/ 里凭空留下一个 static/）。 */
  copy: {
    patterns: [
      /* png（camera/dice 这类 UI 图标）始终留包内，且平铺到 static/img/ 下 */
      { from: 'src/static/img/camera.png', to: `${outputRoot}/static/img/camera.png` },
      { from: 'src/static/img/dice.png', to: `${outputRoot}/static/img/dice.png` },
      /* jpg（预置菜图 + 分享封面，约 820KB）仅在未开启 ASSET_BASE 时进包；
         开启时改走远端（见 src/utils/asset.ts），这里就不拷 */
      ...(assetBase
        ? []
        : [{ from: 'src/static/img/', to: `${outputRoot}/static/img/` }]),
    ],
    options: {},
  },
  framework: 'react',
  compiler: 'webpack5',
  cache: {
    /* 持久化缓存能显著加快二次构建；Taro 每次启动也在提示开启 */
    enable: true,
  },
  /* monorepo 关键：Taro 的 babel-loader 默认只处理 sourceRoot(src) 下的文件，
     而 @photo-wall/core 的源码在 ../core/src，不显式包含会报
     "Module parse failed: Unexpected token"（TS 语法没人转译）。

     ⚠ 必须**分别**写在 mini / h5 段里。Taro 组装最终配置时只透传一个固定
     白名单（@tarojs/service Config.getConfigWithNamed），`compile` 不在其中，
     写在顶层会被直接丢掉；而 mini / h5 段的内容会被合并到 runner 读取的
     那个顶层对象上（Mini/H5WebpackModule.getScriptRule 取 config.compile.include）。 */
  mini: {
    compile: {
      include: [path.resolve(__dirname, '../../core/src')],
    },
    postcss: {
      pxtransform: {
        enable: true,
        config: {},
      },
      cssModules: {
        enable: false,
        config: {
          namingPattern: 'module',
          generateScopedName: '[name]__[local]___[hash:base64:5]',
        },
      },
    },
  },
  h5: {
    /* 和顶层 outputRoot 保持一致（顶层那份才是 Taro 清目录时读的值）。
       这里再写一次是为了让配置自解释：看到 h5 段就知道 h5 产物落在哪。 */
    outputRoot: 'dist-web',
    publicPath: '/',
    staticDirectory: 'static',
    /* 与 mini.compile 同理：h5 侧也必须显式包含 core 源码，否则 TS 语法没人转译 */
    compile: {
      include: [path.resolve(__dirname, '../../core/src')],
    },
    /* Taro 4 的 h5 构建需要显式指定 html 模板（src/index.html），否则不出 index.html */
    htmlPluginOption: {
      filename: 'index.html',
    },
    postcss: {
      autoprefixer: {
        enable: true,
        config: {},
      },
      cssModules: {
        enable: false,
        config: {
          namingPattern: 'module',
          generateScopedName: '[name]__[local]___[hash:base64:5]',
        },
      },
    },
  },
};

module.exports = function (merge) {
  if (process.env.NODE_ENV === 'development') {
    return merge({}, config, require('./dev'));
  }
  return merge({}, config, require('./prod'));
};
