/* 由 scripts/gen-data.mjs 从 packages/core/src/records.ts 生成，请勿手改。
   12 条预置记录：新用户示例数据（§11 待确认 2）。
   photo 故意为 null —— 前端 photoOf() 会回落到包内预置配图，无需真实 CDN 图。 */
export interface SeedRecord {
  id: string;
  eat: string;
  shop: string | null;
  city: string | null;
  district: string | null;
  rating: number;
  at: string;
  note: string | null;
}

export const SEED_RECORDS: readonly SeedRecord[] = [
  {
    "id": "r1",
    "eat": "甜水面",
    "shop": "马旺子川小馆",
    "city": "成都",
    "district": "锦江区",
    "rating": 5,
    "at": "2026-10-09T12:30",
    "note": "面条筋道，甜辣刚好。辣子是现舂的，香得不像话。"
  },
  {
    "id": "r2",
    "eat": "冰粉",
    "shop": "马旺子川小馆",
    "city": "成都",
    "district": "锦江区",
    "rating": 4,
    "at": "2026-10-09T13:10",
    "note": null
  },
  {
    "id": "r3",
    "eat": "跷脚牛肉",
    "shop": "古市香跷脚牛肉",
    "city": "乐山",
    "district": "市中区",
    "rating": 5,
    "at": "2026-10-08T18:40",
    "note": "汤头清而厚，蘸水是灵魂。"
  },
  {
    "id": "r4",
    "eat": "钵钵鸡",
    "shop": "叶婆婆钵钵鸡",
    "city": "乐山",
    "district": "市中区",
    "rating": 4,
    "at": "2026-10-07T20:15",
    "note": null
  },
  {
    "id": "r5",
    "eat": "北京烤鸭",
    "shop": "四季民福",
    "city": "北京",
    "district": "东城区",
    "rating": 5,
    "at": "2026-09-30T18:00",
    "note": "鸭子当桌现片，皮脆得掉渣。"
  },
  {
    "id": "r6",
    "eat": "番茄牛腩",
    "shop": null,
    "city": null,
    "district": null,
    "rating": 4,
    "at": "2026-09-27T19:00",
    "note": "自己炖的，番茄放多了。没有店的一条也能存下来。"
  },
  {
    "id": "r7",
    "eat": "蛋烘糕",
    "shop": "贺记蛋烘糕",
    "city": "成都",
    "district": "锦江区",
    "rating": 3,
    "at": "2026-09-21T16:20",
    "note": null
  },
  {
    "id": "r8",
    "eat": "生煎包",
    "shop": "大壶春",
    "city": "上海",
    "district": "黄浦区",
    "rating": 5,
    "at": "2026-09-14T08:40",
    "note": "第二次来，还是脆底 —— 这家店算吃明白了。"
  },
  {
    "id": "r9",
    "eat": "豆汁儿",
    "shop": "尹三豆汁",
    "city": "北京",
    "district": "东城区",
    "rating": 3,
    "at": "2026-10-01T08:10",
    "note": "酸香上头，喝不惯但总算试过了。"
  },
  {
    "id": "r10",
    "eat": "热干面",
    "shop": "蔡林记",
    "city": "武汉",
    "district": "江汉区",
    "rating": 5,
    "at": "2026-08-20T07:50",
    "note": "芝麻酱要趁热拌开，凉了就坨了。"
  },
  {
    "id": "r11",
    "eat": "糖油粑粑",
    "shop": "金记糖油粑粑",
    "city": "长沙",
    "district": "天心区",
    "rating": 5,
    "at": "2026-08-08T16:50",
    "note": "刚出锅烫嘴，甜得理直气壮。"
  },
  {
    "id": "r12",
    "eat": "沙茶面",
    "shop": "月华沙茶面",
    "city": "厦门",
    "district": "思明区",
    "rating": 5,
    "at": "2026-07-25T11:40",
    "note": "加料要了大肠和豆腐，汤头是花生酱的底。"
  }
] as const;
