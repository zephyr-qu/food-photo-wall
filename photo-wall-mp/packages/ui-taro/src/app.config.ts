export default defineAppConfig({
  pages: [
    'pages/wall/index',
    'pages/detail/index',
    'pages/compose/index',
    'pages/shop/index',
  ],
  window: {
    backgroundTextStyle: 'light',
    /* Radix sand-1：和白底页面同一档，导航栏不额外造一条色带 */
    navigationBarBackgroundColor: '#fdfdfc',
    navigationBarTitleText: 'X师傅美食记',
    navigationBarTextStyle: 'black',
  },
  /* 用了 chooseMedia（相册/相机），必须开启隐私协议检查：
     基础库 2.32.3 上不写这个，真机会直接拒绝授权，而模拟器不一定报错。
     正式发布还需要在小程序后台「用户隐私保护指引」里声明相册和摄像头用途。 */
  __usePrivacyCheck__: true,
  lazyCodeLoading: 'requiredComponents',
});
