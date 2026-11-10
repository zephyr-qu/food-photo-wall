-- ============================================================================
-- 照片墙 · PostgreSQL schema（对齐 docs/api/photo-wall-api.md §7.1）
-- 说明：本仓库默认跑内存存储（MemoryStore），这份 DDL 是生产库的落地形态；
--      换 Postgres 只需实现 Store 接口（见 server/README.md「换 PostgreSQL」）。
-- 关键约束：
--   * at_local 固定 char(16) 'YYYY-MM-DDTHH:mm'，直接下发前端（无秒/无时区）
--   * eaten_at_utc 用于排序、游标、跨时区；月份统计按 at_local 归桶
--   * 逻辑删除用 deleted_at；列表/聚合一律 where deleted_at is null
--   * 所有查询必须带 user_id（数据按用户隔离，别人的资源返回 404）
-- ============================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- 用户
create table if not exists users (
  id            text primary key,                       -- usr_<ulid>
  wechat_openid text unique,                            -- 小程序
  device_id     text unique,                            -- H5 匿名
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint users_identity_chk check (wechat_openid is not null or device_id is not null)
);

-- ---------------------------------------------------------------- 店铺
create table if not exists shops (
  id         text primary key,                          -- shp_<ulid>
  user_id    text not null references users(id) on delete cascade,
  name       text not null,
  city       text,                                      -- 同名跨城 = 两家店
  created_at timestamptz not null default now(),
  unique (user_id, name, city)
);
create index if not exists shops_user_name_idx on shops(user_id, name);

-- ---------------------------------------------------------------- 照片
create table if not exists photos (
  id         text primary key,                          -- pho_<ulid>
  user_id    text not null references users(id) on delete cascade,
  url        text not null,                             -- 原图
  photo_url  text not null,                             -- 1080w 展示图
  thumb_url  text not null,                             -- 400w 缩略图
  width      integer,
  height     integer,
  size       integer,
  mime       text,
  status     text not null default 'approved'
             check (status in ('approved', 'rejected')),
  created_at timestamptz not null default now(),
  deleted_at timestamptz                                -- 待回收 / 已删
);
create index if not exists photos_user_idx on photos(user_id, created_at desc);

-- ---------------------------------------------------------------- 记录
create table if not exists records (
  id            text primary key,                       -- rec_<ulid>；禁止 ^g.*_
  user_id       text not null references users(id) on delete cascade,
  eat           text not null check (char_length(eat) between 1 and 60),
  shop          text,                                   -- 店名快照
  shop_id       text references shops(id) on delete set null,
  city          text,                                   -- 不校验字典，允许表外值
  district      text,
  rating        smallint not null default 0 check (rating between 0 and 5),
  at_local      char(16) not null,                      -- 'YYYY-MM-DDTHH:mm'
  tz_offset     text not null default '+08:00',
  eaten_at_utc  timestamptz not null,                   -- 排序 / 游标
  note          text,
  -- 全部照片（有序，至多 5 张）。空数组 = 没有自定义照片（前端回落预置配图）。
  --
  -- ⚠ 这里用 text[] 而不是 photo_id text references photos(id)：
  --   Postgres 的**数组类型无法挂外键约束**（FK 只能挂在标量列上），
  --   所以引用完整性不再由数据库保证，改由应用层负责：
  --     · 写入前 assertPhotosUsable（照片存在、属于本人、未软删、已审核）；
  --     · 删除记录时级联软删不再被引用的照片；
  --     · 回收任务按"是否出现在未删除记录的 photo_ids 里"判定孤儿。
  --   这是有意取舍：换来的是"一条记录最多 5 张 + 有序"的表达能力，
  --   代价是应用层必须守住引用完整性（漏一处就会留下悬空 id）。
  photo_ids    text[] not null default '{}',
  version       integer not null default 1,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,                            -- 软删（撤销删除用）
  constraint records_at_local_chk check (at_local ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$'),
  constraint records_eat_chk check (eat <> '')
);

-- 列表主查询：user + (eaten_at_utc desc, id desc) keyset
create index if not exists records_user_time_idx
  on records(user_id, eaten_at_utc desc, id desc) where deleted_at is null;
create index if not exists records_user_city_idx
  on records(user_id, city, eaten_at_utc desc) where deleted_at is null;
create index if not exists records_user_shop_idx
  on records(user_id, shop_id, eaten_at_utc desc) where deleted_at is null;
create index if not exists records_user_eat_idx
  on records(user_id, eat) where deleted_at is null;   -- 反复吃 / dishCount
-- 月份桶按 at_local 归桶（不是 eaten_at_utc）
create index if not exists records_user_month_idx
  on records(user_id, left(at_local, 7), at_local desc) where deleted_at is null;

-- ---------------------------------------------------------------- 刷新令牌
create table if not exists refresh_tokens (
  token      text primary key,                          -- rt_<random>，轮换时删除
  user_id    text not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists refresh_tokens_user_idx on refresh_tokens(user_id);
create index if not exists refresh_tokens_expiry_idx on refresh_tokens(expires_at);

-- ---------------------------------------------------------------- 幂等键
create table if not exists idempotency_keys (
  user_id    text not null references users(id) on delete cascade,
  key        text not null,
  status     integer not null,
  body       jsonb not null,                            -- 首次响应快照
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,                      -- 24h
  primary key (user_id, key)
);
create index if not exists idempotency_expiry_idx on idempotency_keys(expires_at);

-- ---------------------------------------------------------------- 参考查询
-- 游标翻页（第一页）：keyset 用元组比较，索引直接命中
--   select * from records
--    where user_id = $1 and deleted_at is null
--    order by eaten_at_utc desc, id desc
--    limit $2 + 1;
-- 后续页：
--   ... and (eaten_at_utc, id) < ($cursor_at, $cursor_id)
-- 城市计数（不含未记）：
--   select city, count(*) from records
--    where user_id = $1 and deleted_at is null and coalesce(city,'') <> ''
--    group by city;
-- 墙统计（avgRating 分母含 0 分）：
--   select count(*) total,
--          count(*) filter (where rating = 5) five_count,
--          count(distinct city) filter (where coalesce(city,'') <> '') cities,
--          count(distinct shop) filter (where coalesce(shop,'') <> '') shops,
--          count(distinct eat) dish_count,
--          coalesce(sum(rating),0)::numeric / nullif(count(*),0) avg_rating_all,
--          count(*) filter (where rating > 0) rated_count,
--          coalesce(sum(rating) filter (where rating > 0),0)::numeric
--            / nullif(count(*) filter (where rating > 0),0) avg_rating_rated
--     from records where user_id = $1 and deleted_at is null;
-- 月份桶（必须按 at_local）：
--   select left(at_local,7) month, count(*)
--     from records where user_id = $1 and deleted_at is null
--    group by 1 order by 1 desc;
