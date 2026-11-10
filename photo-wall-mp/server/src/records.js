/* ================================================================
   记录序列化 + 游标分页（契约 §4.2 / §6.2.1 / §7.2）

   硬约束：
   - 排序 `eatenAtUtc DESC, id DESC`（同一分钟靠 id 兜底）。
   - 游标是 keyset（严格 `<`），不是 offset —— 翻页期间新增记录
     不会让已翻过的页重复（AC-08），也不会漏。
   - `total` = **当前筛选条件**下的总条数。
   - 空值一律 `null`，绝不返回 `""`。
   ================================================================ */
/* global Buffer */


/** 对外 Record 形状：字段顺序与文档 §4.2 一致，方便肉眼 diff */
export function serializeRecord(r) {
  return {
    id: r.id,
    eat: r.eat,
    shop: r.shop ?? null,
    shopId: r.shopId ?? null,
    city: r.city ?? null,
    district: r.district ?? null,
    rating: r.rating ?? 0,
    at: r.at,
    tzOffset: r.tzOffset ?? null,
    eatenAtUtc: r.eatenAtUtc,
    note: r.note ?? null,
    photo: r.photo ?? null,
    photoThumb: r.photoThumb ?? null,
    photoId: r.photoId ?? null,
    /* 多图字段：契约里 `photos` **恒存在**（0–5 张，`photos[0]` 即封面，
       见 photo-wall-api/docs/api/photo-wall-api.md §5「封面口径」）。
       本 mock 只落地了单张（`photoId`），所以要么 0 条要么 1 条 ——
       缺了它前端 `photos.map(...)` 拿到 undefined 直接崩，而这个字段
       以前是漏的（由 photo-wall-api/server/test/mock-parity.test.ts 抓到）。 */
    photos:
      r.photoId && r.photo
        ? [{ photoId: r.photoId, photo: r.photo, photoThumb: r.photoThumb ?? r.photo }]
        : [],
    version: r.version ?? 1,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

/** 列表排序：eatenAtUtc DESC, id DESC（纯比较，不改原数组） */
export function compareRecords(a, b) {
  if (a.eatenAtMs !== b.eatenAtMs) return b.eatenAtMs - a.eatenAtMs;
  if (a.id === b.id) return 0;
  return a.id < b.id ? 1 : -1;
}

export function sortRecords(list) {
  return [...list].sort(compareRecords);
}

/* ---------------- 游标 ---------------- */

/** cursor = base64url(JSON.stringify({ at: <eatenAtUtc>, id })) */
export function encodeCursor(record) {
  const payload = JSON.stringify({ at: record.eatenAtUtc, id: record.id });
  return Buffer.from(payload, 'utf8').toString('base64url');
}

/** 解码失败 → 返回 null（调用方转 400 BAD_REQUEST） */
export function decodeCursor(cursor) {
  if (typeof cursor !== 'string' || !cursor) return null;
  let json;
  try {
    json = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  let obj;
  try {
    obj = JSON.parse(json);
  } catch {
    return null;
  }
  if (!obj || typeof obj.at !== 'string' || typeof obj.id !== 'string') return null;
  const ms = Date.parse(obj.at);
  if (Number.isNaN(ms)) return null;
  return { eatenAtMs: ms, id: obj.id };
}

/* ---------------- 筛选 ---------------- */

/**
 * 筛选条件归一。`city` 与 `cityMissing` 互斥（同时传 → 400，AC-10）。
 * @returns {{city:string|null, cityMissing:boolean, province:string|null, shopId:string|null, q:string|null}}
 */
export function parseFilters(query) {
  const cityRaw = query.get('city');
  const cityMissingRaw = query.get('cityMissing');
  const cityMissing = cityMissingRaw === 'true' || cityMissingRaw === '1';
  const city = cityRaw === null || cityRaw === '' ? null : cityRaw;
  if (city !== null && cityMissing) {
    return { error: 'city 与 cityMissing 不能同时使用' };
  }
  return {
    city,
    cityMissing,
    province: query.get('province') || null,
    shopId: query.get('shopId') || null,
    q: query.get('q') || null,
  };
}

/**
 * 应用筛选。`province` 由调用方先用字典展开成城市集合传进来
 * （表外城市归「其他」）。
 */
export function applyFilters(list, filters, { provinceCities = null } = {}) {
  let out = list;
  if (filters.city !== null) out = out.filter((r) => r.city === filters.city);
  if (filters.cityMissing) out = out.filter((r) => r.city === null);
  if (provinceCities) out = out.filter((r) => r.city !== null && provinceCities.has(r.city));
  if (filters.shopId) out = out.filter((r) => r.shopId === filters.shopId);
  if (filters.q) {
    const q = filters.q.toLowerCase();
    out = out.filter((r) => r.eat.toLowerCase().includes(q));
  }
  return out;
}

/**
 * 一页数据。
 * @param {object[]} filtered 已筛选（未排序）的记录
 * @param {{limit:number, cursor?:string}} opts
 * @returns {{items:object[], nextCursor:string|null, hasMore:boolean, total:number}}
 */
export function paginate(filtered, { limit, cursor }) {
  const sorted = sortRecords(filtered);
  const total = sorted.length;

  let start = 0;
  if (cursor) {
    const c = decodeCursor(cursor);
    if (!c) return { error: 'cursor 非法' };
    // keyset：严格小于游标位置
    start = sorted.findIndex(
      (r) => r.eatenAtMs < c.eatenAtMs || (r.eatenAtMs === c.eatenAtMs && r.id < c.id),
    );
    if (start < 0) start = sorted.length;
  }

  const slice = sorted.slice(start, start + limit);
  const hasMore = start + limit < sorted.length;
  const last = slice[slice.length - 1];
  return {
    items: slice.map(serializeRecord),
    nextCursor: hasMore && last ? encodeCursor(last) : null,
    hasMore,
    total,
  };
}
