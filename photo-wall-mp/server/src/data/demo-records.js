/* ================================================================
   演示数据（demo seeds）

   为什么单独一份、不并进 REAL_RECORDS：
   `REAL_RECORDS` 那 12 条是**契约数据**（docs/api §2.4、core 单测、
   验收用例都逐字断言它们），不能动。而 12 条撑不起真实场景：
   翻页只有一页、月份分组只有 3 个月、城市只有 7 个、统计的
   「反复吃」永远为空、随机一道没什么可抽的。

   所以这里额外造一批**演示用**记录，只由 mock 后端灌入，
   不影响 core 与前端预置数据。目标是让联调/演示能覆盖：
   · 分页：> 60 条（至少 4 页），跨 12 个月
   · 城市：覆盖 12 城 / 8 省，含 2 条「未记城市」、1 条表外城市
   · 评分：0 分（未评）、3/4/5 分都有，五分占比不极端
   · 重复：同名菜 3 次（触发统计「反复吃」）
   · 店铺：同一家店多次、跨城同名店各 1 家
   · 备注：长备注（接近 200 字）、null、带换行
   ================================================================ */

/** 演示数据条数上限提示：够翻 5 页（limit=10） */
export const DEMO_RECORDS = [
  /* ---------- 2026-10：当月密集，测首屏与分组头 ---------- */
  { eat: '红油抄手', shop: '龙抄手', city: '成都', district: null, rating: 5, at: '2026-10-26T19:20', note: '红油厚，抄手皮薄，一口一个。' },
  { eat: '钟水饺', shop: '钟水饺', city: '成都', district: null, rating: 4, at: '2026-10-25T12:05', note: null },
  { eat: '甜水面', shop: '马旺子川小馆', city: '成都', district: null, rating: 5, at: '2026-10-24T18:40', note: '第二次吃，还是那口甜辣。' },
  { eat: '夫妻肺片', shop: '夫妻肺片总店', city: '成都', district: null, rating: 5, at: '2026-10-22T19:10', note: '红油香得很正，牛肉切得薄。' },
  { eat: '烤冷面', shop: '楼下小推车', city: '哈尔滨', district: null, rating: 3, at: '2026-10-20T21:30', note: '加蛋加肠，深夜快乐。' },
  { eat: '锅包肉', shop: '老厨家', city: '哈尔滨', district: null, rating: 5, at: '2026-10-19T18:00', note: '酸甜口，外脆里嫩，比想象中好吃。' },
  { eat: '小笼包', shop: '南翔馒头店', city: '上海', district: null, rating: 5, at: '2026-10-18T08:30', note: '皮薄汁多，先咬一小口。' },
  { eat: '生煎包', shop: '大壶春', city: '上海', district: null, rating: 4, at: '2026-10-17T09:10', note: null },
  { eat: '片儿川', shop: '奎元馆', city: '杭州', district: null, rating: 4, at: '2026-10-15T12:20', note: '雪菜笋片肉丝，汤头清爽。' },
  { eat: '东坡肉', shop: '楼外楼', city: '杭州', district: null, rating: 5, at: '2026-10-14T18:30', note: '肥而不腻，配米饭刚好。' },

  /* ---------- 2026-09：跨月 ---------- */
  { eat: '鸭血粉丝汤', shop: '回味', city: '南京', district: null, rating: 4, at: '2026-09-28T11:40', note: null },
  { eat: '盐水鸭', shop: '桂花鸭', city: '南京', district: null, rating: 4, at: '2026-09-27T17:50', note: '咸鲜，冷着吃更香。' },
  { eat: '热干面', shop: '蔡林记', city: '武汉', district: null, rating: 5, at: '2026-09-25T07:30', note: '第二次来，还是这家最对。' },
  { eat: '三鲜豆皮', shop: '老通城', city: '武汉', district: null, rating: 4, at: '2026-09-24T08:20', note: null },
  { eat: '臭豆腐', shop: '火宫殿', city: '长沙', district: null, rating: 3, at: '2026-09-22T20:40', note: '闻着冲，吃着香，辣椒够劲。' },
  { eat: '糖油粑粑', shop: '金记糖油粑粑', city: '长沙', district: null, rating: 5, at: '2026-09-21T16:10', note: '第二次，刚出锅的最好吃。' },
  { eat: '肉夹馍', shop: '老孙家', city: '西安', district: null, rating: 5, at: '2026-09-18T12:00', note: '腊汁肉肥瘦相间，馍烤得脆。' },
  { eat: 'biangbiang面', shop: 'biangbiang面馆', city: '西安', district: null, rating: 4, at: '2026-09-17T19:30', note: '宽面很劲道，油泼辣子香。' },
  { eat: '羊肉泡馍', shop: '老米家', city: '西安', district: null, rating: 4, at: '2026-09-16T13:20', note: '自己掰馍掰了十分钟，值。' },
  { eat: '牛肉拉面', shop: '马子禄', city: '兰州', district: null, rating: 5, at: '2026-09-12T08:00', note: '一清二白三红四绿，汤很正。' },

  /* ---------- 2026-08 ---------- */
  { eat: '沙茶面', shop: '月华沙茶面', city: '厦门', district: null, rating: 5, at: '2026-08-28T11:30', note: '加了大肠和豆腐，汤头是花生酱底。' },
  { eat: '海蛎煎', shop: '阿杰海蛎煎', city: '厦门', district: null, rating: 4, at: '2026-08-27T18:20', note: null },
  { eat: '土笋冻', shop: '黄则和', city: '厦门', district: null, rating: 2, at: '2026-08-26T16:40', note: '口感有点怪，尝个新鲜。' },
  { eat: '肠粉', shop: '银记肠粉', city: '广州', district: null, rating: 4, at: '2026-08-22T08:40', note: '米浆滑，酱油甜咸刚好。' },
  { eat: '烧鹅', shop: '裕记烧鹅', city: '广州', district: null, rating: 5, at: '2026-08-21T18:50', note: '皮脆肉嫩，蘸酸梅酱。' },
  { eat: '云吞面', shop: '麦奀云吞面', city: '广州', district: null, rating: 4, at: '2026-08-20T12:10', note: null },
  { eat: '螺蛳粉', shop: '好欢螺', city: '柳州', district: null, rating: 4, at: '2026-08-16T20:00', note: '酸笋的味道很有存在感。' },
  { eat: '老友粉', shop: '复记老友粉', city: '南宁', district: null, rating: 3, at: '2026-08-14T09:30', note: '酸辣开胃，早上吃很舒服。' },
  { eat: '过桥米线', shop: '建新园', city: '昆明', district: null, rating: 5, at: '2026-08-10T12:30', note: '汤很烫，料下进去一下就熟。' },
  { eat: '汽锅鸡', shop: '福照楼', city: '昆明', district: null, rating: 4, at: '2026-08-09T18:10', note: null },

  /* ---------- 2026-07 ---------- */
  { eat: '重庆小面', shop: '花市豌杂面', city: '重庆', district: null, rating: 5, at: '2026-07-30T08:10', note: '豌杂给得足，麻辣刚好。' },
  { eat: '毛血旺', shop: '陶然居', city: '重庆', district: null, rating: 4, at: '2026-07-29T19:20', note: '料很足，鸭血嫩。' },
  { eat: '酸辣粉', shop: '好又来', city: '重庆', district: null, rating: 4, at: '2026-07-28T15:40', note: null },
  { eat: '跷脚牛肉', shop: '古市香跷脚牛肉', city: '乐山', district: null, rating: 5, at: '2026-07-25T18:30', note: '汤头清而厚，蘸水是灵魂。' },
  { eat: '甜皮鸭', shop: '赵鸭子', city: '乐山', district: null, rating: 5, at: '2026-07-24T17:00', note: '皮是甜的，肉是咸香的，很妙。' },
  { eat: '钵钵鸡', shop: '叶婆婆钵钵鸡', city: '乐山', district: null, rating: 4, at: '2026-07-23T20:20', note: null },
  { eat: '豆腐脑', shop: '九九豆腐脑', city: '乐山', district: null, rating: 4, at: '2026-07-22T07:50', note: '咸口的，加酥肉和粉条。' },
  { eat: '叶儿粑', shop: '九九豆腐脑', city: '乐山', district: null, rating: 5, at: '2026-07-22T08:20', note: '糯米皮包肉馅，叶子的清香。' },
  { eat: '冷吃兔', shop: '自贡人家', city: '自贡', district: null, rating: 5, at: '2026-07-18T19:40', note: '麻辣干香，越嚼越上瘾。' },
  { eat: '燃面', shop: '宜宾燃面', city: '宜宾', district: null, rating: 4, at: '2026-07-15T11:20', note: null },

  /* ---------- 2026-06 ---------- */
  { eat: '兰州牛肉面', shop: '马子禄', city: '兰州', district: null, rating: 5, at: '2026-06-28T07:40', note: '第二碗，还是清汤最舒服。' },
  { eat: '手抓羊肉', shop: '马忠食府', city: '西宁', district: null, rating: 5, at: '2026-06-25T18:30', note: '一点不膻，蘸椒盐。' },
  { eat: '酿皮', shop: '莫家街小吃', city: '西宁', district: null, rating: 3, at: '2026-06-24T13:00', note: null },
  { eat: '大盘鸡', shop: '血站大盘鸡', city: '乌鲁木齐', district: null, rating: 5, at: '2026-06-20T19:50', note: '皮带面拌汤汁，绝了。' },
  { eat: '烤包子', shop: '二道桥', city: '乌鲁木齐', district: null, rating: 4, at: '2026-06-19T12:30', note: null },
  { eat: '酥油茶', shop: '八廓街茶馆', city: '拉萨', district: null, rating: 2, at: '2026-06-15T09:20', note: '咸的，第一口不太习惯。' },
  { eat: '藏面', shop: '光明港琼甜茶馆', city: '拉萨', district: null, rating: 4, at: '2026-06-14T08:40', note: '面偏硬，汤是牦牛的。' },
  { eat: '过桥米线', shop: '建新园', city: '昆明', district: null, rating: 5, at: '2026-06-10T12:10', note: '第二次，还是这家稳。' },
  { eat: '鲜花饼', shop: '嘉华饼屋', city: '昆明', district: null, rating: 3, at: '2026-06-09T16:20', note: null },
  { eat: '豆花米线', shop: '老街小吃', city: '大理', district: null, rating: 4, at: '2026-06-06T10:30', note: '豆花配米线，酸辣口。' },

  /* ---------- 2026-05 及更早：测「翻到底」 ---------- */
  { eat: '菠萝油', shop: '翠华餐厅', city: '香港', district: null, rating: 4, at: '2026-05-28T15:30', note: '冰火菠萝油，趁热夹黄油。' },
  { eat: '云吞面', shop: '麦奀云吞面', city: '香港', district: null, rating: 4, at: '2026-05-27T12:40', note: null },
  { eat: '猪扒包', shop: '大利来记', city: '澳门', district: null, rating: 4, at: '2026-05-25T14:20', note: '猪扒带骨，面包烤得脆。' },
  { eat: '葡式蛋挞', shop: '安德鲁饼店', city: '澳门', district: null, rating: 5, at: '2026-05-24T10:10', note: '酥皮层次很多，蛋液嫩。' },
  { eat: '卤肉饭', shop: '胡须张', city: '台北', district: null, rating: 4, at: '2026-05-18T12:00', note: null },
  { eat: '牛肉面', shop: '林东芳', city: '台北', district: null, rating: 5, at: '2026-05-17T13:30', note: '汤头浓，牛肉大块软烂。' },
  { eat: '蚵仔煎', shop: '宁夏夜市', city: '台北', district: null, rating: 3, at: '2026-05-16T20:40', note: '夜市随便找的一家。' },
  { eat: '海鲜粥', shop: '六合夜市', city: '高雄', district: null, rating: 4, at: '2026-05-12T21:00', note: null },
  { eat: '烧肉粽', shop: '郭家肉粽', city: '高雄', district: null, rating: 4, at: '2026-05-11T11:20', note: '南部粽，糯米软糯。' },
  { eat: '打抛猪', shop: '建兴酒家', city: '曼谷', district: null, rating: 5, at: '2026-05-05T19:30', note: '香茅味重，配白饭能吃两碗。' },
  { eat: '冬阴功汤', shop: '建兴酒家', city: '曼谷', district: null, rating: 4, at: '2026-05-04T18:40', note: null },

  /* ---------- 2026-03 ~ 2025-11：把月份铺满一年（测分组与「翻到底」） ---------- */
  { eat: '云吞面', shop: '麦奀云吞面', city: '香港', district: null, rating: 5, at: '2026-03-26T12:30', note: '第三次了，这家是我心里的云吞面基准。' },
  { eat: '干炒牛河', shop: '翠华餐厅', city: '香港', district: null, rating: 4, at: '2026-03-25T19:10', note: '镬气够，河粉没断。' },
  { eat: '菠萝包', shop: '金凤茶餐厅', city: '香港', district: null, rating: 3, at: '2026-03-24T15:40', note: null },
  { eat: '潮汕牛肉火锅', shop: '八合里', city: '汕头', district: null, rating: 5, at: '2026-03-18T19:30', note: '吊龙、匙柄、胸口油，部位点全了。' },
  { eat: '牛肉丸', shop: '八合里', city: '汕头', district: null, rating: 5, at: '2026-03-18T20:10', note: '手打的就是弹。' },
  { eat: '粿条汤', shop: '老姿娘', city: '汕头', district: null, rating: 4, at: '2026-03-17T08:20', note: null },
  { eat: '佛跳墙', shop: '聚春园', city: '福州', district: null, rating: 5, at: '2026-02-20T18:40', note: '料很足，汤浓得挂勺。' },
  { eat: '鱼丸', shop: '永和鱼丸', city: '福州', district: null, rating: 4, at: '2026-02-19T11:00', note: null },
  { eat: '锅边糊', shop: '安泰楼', city: '福州', district: null, rating: 3, at: '2026-02-18T07:30', note: '早餐，配油条。' },
  { eat: '瓦罐汤', shop: '民间饭庄', city: '南昌', district: null, rating: 4, at: '2026-02-10T12:20', note: '肉饼汤很鲜。' },
  { eat: '拌粉', shop: '周真真', city: '南昌', district: null, rating: 4, at: '2026-02-10T08:10', note: null },
  { eat: '臭鳜鱼', shop: '徽州人家', city: '黄山', district: null, rating: 3, at: '2026-01-22T18:30', note: '闻着臭吃着香，但确实需要适应。' },
  { eat: '毛豆腐', shop: '徽州人家', city: '黄山', district: null, rating: 2, at: '2026-01-21T19:00', note: '长了白毛的豆腐，煎过之后还行。' },
  { eat: '火锅', shop: '蜀大侠', city: '成都', district: null, rating: 5, at: '2026-01-12T19:50', note: '牛油锅底，配冰粉解辣。' },
  { eat: '冒菜', shop: '冒椒火辣', city: '成都', district: null, rating: 4, at: '2026-01-10T12:40', note: null },
  { eat: '羊肉泡馍', shop: '同盛祥', city: '西安', district: null, rating: 4, at: '2025-12-28T13:10', note: '第二次，这次机器切的馍，不如手掰。' },
  { eat: '甑糕', shop: '回民街', city: '西安', district: null, rating: 4, at: '2025-12-27T09:20', note: '糯米加红枣，很甜。' },
  { eat: '腊汁肉夹馍', shop: '秦豫肉夹馍', city: '西安', district: null, rating: 5, at: '2025-12-26T12:00', note: '这家比老孙家更香。' },
  { eat: '涮羊肉', shop: '东来顺', city: '北京', district: null, rating: 5, at: '2025-12-12T19:20', note: '铜锅清汤，蘸麻酱，冬天就该吃这个。' },
  { eat: '卤煮', shop: '小肠陈', city: '北京', district: null, rating: 3, at: '2025-12-11T21:00', note: '味重，配二锅头。' },
  { eat: '炸酱面', shop: '海碗居', city: '北京', district: null, rating: 4, at: '2025-12-10T12:30', note: null },
  { eat: '锅贴', shop: '蒋有记', city: '南京', district: null, rating: 4, at: '2025-11-28T18:10', note: '牛肉锅贴，底很脆。' },
  { eat: '糖芋苗', shop: '芳婆糕团店', city: '南京', district: null, rating: 3, at: '2025-11-27T15:30', note: null },
  { eat: '生煎', shop: '小杨生煎', city: '上海', district: null, rating: 4, at: '2025-11-15T08:50', note: '比大壶春的汁更多，但底没那么脆。' },

  /* ---------- 边界数据：未评 / 未记城市 / 表外城市 / 超长备注 ---------- */
  {
    eat: '番茄牛腩',
    shop: null,
    city: null,
    district: null,
    rating: 0,
    at: '2026-04-28T19:00',
    note: '自己炖的，番茄放多了。没有店的一条也能存下来 —— 这条故意不打分，用来验证「未评」与统计分母含 0 分的口径。',
  },
  {
    eat: '泡面',
    shop: null,
    city: null,
    district: null,
    rating: 0,
    at: '2026-04-20T23:50',
    note: null,
  },
  {
    eat: '隆昌羊肉汤',
    shop: '隆昌羊肉汤',
    city: '隆昌',
    district: null,
    rating: 4,
    at: '2026-04-15T12:30',
    note: '表外城市（不在 208 城字典里），验证省分组归「其他」。',
  },
  {
    eat: '家宴',
    shop: null,
    city: '北京',
    district: null,
    rating: 5,
    at: '2026-04-02T18:00',
    note: '这条备注很长，用来验证长文本在详情页与卡片里的折行：'
      + '从买菜到收桌一共四个小时，六菜一汤，最费时间的是红烧肉，'
      + '要炒糖色、要小火慢炖，中间还得翻两次面；凉菜的黄瓜是现拍的，'
      + '蒜要现捣才香，麻酱得用温水一点点澥开，不能一次倒进去。'
      + '吃到最后其实已经吃不下了，但看到空盘还是很有成就感。',
  },
];
