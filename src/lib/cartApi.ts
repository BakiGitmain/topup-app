import AsyncStorage from '@react-native-async-storage/async-storage';

import { needsAccountId, type Category } from './catalog';
import type { BuyerField } from './idValidation';
import { parseBuyerFields } from './productPage';
import { supabase } from './supabase';

// The cart lives in the database (cart_items, readable and writable only by its owner) so it survives closing the
// app AND reinstalling. A copy is kept on the device, per customer, so it shows instantly and offline.

export type CartLine = {
  id: string;
  optionId: string;
  quantity: number;
  /** THIS line's own player/game ID. Free Fire and PUBG lines have different ones. */
  fields: Record<string, string>;
  /** The customer's "I've checked my ID" tick, for games the supplier can't check. */
  idChecked: boolean;
  /** False when the pack, its product or its region is no longer on sale (or has been removed). */
  available: boolean;
  productName: string;
  label: string;
  unitPrice: number;
  imageUrl: string | null;
  regionId: string | null;
  regionLabel: string | null;
  buyerFields: BuyerField[];
  idMode: 'supplier' | 'tick' | 'none';
  regionLocked: boolean;
  accountRegionCodes: string[];
};

type OptionRow = {
  id: string;
  label: string;
  price: number | string;
  region_id: string | null;
  region_locked: boolean;
  account_region_codes: string[] | null;
  is_active: boolean;
  image_url: string | null;
  products: { id: string; name: string; category: Category; image_url: string | null; is_active: boolean } | null;
  product_regions: { id: string; label: string; buyer_fields: unknown; id_validation: string; is_active: boolean } | null;
};

type Row = {
  id: string;
  option_id: string;
  quantity: number;
  fields: Record<string, unknown> | null;
  id_checked: boolean;
  product_options: OptionRow | OptionRow[] | null;
};

// One literal (not concatenated) so the Supabase client can read it as a select string.
const COLUMNS =
  'id, option_id, quantity, fields, id_checked, product_options ( id, label, price, region_id, region_locked, account_region_codes, is_active, image_url, products ( id, name, category, image_url, is_active ), product_regions ( id, label, buyer_fields, id_validation, is_active ) )';

const one = <T>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));

const cleanFields = (raw: Record<string, unknown> | null): Record<string, string> =>
  Object.fromEntries(Object.entries(raw ?? {}).filter(([, v]) => typeof v === 'string' || typeof v === 'number').map(([k, v]) => [k, String(v)]));

export function toCartLine(row: Row): CartLine {
  const option = one(row.product_options);
  const product = option ? one(option.products) : null;
  const region = option ? one(option.product_regions) : null;
  const available = !!option && option.is_active && !!product && product.is_active && (option.region_id === null || (!!region && region.is_active));

  let buyerFields: BuyerField[] = region ? parseBuyerFields(region.buyer_fields) : [];
  // Older packs with no region take one game ID.
  if (!region && product && needsAccountId(product.category)) buyerFields = [{ key: 'account_id', label: 'Game ID', type: 'text' }];
  const idMode: CartLine['idMode'] = region ? (region.id_validation === 'supplier' ? 'supplier' : buyerFields.length > 0 ? 'tick' : 'none') : 'none';

  return {
    id: row.id,
    optionId: row.option_id,
    quantity: row.quantity,
    fields: cleanFields(row.fields),
    idChecked: row.id_checked === true,
    available,
    productName: product?.name ?? '',
    label: option?.label ?? '',
    unitPrice: option ? Number(option.price) : 0,
    imageUrl: option?.image_url ?? product?.image_url ?? null,
    regionId: option?.region_id ?? null,
    regionLabel: region?.label ?? null,
    buyerFields,
    idMode,
    regionLocked: option?.region_locked === true,
    accountRegionCodes: option?.account_region_codes ?? [],
  };
}

export async function fetchCart(userId: string): Promise<CartLine[]> {
  const { data, error } = await supabase.from('cart_items').select(COLUMNS).eq('user_id', userId).order('created_at', { ascending: true });
  if (error) throw error;
  return ((data ?? []) as unknown as Row[]).map(toCartLine);
}

// ---------------------------------------------------------------- the device copy (per customer)

const cacheKey = (userId: string) => `cart:v1:${userId}`;

export async function loadCachedCart(userId: string): Promise<CartLine[] | null> {
  try {
    const raw = await AsyncStorage.getItem(cacheKey(userId));
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed) ? (parsed as CartLine[]) : null;
  } catch {
    return null;
  }
}

export async function saveCachedCart(userId: string, lines: readonly CartLine[]): Promise<void> {
  try {
    await AsyncStorage.setItem(cacheKey(userId), JSON.stringify(lines));
  } catch {
    // The database copy is the real one.
  }
}

// ---------------------------------------------------------------- changes

export const sameFields = (a: Record<string, string>, b: Record<string, string>) => {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k] === b[k]);
};

/** Adds a pack for a player ID. The same pack for the same ID becomes one line with a higher quantity. */
export async function addToCart(userId: string, input: { optionId: string; fields: Record<string, string>; idChecked: boolean }): Promise<void> {
  const { data, error } = await supabase.from('cart_items').select('id, quantity, fields').eq('user_id', userId).eq('option_id', input.optionId);
  if (error) throw error;
  const existing = ((data ?? []) as { id: string; quantity: number; fields: Record<string, unknown> | null }[]).find((r) => sameFields(cleanFields(r.fields), input.fields));

  if (existing) {
    const { error: updateError } = await supabase
      .from('cart_items')
      .update({ quantity: Math.min(20, existing.quantity + 1), id_checked: input.idChecked })
      .eq('id', existing.id);
    if (updateError) throw updateError;
    return;
  }
  const { error: insertError } = await supabase
    .from('cart_items')
    .insert({ user_id: userId, option_id: input.optionId, quantity: 1, fields: input.fields, id_checked: input.idChecked });
  if (insertError) throw insertError;
}

export async function setQuantity(lineId: string, quantity: number): Promise<void> {
  const { error } = await supabase.from('cart_items').update({ quantity }).eq('id', lineId);
  if (error) throw error;
}

export async function setIdChecked(lineId: string, checked: boolean): Promise<void> {
  const { error } = await supabase.from('cart_items').update({ id_checked: checked }).eq('id', lineId);
  if (error) throw error;
}

export async function removeLines(lineIds: readonly string[]): Promise<void> {
  if (lineIds.length === 0) return;
  const { error } = await supabase.from('cart_items').delete().in('id', [...lineIds]);
  if (error) throw error;
}
