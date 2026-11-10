/* ================================================================
   @photo-wall/core · demo 数据（示例记录 + 拟真生成）

   这一文件**只被演示 / 离线兜底用到**（ui-taro 的本地模式初屏）。
   它依赖同包的纯函数（records.ts 的 pad / rngOf / hashOf），但纯函数绝不反向
   依赖它 —— 这样 core 的「纯逻辑」主体（records / layout / geo / stats）不带任何
   真实业务数据，复用时不会被 12 条示例记录污染。

   生产接后端后，这层通常不参与（数据来自接口）；仅当 storage 无值或离线兜底
   时才回落到这里。把它从 records.ts 挪出来，是为了让「纯函数库」名副其实：
   records.ts 只做「数据 → 数据」的转换，不夹带示例数据。
   ================================================================ */
import type { FoodRecord } from './types/domain';
import { pad, rngOf, hashOf } from './records.ts';

/** 12 条真实记录（逐字保留；区县为真实存在的区/县，按城市补上） */
export const REAL_RECORDS: FoodRecord[] = [
  { id: 'r1',  eat: '甜水面',   shop: '马旺子川小馆',   city: '成都', district: '锦江区',   rating: 5, at: '2026-10-09T12:30', note: '面条筋道，甜辣刚好。辣子是现舂的，香得不像话。' },
  { id: 'r2',  eat: '冰粉',     shop: '马旺子川小馆',   city: '成都', district: '锦江区',   rating: 4, at: '2026-10-09T13:10', note: null },
  { id: 'r3',  eat: '跷脚牛肉', shop: '古市香跷脚牛肉', city: '乐山', district: '市中区',   rating: 5, at: '2026-10-08T18:40', note: '汤头清而厚，蘸水是灵魂。' },
  { id: 'r4',  eat: '钵钵鸡',   shop: '叶婆婆钵钵鸡',   city: '乐山', district: '市中区',   rating: 4, at: '2026-10-07T20:15', note: null },
  { id: 'r5',  eat: '北京烤鸭', shop: '四季民福',       city: '北京', district: '东城区',   rating: 5, at: '2026-09-30T18:00', note: '鸭子当桌现片，皮脆得掉渣。' },
  { id: 'r6',  eat: '番茄牛腩', shop: null,             city: null,  district: null,      rating: 4, at: '2026-09-27T19:00', note: '自己炖的，番茄放多了。没有店的一条也能存下来。' },
  { id: 'r7',  eat: '蛋烘糕',   shop: '贺记蛋烘糕',     city: '成都', district: '锦江区',   rating: 3, at: '2026-09-21T16:20', note: null },
  { id: 'r8',  eat: '生煎包',   shop: '大壶春',         city: '上海', district: '黄浦区',   rating: 5, at: '2026-09-14T08:40', note: '第二次来，还是脆底 —— 这家店算吃明白了。' },
  { id: 'r9',  eat: '豆汁儿',   shop: '尹三豆汁',       city: '北京', district: '东城区',   rating: 3, at: '2026-10-01T08:10', note: '酸香上头，喝不惯但总算试过了。' },
  { id: 'r10', eat: '热干面',   shop: '蔡林记',         city: '武汉', district: '江汉区',   rating: 5, at: '2026-08-20T07:50', note: '芝麻酱要趁热拌开，凉了就坨了。' },
  { id: 'r11', eat: '糖油粑粑', shop: '金记糖油粑粑',   city: '长沙', district: '天心区',   rating: 5, at: '2026-08-08T16:50', note: '刚出锅烫嘴，甜得理直气壮。' },
  { id: 'r12', eat: '沙茶面',   shop: '月华沙茶面',     city: '厦门', district: '思明区',   rating: 5, at: '2026-07-25T11:40', note: '加料要了大肠和豆腐，汤头是花生酱的底。' },
];

/** 城市池条目：给「更早的记录」生成拟真数据用 */
interface CityPoolEntry {
  city: string;
  dishes: string[];
  shops: string[];
}

/** 城市池：给「更早的记录」生成拟真数据用 */
const CITY_POOL: CityPoolEntry[] = [
  { city: '成都', dishes: ['龙抄手', '钟水饺', '担担面', '冒菜', '肥肠粉', '军屯锅盔'], shops: ['陈麻婆豆腐', '甘食记', '小谭豆花', '盘飧市'] },
  { city: '乐山', dishes: ['甜皮鸭', '豆腐脑', '串串香', '叶儿粑'], shops: ['赵记甜皮鸭', '九九豆腐脑', '杨记串串'] },
  { city: '北京', dishes: ['卤煮火烧', '炸酱面', '炒肝', '爆肚', '驴打滚'], shops: ['姚记炒肝', '门框胡同卤煮', '护国寺小吃'] },
  { city: '上海', dishes: ['小笼包', '葱油拌面', '排骨年糕', '油墩子'], shops: ['小杨生煎', '佳家汤包', '阿娘面馆'] },
  { city: '武汉', dishes: ['豆皮', '面窝', '糊汤粉', '糯米包油条'], shops: ['老通城', '户部巷豆皮', '三镇民生甜食馆'] },
  { city: '长沙', dishes: ['臭豆腐', '口味虾', '剁椒鱼头', '米粉'], shops: ['火宫殿', '黑色经典', '玉楼春'] },
  { city: '厦门', dishes: ['土笋冻', '海蛎煎', '花生汤', '烧肉粽'], shops: ['乌糖沙茶面', '局口拌面', '黄则和'] },
  { city: '西安', dishes: ['肉夹馍', '羊肉泡馍', '臊子面', '凉皮'], shops: ['老孙家泡馍', '魏家凉皮', '贾三灌汤包'] },
  { city: '广州', dishes: ['肠粉', '白切鸡', '云吞面', '双皮奶'], shops: ['银记肠粉', '宝华面店', '南陶居'] },
  { city: '重庆', dishes: ['小面', '酸辣粉', '毛血旺', '豆花饭'], shops: ['花市豌杂面', '秦云老太婆摊摊面', '谢家豆花'] },
  { city: '南京', dishes: ['鸭血粉丝汤', '盐水鸭', '汤包', '梅花糕'], shops: ['金陵鸭血粉丝', '韩复兴盐水鸭', '鸡鸣汤包'] },
  { city: '杭州', dishes: ['片儿川', '东坡肉', '葱包桧', '定胜糕'], shops: ['菊英面馆', '知味观', '方老大面'] },
];

const NOTES: string[] = [
  '汤头熬得够久，一进门就闻到了。', '排了四十分钟，值。', '份量比上次小了些。',
  '老板记得我，多给了一勺辣子。', '一个人吃完，撑到走不动。', '配的酸萝卜很解腻。',
  '皮薄，筷子一夹就破。', '从小吃到大，味道没变。', '天冷了，吃这个正好。',
];

/** 生成更早的拟真记录：让墙足够长，可以一直往下翻 */
export function makeOlder(count: number, fromDate: Date): FoodRecord[] {
  const out: FoodRecord[] = [];
  let d = new Date(fromDate.getTime());
  for (let i = 0; i < count; i++) {
    const back = 1 + Math.floor(Math.random() * 5);
    d = new Date(d.getTime() - back * 864e5 - Math.floor(Math.random() * 8) * 36e5);
    const c = CITY_POOL[Math.floor(Math.random() * CITY_POOL.length)];
    const rnd = rngOf(hashOf('g' + i + d.toISOString()));
    const eat = c.dishes[Math.floor(rnd() * c.dishes.length)];
    out.push({
      id: 'g' + Date.now() + '_' + i,
      eat,
      shop: c.shops[Math.floor(rnd() * c.shops.length)],
      city: c.city,
      district: null,
      rating: 3 + Math.floor(rnd() * 3),
      at: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`,
      note: rnd() < 0.5 ? NOTES[Math.floor(rnd() * NOTES.length)] : null,
    });
  }
  return out;
}
