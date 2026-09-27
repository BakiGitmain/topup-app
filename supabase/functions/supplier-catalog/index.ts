// Edge Function: admin-only access to the supplier catalogs, saved in public.supplier_catalog.
//
// TWO live suppliers, admin-picked per import: Shop2Topup and GamesDrop (2026-09-22). FazerCards' trial has ended; it is
// not offered anywhere any more, but FAZER_API_KEY is left configured (untouched, unused) in case it is wired back in
// later -- nothing here reads it. The `supplier` field on a request is checked against a list (see router.ts), so a
// fourth supplier is "write its handler, add it to the list", not a rebuild. Each key lives only in this function's
// secrets: the app never sees either and never calls a supplier directly. Every saved row carries its supplier and every
// read, write, count and delete here is scoped to it, so refreshing one supplier can never touch another's rows.
//
// Runs on Deno. The logic is in handler.ts (tested in Node); this file only wires it up.
import { createClient } from 'npm:@supabase/supabase-js@2';

import type { CategoryRow, Family, OffersResult } from '../_shared/catalog.ts';
import { GAMESDROP, createGamesDropClient, type GDOffer, normalizeGamesDropCategory, toRawCategories as gdToRawCategories, toRawOffers as gdToRawOffers } from '../_shared/gamesdrop.ts';
import {
  createShop2TopupClient, fieldsFromRequirements, normalizeShop2TopupCategory, toRawCategories, toRawOffers,
} from '../_shared/shop2topup.ts';
import { createHandler, type CachedOffers, type Deps } from './handler.ts';
import { createRouter, type SupplierName } from './router.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const SHOP2TOPUP_API_KEY = Deno.env.get('SHOP2TOPUP_API_KEY') ?? '';
const GAMESDROP_API_KEY = Deno.env.get('GAMESDROP_API_KEY') ?? '';

const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const shop2topup = createShop2TopupClient({ key: SHOP2TOPUP_API_KEY, timeoutMs: 20_000 });
const gamesdrop = createGamesDropClient({ key: GAMESDROP_API_KEY, timeoutMs: 20_000 });

const KEY = 'supplier,family,category_id';

/** The parts that are the same for every supplier: who is asking, and the saved catalog (scoped to `supplier`). */
function shared(supplier: SupplierName): Pick<
  Deps,
  'refreshTimeoutMs' | 'offersTimeoutMs' | 'getUserId' | 'isAdmin' | 'loadBlocklist' | 'countCatalog' | 'upsertCategories' | 'deleteStale' | 'getCached' | 'saveOffers' | 'now' | 'log'
> {
  return {
    refreshTimeoutMs: 100_000,
    offersTimeoutMs: 30_000,

    async getUserId(token) {
      const { data, error } = await admin.auth.getUser(token);
      return error || !data.user ? null : data.user.id;
    },

    async isAdmin(userId) {
      const { data, error } = await admin.from('profiles').select('role').eq('id', userId).maybeSingle();
      if (error) throw error;
      return data?.role === 'admin';
    },

    async loadBlocklist() {
      const { data, error } = await admin.from('blocked_supplier_categories').select('family, category_id, reason').eq('supplier', supplier);
      if (error) throw error;
      return Object.fromEntries((data ?? []).map((r) => [`${r.family}/${r.category_id}`, r.reason as string]));
    },

    async countCatalog() {
      const { count, error } = await admin.from('supplier_catalog').select('category_id', { count: 'exact', head: true }).eq('supplier', supplier);
      if (error) throw error;
      return count ?? 0;
    },

    async upsertCategories(rows: CategoryRow[]) {
      for (let i = 0; i < rows.length; i += 150) {
        const { error } = await admin.from('supplier_catalog').upsert(rows.slice(i, i + 150), { onConflict: KEY });
        if (error) throw error;
      }
    },

    async deleteStale(listedBefore: string) {
      // ONLY this supplier's rows: a Shop2Topup refresh must never delete FazerCards categories (or the reverse).
      const { count, error } = await admin.from('supplier_catalog').delete({ count: 'exact' }).eq('supplier', supplier).lt('listed_at', listedBefore);
      if (error) throw error;
      return count ?? 0;
    },

    async getCached(family: Family, categoryId: string) {
      const { data, error } = await admin
        .from('supplier_catalog')
        .select('offers, fields, hidden_offer_count, offers_fetched_at, blocked_reason')
        .eq('supplier', supplier)
        .eq('family', family)
        .eq('category_id', categoryId)
        .maybeSingle();
      if (error) throw error;
      return (data as CachedOffers | null) ?? null;
    },

    async saveOffers(family: Family, categoryId: string, result: OffersResult, fetchedAt: string) {
      const patch: Record<string, unknown> = {
        offers: result.offers,
        fields: result.fields,
        hidden_offer_count: result.hidden_offer_count,
        offers_fetched_at: fetchedAt,
      };
      if (result.blocked_reason) patch.blocked_reason = result.blocked_reason;
      const { data, error } = await admin
        .from('supplier_catalog')
        .update(patch)
        .eq('supplier', supplier)
        .eq('family', family)
        .eq('category_id', categoryId)
        .select('category_id');
      if (error) throw error;
      return (data ?? []).length > 0;
    },

    now: () => new Date(),
    log: (event) => console.log(JSON.stringify({ supplier, ...event })),
  };
}

// ---- Shop2Topup: its catalog is a tree (game > region variants > packs), listed a few games at a time.
async function mapLimit<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (let i = next++; i < items.length; i = next++) out[i] = await work(items[i]);
    })
  );
  return out;
}

let treeMemo: { at: number; tree: Promise<Awaited<ReturnType<typeof loadTree>>> } | null = null;
async function loadTree() {
  const games = await shop2topup.bigCategories();
  return await mapLimit(games, 6, async (g) => ({ ...g, categories: await shop2topup.categories(g.id) }));
}
/** A refresh lists top-ups and vouchers back to back: read the tree once for both. */
function tree() {
  if (!treeMemo || Date.now() - treeMemo.at > 60_000) treeMemo = { at: Date.now(), tree: loadTree() };
  return treeMemo.tree;
}

const shop2topupHandler = createHandler({
  ...shared('shop2topup'),
  normalizeCategory: (family, raw, ctx) => normalizeShop2TopupCategory(family, raw, ctx),

  async listCategories(family: Family) {
    return toRawCategories(await tree(), family);
  },

  // Shop2Topup has no "which games can be checked" list: the games proven to validate are in _shared/shop2topup.ts.
  async listValidationGames() {
    return [];
  },

  async fetchOffers(family: Family, categoryId: string) {
    const [subs, requirements] = await Promise.all([
      shop2topup.subcategories(categoryId),
      family === 'topups' ? shop2topup.requirements(categoryId) : Promise.resolve([]),
    ]);
    return toRawOffers(family, subs, fieldsFromRequirements(requirements));
  },
});

// ---- GamesDrop: a flat list of every pack (no category tree of its own). Its full catalog is ~64,000 offers across 64
// pages of /offers/sync, which measured 100-135+ seconds to pull live (2026-09-22) -- longer than refreshTimeoutMs, so
// `refresh_catalog` for GamesDrop always timed out and never saved anything. There is deliberately no full-catalog pull
// here any more: `search_catalog` (below) scopes every call to the admin's own query via /offers/sync's own `search`
// param (confirmed server-side: "Blood Strike" -> 46 rows, a nonsense query -> 0, both in a few seconds, out of a
// 63,829-row catalog), and `fetchOffers` (for "load offers" on one already-searched category) re-runs that same scoped
// search by the category's saved game_name instead of ever touching the whole catalog.
let gdSearchMemo: { query: string; at: number; rows: Promise<GDOffer[]> } | null = null;
/** One page (limit 1000) is enough for a scoped query: "Blood Strike" matched 46 of the 63,829 total offers. Shared
 * between the two searchLive calls one search_catalog request makes (topups, then giftcards) via a short memo, same
 * pattern as Shop2Topup's `tree()` above. */
function gamesdropSearch(query: string) {
  if (!gdSearchMemo || gdSearchMemo.query !== query || Date.now() - gdSearchMemo.at > 5_000) {
    gdSearchMemo = { query, at: Date.now(), rows: gamesdrop.sync({ search: query, limit: 1000, page: 1 }).then((r) => r.rows) };
  }
  return gdSearchMemo.rows;
}

const gamesdropHandler = createHandler({
  ...shared(GAMESDROP),
  normalizeCategory: (family, raw, ctx) => normalizeGamesDropCategory(family, raw, ctx),

  // No bulk listing any more (see above): a fresh install has nothing until the admin searches for something.
  async listCategories() {
    return [];
  },

  async searchLive(family: Family, query: string) {
    return gdToRawCategories(await gamesdropSearch(query), family);
  },

  // GamesDrop has no "which games can be checked" list: the games proven to validate are in _shared/gamesdrop.ts.
  async listValidationGames() {
    return [];
  },

  async fetchOffers(family: Family, categoryId: string) {
    // Only reachable for a category search_catalog already saved (loadOffers 404s first otherwise), so its game_name is there.
    const { data, error } = await admin.from('supplier_catalog').select('game_name').eq('supplier', GAMESDROP).eq('family', family).eq('category_id', categoryId).maybeSingle();
    if (error) throw error;
    if (!data?.game_name) return { offers: [], fields: [] };
    return gdToRawOffers(family, await gamesdropSearch(data.game_name), categoryId);
  },
});

Deno.serve(createRouter({ shop2topup: shop2topupHandler, gamesdrop: gamesdropHandler }));
