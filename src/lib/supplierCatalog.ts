import type { CatalogFamily, CatalogRow, ImportPayload, LoadOffersOutcome, RefreshOutcome, SupplierName } from './importPlan';
import { parseLoadOffers, parseRefresh } from './importPlan';
import { supabase } from './supabase';

// The saved supplier catalog (public.supplier_catalog). Admins read it directly: row-level security lets
// no one else see a row. The supplier itself is only ever called by the supplier-catalog Edge Function.

export const SEARCH_LIMIT = 120;

// One literal (not concatenated) so the Supabase client can read it as a select string.
const CATALOG_COLUMNS =
  'supplier, family, category_id, name, game_name, region_label, note_region, validation_category_id, validation_fields, offers, fields, hidden_offer_count, offers_fetched_at';

/** Characters that would break out of the filter expression. */
const cleanQuery = (text: string) => text.trim().replace(/[,()*%\\]/g, '').slice(0, 60);

/** Categories matching a game or gift card name, from ONE supplier's saved catalog. Blocked categories are never returned. */
export async function searchCatalog(text: string, supplier: SupplierName): Promise<CatalogRow[]> {
  // Every word must match the game, the category name or its region ("fire free mena"), in games AND gift cards alike.
  const tokens = cleanQuery(text).split(/\s+/).filter(Boolean).slice(0, 4);
  if (tokens.join(' ').length < 2) return [];
  let request = supabase.from('supplier_catalog').select(CATALOG_COLUMNS).eq('supplier', supplier).is('blocked_reason', null);
  for (const t of tokens) request = request.or(`game_name.ilike.*${t}*,name.ilike.*${t}*,region_label.ilike.*${t}*`);
  const { data, error } = await request.order('game_name', { ascending: true }).limit(SEARCH_LIMIT);
  if (error) throw error;
  return (data ?? []) as unknown as CatalogRow[];
}

export type CatalogStatus = { categories: number; blocked: number; refreshedAt: string | null; withPacks: number };

/** How big one supplier's saved catalog is, and when it was last listed. */
export async function fetchCatalogStatus(supplier: SupplierName): Promise<CatalogStatus> {
  const [all, blocked, packs, latest] = await Promise.all([
    supabase.from('supplier_catalog').select('category_id', { count: 'exact', head: true }).eq('supplier', supplier),
    supabase.from('supplier_catalog').select('category_id', { count: 'exact', head: true }).eq('supplier', supplier).not('blocked_reason', 'is', null),
    supabase.from('supplier_catalog').select('category_id', { count: 'exact', head: true }).eq('supplier', supplier).not('offers_fetched_at', 'is', null),
    supabase.from('supplier_catalog').select('listed_at').eq('supplier', supplier).order('listed_at', { ascending: false }).limit(1),
  ]);
  for (const r of [all, blocked, packs, latest]) if (r.error) throw r.error;
  const first = (latest.data as { listed_at: string }[] | null)?.[0];
  return { categories: all.count ?? 0, blocked: blocked.count ?? 0, withPacks: packs.count ?? 0, refreshedAt: first?.listed_at ?? null };
}

async function callFunction(body: Record<string, unknown>): Promise<unknown> {
  try {
    const { data, error } = await supabase.functions.invoke('supplier-catalog', { body });
    return error ? null : data;
  } catch {
    return null;
  }
}

/** Asks the function to list one supplier's whole catalog again. Never throws. */
export async function refreshCatalog(supplier: SupplierName): Promise<RefreshOutcome> {
  return parseRefresh(await callFunction({ action: 'refresh_catalog', supplier }));
}

/** Fetches one category's packs and costs live, saves them with today's date, and returns them. Never throws. */
export async function loadOffers(supplier: SupplierName, family: CatalogFamily, categoryId: string): Promise<LoadOffersOutcome> {
  return parseLoadOffers(await callFunction({ action: 'load_offers', supplier, family, category_id: categoryId }));
}

/** Creates the product, regions and packs in one transaction, all switched off. Returns the product id. */
export async function importProduct(payload: ImportPayload): Promise<string> {
  const { data, error } = await supabase.rpc('admin_import_product', { p_payload: payload });
  if (error) throw error;
  if (typeof data !== 'string') throw new Error('import_failed');
  return data;
}

/**
 * The dollar-to-birr rate an admin set (public.pricing_settings, one row). Throws when it can't be read: the import screen then
 * leaves prices for the admin to type instead of assuming a number.
 */
export async function fetchUsdRate(): Promise<number> {
  const { data, error } = await supabase.from('pricing_settings').select('usd_to_birr').maybeSingle();
  if (error) throw error;
  const rate = Number(data?.usd_to_birr);
  if (!Number.isFinite(rate) || rate <= 0) throw new Error('rate_unavailable');
  return rate;
}

/** Saves the rate. Row-level security lets only admins change it, so a write that changed nothing is reported, not ignored. */
export async function saveUsdRate(rate: number): Promise<void> {
  const { data, error } = await supabase.from('pricing_settings').update({ usd_to_birr: rate }).eq('id', true).select('usd_to_birr');
  if (error) throw error;
  if (!data || data.length === 0) throw new Error('rate_not_saved');
}
