// The supplier-catalog request handler, with every outside dependency injected so it can be tested
// without the network, the database or the supplier. index.ts wires the real ones.
//
// Three admin-only actions, all writing to the saved catalog (public.supplier_catalog):
//   refresh_catalog  list every supplier category and save it (packs and costs are NOT fetched here)
//   load_offers      fetch ONE category's packs, costs and buyer form, and save them with the date
//   search_catalog   list just the categories matching one query and save THOSE (see deps.searchLive below);
//                     for a supplier whose full catalog is too large to bulk-refresh (GamesDrop: ~64k offers,
//                     which alone takes longer than refreshTimeoutMs -- see CLAUDE.md 2026-09-22). A supplier that
//                     doesn't implement `searchLive` (Shop2Topup keeps its bulk refresh_catalog only) answers 400.
// Searching the saved catalog itself needs no function: admins read the table directly (row-level security);
// search_catalog only exists to POPULATE that table for a supplier that is never bulk-refreshed.
import {
  cleanValidationGames,
  normalizeCategory,
  normalizeOffers,
  type BuyerField,
  type CachedOffer,
  type CategoryRow,
  type Family,
  type OffersResult,
  type RawCategory,
  type ValidationGame,
} from '../_shared/catalog.ts';
import { CORS_HEADERS } from '../_shared/validation.ts';

export type CachedOffers = {
  offers: CachedOffer[] | null;
  fields: BuyerField[] | null;
  hidden_offer_count: number;
  offers_fetched_at: string | null;
  blocked_reason: string | null;
};

export type Deps = {
  getUserId: (token: string) => Promise<string | null>;
  isAdmin: (userId: string) => Promise<boolean>;
  /** "family/category_id" -> reason, from blocked_supplier_categories. */
  loadBlocklist: () => Promise<Record<string, string>>;
  /** Every category of one family. Throws on any supplier error. */
  listCategories: (family: Family) => Promise<RawCategory[]>;
  listValidationGames: () => Promise<unknown[]>;
  /**
   * Turns one raw supplier category into a saved row. Optional: FazerCards' rules (catalog.ts) apply unless a supplier brings
   * its own (Shop2Topup's category tree looks nothing like FazerCards' flat list).
   */
  normalizeCategory?: (family: Family, raw: RawCategory, ctx: { blocklist: Record<string, string>; validationGames: readonly ValidationGame[]; listedAt: string }) => CategoryRow | null;
  fetchOffers: (family: Family, categoryId: string) => Promise<{ offers?: unknown; fields?: unknown }>;
  /**
   * Live, scoped listing for `search_catalog`: every category of one family matching `query`, fetched directly
   * from the supplier (not the saved cache). Optional -- a supplier without this (Shop2Topup) never gets a
   * search_catalog request from the client, so its absence never needs to be handled beyond the 400 below.
   */
  searchLive?: (family: Family, query: string) => Promise<RawCategory[]>;
  countCatalog: () => Promise<number>;
  /** Insert or update the listing columns only; a category's saved packs are left alone. */
  upsertCategories: (rows: CategoryRow[]) => Promise<void>;
  /** Removes categories the supplier no longer lists (listed_at older than this). Returns how many. */
  deleteStale: (listedBefore: string) => Promise<number>;
  getCached: (family: Family, categoryId: string) => Promise<CachedOffers | null>;
  /** false = that category is not in the saved catalog. */
  saveOffers: (family: Family, categoryId: string, result: OffersResult, fetchedAt: string) => Promise<boolean>;
  now: () => Date;
  /** Structured events only. Never pass a supplier body, an ID or a cost. */
  log: (event: Record<string, unknown>) => void;
  refreshTimeoutMs: number;
  offersTimeoutMs: number;
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, 'content-type': 'application/json' } });

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { status: null, timedOut: true })), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

export type FailReason = 'refused' | 'timeout' | 'error';

/** 401/403 = the supplier won't talk to our key (a finished trial looks like this). */
export function failReason(error: unknown): FailReason {
  const e = error as { status?: unknown; timedOut?: unknown } | null;
  if (e?.timedOut === true) return 'timeout';
  return e?.status === 401 || e?.status === 403 ? 'refused' : 'error';
}

const FAMILIES: readonly Family[] = ['topups', 'giftcards'];
const CATEGORY_ID = /^[A-Za-z0-9_.-]{1,100}$/;

export function createHandler(deps: Deps) {
  const payloadOf = (c: CachedOffers) => ({
    offers: c.offers,
    fields: c.fields,
    hidden_offer_count: c.hidden_offer_count,
    offers_fetched_at: c.offers_fetched_at,
    blocked_reason: c.blocked_reason,
  });

  async function refresh(): Promise<Response> {
    const listedAt = deps.now().toISOString();
    let rows: CategoryRow[];
    try {
      const [blocklist, games] = await Promise.all([deps.loadBlocklist(), withTimeout(deps.listValidationGames(), deps.refreshTimeoutMs)]);
      const validationGames = cleanValidationGames(games);
      const seen = new Set<string>();
      rows = [];
      for (const family of FAMILIES) {
        const list = await withTimeout(deps.listCategories(family), deps.refreshTimeoutMs);
        for (const raw of list) {
          const row = (deps.normalizeCategory ?? normalizeCategory)(family, raw, { blocklist, validationGames, listedAt });
          if (row && !seen.has(`${family}/${row.category_id}`)) {
            seen.add(`${family}/${row.category_id}`);
            rows.push(row);
          }
        }
      }
    } catch (error) {
      const reason = failReason(error);
      deps.log({ event: 'refresh', outcome: 'unavailable', reason, supplier_status: (error as { status?: unknown })?.status ?? null });
      return json({ status: 'unavailable', reason });
    }

    // A supplier hiccup that returns a few categories must not wipe the saved catalog.
    const existing = await deps.countCatalog();
    if (rows.length === 0 || (existing >= 20 && rows.length < existing / 2)) {
      deps.log({ event: 'refresh', outcome: 'suspicious', found: rows.length, saved: existing });
      return json({ status: 'suspicious', found: rows.length, saved: existing });
    }

    await deps.upsertCategories(rows);
    const removed = await deps.deleteStale(listedAt);
    const topups = rows.filter((r) => r.family === 'topups').length;
    deps.log({ event: 'refresh', outcome: 'ok', topups, giftcards: rows.length - topups, removed });
    return json({ status: 'ok', categories: rows.length, topups, giftcards: rows.length - topups, removed, refreshed_at: listedAt });
  }

  /** Same shape as refresh(), scoped to one query: never deletes anything (a partial pull must not look like the whole catalog going stale). */
  async function search(body: { query?: unknown }): Promise<Response> {
    if (!deps.searchLive) return json({ error: 'bad_request' }, 400);
    const query = typeof body.query === 'string' ? body.query.trim() : '';
    if (query.length < 2 || query.length > 60) return json({ error: 'bad_request' }, 400);
    const listedAt = deps.now().toISOString();
    let rows: CategoryRow[];
    try {
      const [blocklist, games] = await Promise.all([deps.loadBlocklist(), withTimeout(deps.listValidationGames(), deps.offersTimeoutMs)]);
      const validationGames = cleanValidationGames(games);
      const seen = new Set<string>();
      rows = [];
      for (const family of FAMILIES) {
        const list = await withTimeout(deps.searchLive(family, query), deps.offersTimeoutMs);
        for (const raw of list) {
          const row = (deps.normalizeCategory ?? normalizeCategory)(family, raw, { blocklist, validationGames, listedAt });
          if (row && !seen.has(`${family}/${row.category_id}`)) {
            seen.add(`${family}/${row.category_id}`);
            rows.push(row);
          }
        }
      }
    } catch (error) {
      const reason = failReason(error);
      deps.log({ event: 'search', outcome: 'unavailable', reason, supplier_status: (error as { status?: unknown })?.status ?? null });
      return json({ status: 'unavailable', reason });
    }

    if (rows.length > 0) await deps.upsertCategories(rows);
    const topups = rows.filter((r) => r.family === 'topups').length;
    deps.log({ event: 'search', outcome: 'ok', topups, giftcards: rows.length - topups });
    return json({ status: 'ok', categories: rows.length, topups, giftcards: rows.length - topups });
  }

  async function loadOffers(body: { family?: unknown; category_id?: unknown }): Promise<Response> {
    const family = FAMILIES.find((f) => f === body.family);
    const categoryId = typeof body.category_id === 'string' && CATEGORY_ID.test(body.category_id) ? body.category_id : null;
    if (!family || !categoryId) return json({ error: 'bad_request' }, 400);

    const cached = await deps.getCached(family, categoryId);
    if (!cached) return json({ error: 'not_found' }, 404);
    if (cached.blocked_reason) return json({ status: 'blocked', reason: cached.blocked_reason });

    let result: OffersResult;
    try {
      const raw = await withTimeout(deps.fetchOffers(family, categoryId), deps.offersTimeoutMs);
      result = normalizeOffers(family, raw);
    } catch (error) {
      const reason = failReason(error);
      deps.log({ event: 'load_offers', outcome: 'unavailable', reason, supplier_status: (error as { status?: unknown })?.status ?? null });
      return json({ status: 'unavailable', reason, cached: cached.offers ? payloadOf(cached) : null });
    }

    const fetchedAt = deps.now().toISOString();
    if (!(await deps.saveOffers(family, categoryId, result, fetchedAt))) return json({ error: 'not_found' }, 404);
    deps.log({ event: 'load_offers', outcome: result.blocked_reason ? 'blocked' : 'ok', shown: result.offers.length, hidden: result.hidden_offer_count });
    if (result.blocked_reason) return json({ status: 'blocked', reason: result.blocked_reason });
    return json({
      status: 'ok',
      offers: result.offers,
      fields: result.fields,
      hidden_offer_count: result.hidden_offer_count,
      offers_fetched_at: fetchedAt,
      blocked_reason: null,
    });
  }

  return async function handle(req: Request): Promise<Response> {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
    if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

    const token = /^Bearer\s+(\S+)$/i.exec(req.headers.get('authorization') ?? '')?.[1];
    const userId = token ? await deps.getUserId(token).catch(() => null) : null;
    if (!userId) return json({ error: 'unauthorized' }, 401);
    if (!(await deps.isAdmin(userId).catch(() => false))) return json({ error: 'forbidden' }, 403);

    let body: { action?: unknown; family?: unknown; category_id?: unknown };
    try {
      body = await req.json();
    } catch {
      return json({ error: 'bad_request' }, 400);
    }

    try {
      if (body?.action === 'refresh_catalog') return await refresh();
      if (body?.action === 'load_offers') return await loadOffers(body);
      if (body?.action === 'search_catalog') return await search(body);
      return json({ error: 'bad_request' }, 400);
    } catch (error) {
      deps.log({ event: 'error', message: String((error as Error)?.message ?? '').slice(0, 80) });
      return json({ error: 'server_error' }, 500);
    }
  };
}
