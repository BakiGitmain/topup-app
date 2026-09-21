// Edge Function: admin-only access to the supplier catalogs, saved in public.supplier_catalog.
//
// TWO suppliers: FazerCards (live products are built on it) and Shop2Topup (being tested alongside it). A request says which
// one with `"supplier": "fazercards" | "shop2topup"` (default fazercards). Each supplier has its own key
// (FAZER_API_KEY / SHOP2TOPUP_API_KEY), which lives only in this function's secrets: the app never sees either and never calls
// a supplier. Every saved row carries its supplier and every read, write, count and delete here is scoped to it, so
// refreshing one supplier can never touch the other's rows. Wholesale costs are saved in an admin-only table.
//
// Runs on Deno. The logic is in handler.ts (tested in Node); this file only wires it up.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { FazerCardsClient } from 'npm:fazercards@0.2.0';

import { normalizeCategory, type CategoryRow, type Family, type OffersResult, type RawCategory } from '../_shared/catalog.ts';
import {
  createShop2TopupClient, fieldsFromRequirements, normalizeShop2TopupCategory, toRawCategories, toRawOffers,
} from '../_shared/shop2topup.ts';
import { createHandler, type CachedOffers, type Deps } from './handler.ts';
import { createRouter, type SupplierName } from './router.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const FAZER_API_KEY = Deno.env.get('FAZER_API_KEY') ?? '';
const SHOP2TOPUP_API_KEY = Deno.env.get('SHOP2TOPUP_API_KEY') ?? '';

const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// An admin is waiting, so a couple of tries is fine; the handler's own timeouts bound each step.
const fazer = FAZER_API_KEY
  ? new FazerCardsClient({ apiKey: FAZER_API_KEY, appName: 'topup-catalog/1.0', timeoutMs: 20_000, retries: 1 })
  : null;
const shop2topup = createShop2TopupClient({ key: SHOP2TOPUP_API_KEY, timeoutMs: 20_000 });

function needFazer() {
  if (!fazer) throw Object.assign(new Error('supplier key is not configured'), { status: 503 });
  return fazer;
}

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

// ---- FazerCards: exactly what it always did.
const fazerHandler = createHandler({
  ...shared('fazercards'),
  normalizeCategory,

  async listCategories(family: Family) {
    const client = needFazer();
    const out: RawCategory[] = [];
    const pages = family === 'topups' ? client.topups.iterCategories({ limit: 100 }) : client.giftcards.iterCategories({ limit: 100 });
    for await (const c of pages) {
      out.push(c as unknown as RawCategory);
      if (out.length >= 5000) break;
    }
    return out;
  },

  async listValidationGames() {
    const result = await needFazer().topups.validateIdGames();
    return (result as { items?: unknown[] }).items ?? [];
  },

  async fetchOffers(family: Family, categoryId: string) {
    const client = needFazer();
    return family === 'topups' ? await client.topups.offers(categoryId) : await client.giftcards.cards(categoryId);
  },
});

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

Deno.serve(createRouter({ fazercards: fazerHandler, shop2topup: shop2topupHandler }));
