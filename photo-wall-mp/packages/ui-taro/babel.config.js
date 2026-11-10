// babel-preset-taro 更多选项和默认值：
// https://github.com/NervJS/taro/blob/next/packages/babel-preset-taro/README.md
//
// ts: true —— 项目已迁移到 TypeScript（TS 5.6 + @types/react 18，匹配 react 18.3）。
// 开启后 babel-preset-taro 会用 @babel/preset-typescript 处理 .ts/.tsx。
module.exports = {
  presets: [
    ['taro', {
      framework: 'react',
      ts: true,
      compiler: 'webpack5',
    }],
  ],
};
