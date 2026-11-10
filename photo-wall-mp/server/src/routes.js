/* ================================================================
   路由与处理函数（契约 §6 逐条落地）

   注册顺序即匹配顺序（§5 警示）：
     /records/random → /records/cities → /records/months → /records/{id}
   把静态段放在参数段前面，否则 "random" 会被当成记录 id。
   ================================================================ */
import {
  citiesOfProvince,
  cityAggregate,
  monthsAggregate,
  pickRandom,
  shopAggregate,
  statsAggregate,
} from './aggregate.js';
import { provinceCatalogue } from './data/geo.js';
import { ApiError, badRequest, notFound } from './errors.js';
import { ulid } from './ids.js';
import { boundaryOf, imageSize, parseMultipart, sniffImageMime } from './multipart.js';
import {
  applyFilters,
  paginate,
  parseFilters,
  serializeRecord,
  sortRecords,
} from './records.js';
import {
  allOf,
  consumeWechatCode,
  ensureShop,
  findPhoto,
  findRecord,
  findRefreshToken,
  findShop,
  findUser,
  getIdempotent,
  insertPhoto,
  insertRecord,
  issueTokens,
  nextSeq,
  photoBytes,
  photoInUse,
  rawOf,
  revokeRefreshToken,
  setIdempotent,
  upsertDeviceUser,
  upsertWechatUser,
} from './store.js';
import {
  DEFAULT_TZ,
  toUtcIso,
  toUtcIsoAfter,
  utcMsToAt,
} from './time.js';
import {
  assertValid,
  emptyToNull,
  optionalText,
  parseRating,
  parseWhen,
  requiredEat,
} from './validate.js';

const VERSION = '1.0.0';
const NO_STORE = { 'Cache-Control': 'no-store' };
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const ALLOWED_IMAGE_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);

/** 公共 base url：本地 mock 用请求自己的 host，前端拿到就能直接 <Image src> */
function baseUrl(ctx) {
  /* 兜底 8788：本 mock 的默认端口（8787 是真后端的契约端口，见 src/index.js） */
  const host = ctx.req.headers.host || 'localhost:8788';
  const proto = ctx.req.headers['x-forwarded-proto'] || 'http';
  return `${proto}://${host}/v1`;
}

/** 照片 URL：三个都指向本服务（可匿名 GET，AC-28 要求 200） */
/** 照片 URL：三个都指向本服务（可匿名 GET，AC-28 要求 200）。
 *  扩展名跟随真实 mime —— 回读时 Content-Type 才对得上。 */
const EXT_OF_MIME = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

function photoUrls(ctx, photoId, mime) {
  const base = baseUrl(ctx);
  const ext = EXT_OF_MIME[mime] || 'jpg';
  return {
    url: `${base}/files/${photoId}.orig`,
    photo: `${base}/files/${photoId}.${ext}`,
    photoThumb: `${base}/files/${photoId}-400.${ext}`,
  };
}

export function defineRoutes(router) {
  /* ================= 运维 ================= */

  router.get('/healthz', (ctx) =>
    ctx.json(200, { status: 'ok', version: VERSION, time: toUtcIso(Date.now()) }),
  );

  /* ================= 认证 ================= */

  router.post('/auth/wechat/login', async (ctx) => {
    const body = await ctx.body();
    const code = typeof body.code === 'string' ? body.code.trim() : '';
    if (!code) {
      throw new ApiError('WECHAT_CODE_INVALID', 'code 无效');
    }
    // AC-02：微信 code 一次性，重复消费 → 401
    if (!consumeWechatCode(code)) {
      throw new ApiError('WECHAT_CODE_INVALID', 'code 已被使用或已过期');
    }
    const { user, isNew } = upsertWechatUser(code);
    const tokens = issueTokens(user.id);
    ctx.json(200, {
      ...tokens,
      tokenType: 'Bearer',
      userId: user.id,
      isNewUser: isNew,
      user: userPayload(user),
    });
  });

  router.post('/auth/anonymous', async (ctx) => {
    const body = await ctx.body();
    const deviceId = typeof body.deviceId === 'string' ? body.deviceId.trim() : '';
    if (!deviceId) throw badRequest('deviceId 必填');
    const { user, isNew } = upsertDeviceUser(deviceId);
    const tokens = issueTokens(user.id);
    ctx.json(200, {
      ...tokens,
      tokenType: 'Bearer',
      userId: user.id,
      isNewUser: isNew,
      user: userPayload(user),
    });
  });

  router.post('/auth/refresh', async (ctx) => {
    const body = await ctx.body();
    const token = typeof body.refreshToken === 'string' ? body.refreshToken : '';
    const rec = findRefreshToken(token);
    if (!rec || rec.expiresAt <= Date.now()) {
      throw new ApiError('TOKEN_INVALID', 'refreshToken 无效');
    }
    // refreshToken 轮换：旧的立即失效（§6.1.3）
    revokeRefreshToken(token);
    ctx.json(200, issueTokens(rec.userId));
  });

  router.get('/me', (ctx) => {
    const user = findUser(ctx.userId);
    if (!user) throw notFound('用户不存在');
    const records = allOf(ctx.userId);
    const sorted = sortRecords(records);
    const photoCount = records.filter((r) => r.photoId).length;
    ctx.json(200, {
      id: user.id,
      createdAt: user.createdAt,
      recordCount: records.length,
      photoCount,
      lastRecordAt: sorted.length ? sorted[0].at : null,
    }, NO_STORE);
  }, { auth: true });

  /* ================= 记录：静态段必须先注册 ================= */

  router.get('/records/random', (ctx) => {
    const filters = parseFilters(ctx.query);
    if (filters.error) throw badRequest(filters.error);
    const candidates = filterFor(ctx, filters);
    const record = pickRandom(candidates, ctx.query.get('excludeId') || null);
    if (!record) throw new ApiError('NO_RECORD', '这个范围里还没有照片');
    ctx.json(200, { record: serializeRecord(record) }, NO_STORE);
  }, { auth: true });

  router.get('/records/cities', (ctx) => {
    // 全量口径：**不吃** city 筛选（§6.3.1 硬要求）
    ctx.json(200, cityAggregate(allOf(ctx.userId)), NO_STORE);
  }, { auth: true });

  router.get('/records/months', (ctx) => {
    const filters = parseFilters(ctx.query);
    if (filters.error) throw badRequest(filters.error);
    ctx.json(200, monthsAggregate(filterFor(ctx, filters)), NO_STORE);
  }, { auth: true });

  router.get('/records', (ctx) => {
    const limit = parseLimit(ctx.query.get('limit'), 10, 50);
    const filters = parseFilters(ctx.query);
    if (filters.error) throw badRequest(filters.error);
    const page = paginate(filterFor(ctx, filters), { limit, cursor: ctx.query.get('cursor') });
    if (page.error) throw badRequest(page.error);
    ctx.json(200, page, NO_STORE);
  }, { auth: true });

  router.get('/records/:id', (ctx) => {
    const record = findRecord(ctx.userId, ctx.params.id);
    if (!record) throw notFound();
    ctx.json(200, serializeRecord(record), NO_STORE);
  }, { auth: true });

  router.post('/records', async (ctx) => {
    const body = await ctx.body();
    const idempotencyKey =
      ctx.req.headers['idempotency-key'] || body.clientRequestId || null;

    // 幂等：同 key 24h 内重放首次结果（AC-16 / D-06）
    if (idempotencyKey) {
      const hit = getIdempotent(ctx.userId, String(idempotencyKey));
      if (hit) {
        const record = findRecord(ctx.userId, hit.recordId);
        if (record) {
          return ctx.json(201, serializeRecord(record), {
            'Idempotent-Replayed': 'true',
            ...NO_STORE,
          });
        }
      }
    }

    const fields = {};
    const eat = requiredEat(body.eat, fields);
    const rating = parseRating(body.rating, fields);
    const when = parseWhen(body, fields);
    const shopName = optionalText(body.shop, 'shop', 80, fields);
    const city = optionalText(body.city, 'city', 40, fields);
    const district = optionalText(body.district, 'district', 40, fields);
    const note = optionalText(body.note, 'note', 200, fields, { preserveWhitespace: true });

    // shopId 优先于 shop（§3.7）
    let shopId = null;
    let shop = shopName;
    const shopIdInput = emptyToNull(body.shopId);
    if (shopIdInput !== null) {
      const shopEntity = findShop(ctx.userId, shopIdInput);
      if (!shopEntity) {
        fields.shopId = '店铺不存在';
      } else {
        shopId = shopEntity.id;
        shop = shopEntity.name;
      }
    }

    // photoId 必须存在、属于本人、状态 approved（AC-31）
    const photoId = emptyToNull(body.photoId);
    let photo = null;
    let photoThumb = null;
    if (photoId !== null) {
      const p = findPhoto(ctx.userId, photoId);
      if (!p) fields.photoId = '照片不存在';
      else if (p.status !== 'approved') fields.photoId = '照片未通过审核';
      else {
        photo = p.photoUrl;
        photoThumb = p.thumbUrl;
      }
    }

    assertValid(fields);

    const nowMs = Date.now();
    const eatenAtMs = when.useNow ? nowMs : when.eatenAtMs;
    const tzOffset = when.tzOffset || DEFAULT_TZ;
    const at = when.at || utcMsToAt(eatenAtMs, tzOffset);

    if (shop && !shopId) shopId = ensureShop(ctx.userId, shop, city);

    const record = {
      id: `rec_${ulid()}`,
      userId: ctx.userId,
      eat,
      shop,
      shopId,
      city,
      district,
      rating,
      at,
      tzOffset,
      eatenAtUtc: toUtcIso(eatenAtMs),
      eatenAtMs,
      note,
      photoId,
      photo,
      photoThumb,
      version: 1,
      createdAt: toUtcIso(nowMs),
      updatedAt: toUtcIso(nowMs),
      deletedAt: null,
      isSample: false,
      seq: nextSeq(),
    };
    insertRecord(record);
    if (idempotencyKey) setIdempotent(ctx.userId, String(idempotencyKey), record.id);

    ctx.json(201, serializeRecord(record), NO_STORE);
  }, { auth: true });

  router.patch('/records/:id', async (ctx) => {
    const record = findRecord(ctx.userId, ctx.params.id);
    if (!record) throw notFound();

    // If-Match: <version> → 版本不符 409 CONFLICT（§3.5）
    const ifMatch = ctx.req.headers['if-match'];
    const body = await ctx.body();
    const expected = ifMatch ?? body.expectedVersion;
    if (expected !== undefined && expected !== null && String(expected) !== '') {
      const v = Number(String(expected).replace(/^W\//, '').replace(/"/g, ''));
      if (!Number.isInteger(v) || v !== record.version) {
        throw new ApiError('CONFLICT', '记录已被修改，请刷新后重试');
      }
    }

    const fields = {};
    const patch = {};

    if ('eat' in body) {
      const eat = requiredEat(body.eat, fields);
      if (eat !== null) patch.eat = eat;
    }
    if ('rating' in body) {
      const rating = parseRating(body.rating, fields, { optional: true });
      if (rating !== undefined) patch.rating = rating;
    }
    if ('shop' in body) {
      const shop = optionalText(body.shop, 'shop', 80, fields);
      if (!fields.shop) patch.shop = shop;
    }
    if ('city' in body) {
      const city = optionalText(body.city, 'city', 40, fields);
      if (!fields.city) patch.city = city;
    }
    if ('district' in body) {
      const district = optionalText(body.district, 'district', 40, fields);
      if (!fields.district) patch.district = district;
    }
    if ('note' in body) {
      const note = optionalText(body.note, 'note', 200, fields, { preserveWhitespace: true });
      if (!fields.note) patch.note = note;
    }
    if ('shopId' in body) {
      const shopIdInput = emptyToNull(body.shopId);
      if (shopIdInput === null) {
        patch.shopId = null;
      } else {
        const shopEntity = findShop(ctx.userId, shopIdInput);
        if (!shopEntity) fields.shopId = '店铺不存在';
        else {
          patch.shopId = shopEntity.id;
          patch.shop = shopEntity.name;
        }
      }
    }
    // photoId: null = 清除自定义照片，回到预置配图（AC-18）
    if ('photoId' in body) {
      const photoIdInput = emptyToNull(body.photoId);
      if (photoIdInput === null) {
        patch.photoId = null;
        patch.photo = null;
        patch.photoThumb = null;
      } else {
        const p = findPhoto(ctx.userId, photoIdInput);
        if (!p) fields.photoId = '照片不存在';
        else if (p.status !== 'approved') fields.photoId = '照片未通过审核';
        else {
          patch.photoId = p.id;
          patch.photo = p.photoUrl;
          patch.photoThumb = p.thumbUrl;
        }
      }
    }
    // at 可改（§6.2.4）
    if ('at' in body || 'eatenAt' in body) {
      const when = parseWhen(body, fields, { optional: true });
      if (when) {
        const tzOffset = when.tzOffset || record.tzOffset || DEFAULT_TZ;
        const eatenAtMs = when.eatenAtMs;
        patch.tzOffset = tzOffset;
        patch.eatenAtMs = eatenAtMs;
        patch.eatenAtUtc = toUtcIso(eatenAtMs);
        patch.at = when.at || utcMsToAt(eatenAtMs, tzOffset);
      }
    }

    assertValid(fields);

    // 改了店名/城市但没显式给 shopId：重新归一到 (name, city) 的店铺实体
    if (('shop' in patch || 'city' in patch) && !('shopId' in patch)) {
      const nextShop = 'shop' in patch ? patch.shop : record.shop;
      const nextCity = 'city' in patch ? patch.city : record.city;
      patch.shopId = nextShop ? ensureShop(ctx.userId, nextShop, nextCity) : null;
    }

    Object.assign(record, patch, {
      version: record.version + 1,
      updatedAt: toUtcIsoAfter(Date.now(), record.updatedAt),
    });

    ctx.json(200, serializeRecord(record), NO_STORE);
  }, { auth: true });

  router.delete('/records/:id', (ctx) => {
    const raw = rawOf(ctx.userId, ctx.params.id);
    // 不存在 / 别人的 → 404（绝不 403）；已删除的 → 204 幂等
    if (!raw) throw notFound();
    if (raw.deletedAt === null) {
      raw.deletedAt = toUtcIso(Date.now());
      raw.version += 1;
      raw.updatedAt = raw.deletedAt;
    }
    ctx.noContent(NO_STORE);
  }, { auth: true });

  // P1：撤销删除（软删留的口子，AC-35）
  router.post('/records/:id/restore', (ctx) => {
    const raw = rawOf(ctx.userId, ctx.params.id);
    if (!raw) throw notFound();
    if (raw.deletedAt !== null) {
      raw.deletedAt = null;
      raw.version += 1;
      raw.updatedAt = toUtcIsoAfter(Date.now(), raw.updatedAt);
    }
    ctx.json(200, serializeRecord(raw), NO_STORE);
  }, { auth: true });

  /* ================= 聚合 ================= */

  router.get('/stats', (ctx) => {
    const filters = parseFilters(ctx.query);
    if (filters.error) throw badRequest(filters.error);
    // 默认全量；显式传筛选才收窄（P2 预留，口径与列表一致）
    const scoped = filters.city || filters.cityMissing || filters.province;
    const records = scoped ? filterFor(ctx, filters) : allOf(ctx.userId);
    const stats = statsAggregate(records);
    ctx.json(200, {
      scope: {
        city: filters.city ?? null,
        cityMissing: !!filters.cityMissing,
        from: ctx.query.get('from') || null,
        to: ctx.query.get('to') || null,
      },
      ...stats,
    }, NO_STORE);
  }, { auth: true });

  /* ================= 店铺 ================= */

  // /shops/by-name 必须先于 /shops/:shopId（§5）
  router.get('/shops/by-name', (ctx) => {
    const name = (ctx.query.get('name') || '').trim();
    if (!name) throw badRequest('name 必填');
    const city = ctx.query.get('city') || null;

    let records = allOf(ctx.userId).filter((r) => r.shop === name);
    if (city) records = records.filter((r) => r.city === city);
    if (!records.length) throw notFound('这家店还没有记录');

    // 同名跨城：shop 无法唯一确定 → shop=null + candidates（AC-26）
    const byShopId = new Map();
    for (const r of records) {
      if (!r.shopId) continue;
      if (!byShopId.has(r.shopId)) byShopId.set(r.shopId, []);
      byShopId.get(r.shopId).push(r);
    }
    const candidates = [...byShopId.entries()].map(([shopId, list]) => {
      const shop = findShop(ctx.userId, shopId);
      return {
        id: shopId,
        name: shop ? shop.name : name,
        cities: [...new Set(list.map((r) => r.city).filter(Boolean))],
        /* 店铺建档时间：契约 §6.4.1 的 `shop.createdAt` 是 ISO 字符串。
           以前这里是 `createdAt: null`，前端拿到 null 会当"没有建档时间"处理；
           店铺行本来就有这个值（store.ensureShop 写入），没理由丢。 */
        createdAt: shop ? shop.createdAt : null,
      };
    });

    const agg = shopAggregate(records);
    ctx.json(200, {
      shop:
        candidates.length === 1
          ? {
              id: candidates[0].id,
              name,
              cities: candidates[0].cities,
              createdAt: candidates[0].createdAt,
            }
          : null,
      /* 多候选分支保持原形状（AC-26 只约定 id/name/cities），不把 createdAt 漏进去 */
      ...(candidates.length > 1
        ? { candidates: candidates.map((c) => ({ id: c.id, name: c.name, cities: c.cities })) }
        : {}),
      stats: agg.stats,
      records: agg.records,
      nextCursor: null,
      hasMore: false,
    }, NO_STORE);
  }, { auth: true });

  router.get('/shops/:shopId', (ctx) => {
    const shop = findShop(ctx.userId, ctx.params.shopId);
    if (!shop) throw notFound('店铺不存在');
    const records = allOf(ctx.userId).filter((r) => r.shopId === shop.id);
    if (!records.length) throw notFound('这家店还没有记录');
    const agg = shopAggregate(records);
    ctx.json(200, {
      shop: { id: shop.id, name: shop.name, cities: agg.cities, createdAt: shop.createdAt },
      stats: agg.stats,
      records: agg.records,
      nextCursor: null,
      hasMore: false,
    }, NO_STORE);
  }, { auth: true });

  /* ================= 照片 ================= */

  router.post('/photos', async (ctx) => {
    const contentType = ctx.req.headers['content-type'] || '';
    if (!/^multipart\/form-data/i.test(contentType)) {
      throw new ApiError('UNSUPPORTED_MEDIA_TYPE', '请使用 multipart/form-data 上传');
    }
    const boundary = boundaryOf(contentType);
    const buf = await ctx.rawBody();
    const { files, fields } = parseMultipart(buf, boundary);

    // 契约只认 `file` 字段（§6.5.1）：别的字段名一律当"没传文件"
    const file = files.find((f) => f.name === 'file');
    if (!file || !file.data.length) {
      throw new ApiError('VALIDATION_FAILED', '缺少 file 字段', { fields: { file: '不能为空' } });
    }
    if (file.data.length > MAX_PHOTO_BYTES) {
      throw new ApiError('FILE_TOO_LARGE', '照片超过 10 MiB');
    }
    // 按魔数判断，不信扩展名（.gif 改名成 .jpg 也要 415）
    const mime = sniffImageMime(file.data);
    if (!mime || !ALLOWED_IMAGE_MIME.has(mime)) {
      throw new ApiError('UNSUPPORTED_MEDIA_TYPE', '仅支持 jpeg/png/webp');
    }
    // mock 审核开关：测试用 X-Mock-Reject-Image 模拟 imgSecCheck 不通过（AC-30）
    if (ctx.req.headers['x-mock-reject-image'] === '1') {
      throw new ApiError('IMAGE_REJECTED', '图片未通过内容安全审核');
    }

    const size = imageSize(file.data, mime);
    const photoId = `pho_${ulid()}`;
    const urls = photoUrls(ctx, photoId, mime);
    const nowMs = Date.now();
    const photo = {
      id: photoId,
      userId: ctx.userId,
      mime,
      size: file.data.length,
      width: size ? size.width : null,
      height: size ? size.height : null,
      scene: fields.scene || 'record',
      status: 'approved',
      url: urls.url,
      photoUrl: urls.photo,
      thumbUrl: urls.photoThumb,
      bytes: file.data,
      createdAt: toUtcIso(nowMs),
      deletedAt: null,
    };
    insertPhoto(photo);

    ctx.json(201, {
      photoId,
      url: photo.url,
      photo: photo.photoUrl,
      photoThumb: photo.thumbUrl,
      width: photo.width,
      height: photo.height,
      size: photo.size,
      mime: photo.mime,
      status: photo.status,
      createdAt: photo.createdAt,
    }, NO_STORE);
  }, { auth: true });

  router.delete('/photos/:photoId', (ctx) => {
    const photo = findPhoto(ctx.userId, ctx.params.photoId);
    if (!photo) throw notFound('照片不存在');
    if (photoInUse(photo.id)) {
      throw new ApiError('PHOTO_IN_USE', '照片仍被记录引用');
    }
    photo.deletedAt = toUtcIso(Date.now());
    ctx.noContent(NO_STORE);
  }, { auth: true });

  /** 图片字节回读：GET /v1/files/{photoId}.jpg|.orig|-400.jpg
   *  上传的字节必须能取回（AC-28：三个 URL 都 200，Content-Type 正确）。
   *  mock 不做真实缩放：-400 后缀也回原图，前端只看 URL 形态。 */
  router.get('/files/:name', async (ctx) => {
    const m = /^(.+?)(-400)?\.(jpg|jpeg|png|webp|orig)$/i.exec(ctx.params.name);
    if (!m) throw notFound('文件不存在');
    const photo = photoBytes(m[1]);
    if (!photo) {
      /* 兜底：预置静态图（src/static/img/）。真机调试时前端把 /static/img/*
         改写成 <mock>/v1/files/*（见 packages/ui-taro/src/utils/asset.ts 的
         TARO_APP_ASSET_BASE），从而不把这些图打进小程序包，主包少 ~820KB。
         内存里查不到就直接读磁盘上的预置图；读不到才算真 404。 */
      try {
        const { readFile } = await import('node:fs/promises');
        const { resolve } = await import('node:path');
        /* 前端 resolveAssetUrl 会把 /static/img/x.jpg 拼成 <base>/static/img/x.jpg，
           所以这里的 name 带 "static/img/" 前缀；剥掉它再定位文件。 */
        const rel = ctx.params.name.replace(/^static\/img\//, '');
        const buf = await readFile(resolve(import.meta.dirname, '../static/img', rel));
        const ext = m[3].toLowerCase();
        return ctx.raw(200, buf, ext === 'orig' ? 'application/octet-stream' : ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg', {
          'Cache-Control': 'public, max-age=31536000, immutable',
          'Content-Disposition': `inline; filename="${m[1]}.${ext === 'orig' ? 'bin' : ext}"`,
        });
      } catch {
        throw notFound('文件不存在');
      }
    }
    const ext = m[3].toLowerCase();
    const contentType =
      ext === 'orig' ? photo.mime : ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
    ctx.raw(200, photo.bytes, contentType, {
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Content-Disposition': `inline; filename="${m[1]}.${ext === 'orig' ? 'bin' : ext}"`,
    });
  });

  /* ================= 字典 ================= */

  router.get('/geo/cities', (ctx) => {
    const provinces = provinceCatalogue();
    const payload = {
      version: '2026-10-01',
      updatedAt: '2026-10-01T00:00:00Z',
      provinces,
    };
    const etag = `W/"geo-${provinces.length}-20261001"`;
    const inm = ctx.req.headers['if-none-match'];
    if (inm && inm === etag) {
      // 304 不能带 body，也不能带 Content-Length（Node 会当成 chunked）
      ctx.res.writeHead(304, {
        'Access-Control-Allow-Origin': '*',
        ETag: etag,
        'Cache-Control': 'public, max-age=86400',
        'X-Request-Id': ctx.requestId,
      });
      return ctx.res.end();
    }
    ctx.json(200, payload, {
      ETag: etag,
      'Cache-Control': 'public, max-age=86400',
    });
  });
}

/* ================= 内部工具 ================= */

function userPayload(user) {
  return {
    id: user.id,
    createdAt: user.createdAt,
    recordCount: allOf(user.id).length,
  };
}

/** 列表/随机/月份共用的筛选入口（province 用字典展开） */
function filterFor(ctx, filters) {
  const provinceCities = filters.province ? citiesOfProvince(filters.province) : null;
  return applyFilters(allOf(ctx.userId), filters, { provinceCities });
}

/** limit 1–50，缺省 10；越界 → 400（无 fields，§3.7） */
function parseLimit(raw, fallback, max) {
  if (raw === null || raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(String(raw))) throw badRequest('limit 必须是正整数');
  const n = Number(raw);
  if (n < 1 || n > max) throw badRequest(`limit 必须在 1-${max} 之间`);
  return n;
}
