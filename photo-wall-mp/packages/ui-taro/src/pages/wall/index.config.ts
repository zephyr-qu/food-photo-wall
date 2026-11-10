export default definePageConfig({
  /* 自绘导航（用户反馈：原生空标题栏 + 自绘顶栏叠了两层，太占地方）——
     去掉原生栏，状态栏高度加进自绘顶栏（index.tsx 按 statusBarHeight
     内联 height/paddingTop），右上角胶囊由 .topbar--wx 让出 160rpx。
     这页是首页、没有上一页，去掉原生栏不损失返回能力；
     h5 本来就没有原生栏，行为不变。
     ⚠ 改页面 json 后模拟器不会立刻生效，要先 cleanCompileCache，
     否则看到的还是旧配置（本次调试实测）。 */
  navigationStyle: 'custom',
  /* 自绘导航下这两个字段对 weapp 无效，但 h5 路由会把 title 写进
     document.title —— 保持留空，别把品牌名写两遍 */
  navigationBarTitleText: '',
  navigationBarBackgroundColor: '#fdfdfc',
  // 状态栏图标颜色：白纸底上要深色字
  navigationBarTextStyle: 'black',
  // 下拉刷新关掉：这面墙是"贴照片"，下拉容易误触
  enablePullDownRefresh: false,
  // 允许页面上滚（照片很多）
  disableScroll: false,
});
