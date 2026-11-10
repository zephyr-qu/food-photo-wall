/** 店铺 find-or-create（唯一键 user_id + name + city；同名跨城 = 两家店） */
import { nowMs } from '../lib/time.js';
import { newId } from '../lib/ids.js';
import type { Store } from '../store/store.js';
import type { ShopRow } from '../store/types.js';

export function findOrCreateShop(
  store: Store,
  userId: string,
  name: string,
  city: string | null,
): ShopRow {
  const existing = store.findShopByNameCity(userId, name, city);
  if (existing) return existing;
  const shop: ShopRow = { id: newId('shp'), userId, name, city, createdAt: nowMs() };
  store.insertShop(shop);
  return shop;
}
