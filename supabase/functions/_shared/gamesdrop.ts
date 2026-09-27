// GamesDrop, the third supplier. Pure code plus an HTTP client whose `fetch` is injected, so Node can test all of it.
//
// API (https://gamesdrop.io/en/docs/partner-api, checked against the live service 2026-09-22):
//   base   https://partner.gamesdrop.io
//   auth   Authorization: <shop token>   (a bare token, no "Bearer " prefix; the docs' JWT-bearer note is for their
//          dashboard, not this API. A wrong token answers 401 {error:{code:'INVALID_TOKEN'}}.)
//   GET  /api/v1/balance                          the key check ({balance, draftBalance, balanceProfile, currency, partnerId, ...})
//   POST /api/v1/offers/sync                      {limit, page, category?, search?, countryCode?} -> {count, rows:[...]}
//   POST /api/v1/offers/find-one                  {offerId, countryCode?} -> one offer's fresh detail
//   POST /api/v1/offers/check-game-data            {offerId, gameUserId, gameServerId?} -> {status: 'VALID'|'INVALID', gameUserLogin?}
// Three things the docs get wrong: the balance path is /api/v1/balance, not /api/v1/partner/balance (that 404s); the
// response fields are camelCase (draftBalance, balanceProfile, partnerId), not the snake_case the docs page shows; and
// check-game-data always answers HTTP 200 (VALID/INVALID is in the body), never a 4xx for "wrong ID" the way Shop2Topup does.
// This file never calls anything with "order" in its path: ordering is not built (see CLAUDE.md).
//
// SHAPE: unlike FazerCards/Shop2Topup, GamesDrop's catalog has no explicit category tree -- /offers/sync returns one row
// per PACK directly (offerId, price, requirement flags), tagged only with a productId/productName. One GamesDrop
// "category" here is one product's packs together. Often that IS one region already (Blood Strike, productId 77, and
// Blood Strike MENA, productId 78, are two SEPARATE products, so they fall out as two categories with no extra work), but
// nothing here tries to SPLIT a product by region when it isn't already split that way: no name-prefix heuristic is
// applied, so `region_label`/`note_region` are always null and a GamesDrop category is never region-locked. Inventing a
// heuristic would risk silently mis-splitting some other game's catalog with no way to notice; better to import it as one
// unlocked category (the pack names still say "MENA" etc. where the product itself does) than guess.
import { categoryBlockReason, type BuyerField, type CategoryRow, type Family, type RawCategory } from './catalog.ts';

export const GAMESDROP = 'gamesdrop';
export const GAMESDROP_BASE = 'https://partner.gamesdrop.io';

// ---------------------------------------------------------------- errors

/** Carries the HTTP status classifySupplierError already understands: 400 = "that player ID does not exist", anything
 * else = "couldn't check" (401/403 = our key, 5xx = their side or a malformed request of ours). */
export class GDError extends Error {
  status: number | null;
  code: string | null;
  constructor(message: string, status: number | null, code: string | null = null) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// ---------------------------------------------------------------- the client

export type GDConfig = { key: string; baseUrl?: string; timeoutMs?: number; fetchFn?: typeof fetch };
export type GDOffer = {
  offerId: number;
  offerGroupId: number;
  offerGroupName: string;
  productId: number;
  productName: string;
  price: number;
  currency?: string;
  inStock?: boolean;
  isRequiredGameUserId?: boolean;
  isRequiredGameServerId?: boolean;
};

export function createGamesDropClient(config: GDConfig) {
  const base = (config.baseUrl ?? GAMESDROP_BASE).replace(/\/$/, '');
  const doFetch = config.fetchFn ?? fetch;
  const timeoutMs = config.timeoutMs ?? 20_000;

  async function request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ http: number; json: any }> {
    if (!config.key) throw new GDError('gamesdrop key is not configured', 503, 'NO_KEY');
    // Never place or read orders from here.
    if (/order/i.test(path)) throw new GDError('orders are not available from this client', 500, 'BLOCKED');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await doFetch(`${base}${path}`, {
        method,
        headers: { Authorization: config.key, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const text = await res.text();
      let json: any;
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
      return { http: res.status, json };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    /** The key check. Throws GDError(401) for a wrong key. */
    async balance(): Promise<{ balance: number | null; currencyCode: string | null }> {
      const { http, json } = await request('GET', '/api/v1/balance');
      if (http === 200 && json && typeof json === 'object') {
        return { balance: typeof json.balance === 'number' ? json.balance : null, currencyCode: typeof json.currency?.code === 'string' ? json.currency.code : null };
      }
      throw new GDError('gamesdrop /balance failed', http, typeof json?.error?.code === 'string' ? json.error.code : null);
    },
    /** One page of the flat offer list. */
    async sync(params: { limit: number; page: number; category?: string; search?: string; countryCode?: string }): Promise<{ count: number; rows: GDOffer[] }> {
      const { http, json } = await request('POST', '/api/v1/offers/sync', params);
      if (http === 200 && json && Array.isArray(json.rows)) {
        return { count: typeof json.count === 'number' ? json.count : json.rows.length, rows: json.rows as GDOffer[] };
      }
      throw new GDError('gamesdrop /offers/sync failed', http, typeof json?.error?.code === 'string' ? json.error.code : null);
    },
    /**
     * Checks a player ID against ONE fixed offer. Unlike Shop2Topup there is no signal that distinguishes "this offer is
     * unavailable" from "that ID is wrong" (both answer INVALID), so there is no try-the-next-pack fallback here: only a
     * proven, hand-picked offerId should ever be used (see GAMESDROP_VALIDATED_OFFERS).
     */
    async checkGameData(input: { offerId: number; gameUserId: string; gameServerId?: string }): Promise<{ valid: true; player_name: string | null; region: string | null }> {
      const body: Record<string, unknown> = { offerId: input.offerId, gameUserId: input.gameUserId };
      if (input.gameServerId !== undefined && input.gameServerId !== '') body.gameServerId = input.gameServerId;
      const { http, json } = await request('POST', '/api/v1/offers/check-game-data', body);
      if (http === 200 && json?.status === 'VALID') {
        const name = typeof json.gameUserLogin === 'string' && json.gameUserLogin.trim() !== '' ? json.gameUserLogin : null;
        // No account-region signal from this endpoint (see CHECK_REPORTS_NO_REGION in shop2topup.ts for the same situation
        // on other games): a lock could never be satisfied, so this never reports one.
        return { valid: true, player_name: name, region: null };
      }
      if (http === 200 && json?.status === 'INVALID') throw new GDError('gamesdrop player check: invalid', 400, 'INVALID');
      throw new GDError('gamesdrop player check failed', http, typeof json?.error?.code === 'string' ? json.error.code : null);
    },
  };
}
export type GamesDropClient = ReturnType<typeof createGamesDropClient>;

/** Every row of every page, concurrency-limited. `limit` is the page size GamesDrop is asked for (max seen working: 1000). */
export async function syncAll(
  client: Pick<GamesDropClient, 'sync'>,
  params: { category?: string; search?: string; countryCode?: string } = {},
  pageSize = 1000,
  concurrency = 6
): Promise<GDOffer[]> {
  const first = await client.sync({ ...params, limit: pageSize, page: 1 });
  const pages = Math.max(1, Math.ceil(first.count / pageSize));
  const rest = await Promise.all(
    Array.from({ length: Math.max(0, pages - 1) }, (_, i) => i + 2).reduce<Promise<GDOffer[]>[]>((batches, page, i) => {
      const batch = Math.floor(i / concurrency);
      batches[batch] = (batches[batch] ?? Promise.resolve([])).then(async (acc) => {
        const r = await client.sync({ ...params, limit: pageSize, page });
        return [...acc, ...r.rows];
      });
      return batches;
    }, [])
  );
  return [first.rows, ...rest].flat();
}

// ---------------------------------------------------------------- what can be ID-checked

/**
 * Game name (lowercase) -> a single PROVEN offerId to check IDs against. Set only after a real player ID has been seen
 * to validate correctly (see CLAUDE.md: Blood Strike proven 2026-09-22 with 568840231399 against offerId 2733, the
 * Global "bloodstrike 51" pack; Delta Force proven 2026-09-23 with 63314139102725674019 -> "Beckyx77" against offerId
 * 2578, "deltaforce 320"). Every other game falls back to the customer's tick.
 */
export const GAMESDROP_VALIDATED_OFFERS: Readonly<Record<string, string>> = { 'blood strike': '2733', 'delta force': '2578' };

export function gamesdropValidationOffer(productName: string): string | null {
  return GAMESDROP_VALIDATED_OFFERS[productName.trim().toLowerCase()] ?? null;
}

// ---------------------------------------------------------------- mapping into the app's catalog shapes

export type GamesDropRawCategory = RawCategory & { game: string; requiresServerId: boolean };

/** One row per distinct product, for one family (topups = needs a player id; giftcards = a plain code/key). */
export function toRawCategories(offers: readonly GDOffer[], family: Family): GamesDropRawCategory[] {
  const wanted = family === 'topups' ? (o: GDOffer) => o.isRequiredGameUserId === true : (o: GDOffer) => o.isRequiredGameUserId !== true;
  const byProduct = new Map<number, { name: string; requiresServerId: boolean }>();
  for (const o of offers) {
    if (!wanted(o)) continue;
    if (typeof o.productId !== 'number' || typeof o.productName !== 'string' || o.productName.trim() === '') continue;
    const entry = byProduct.get(o.productId) ?? { name: o.productName.trim(), requiresServerId: false };
    if (o.isRequiredGameServerId === true) entry.requiresServerId = true;
    byProduct.set(o.productId, entry);
  }
  return [...byProduct.entries()].map(([productId, v]) => ({
    category_id: String(productId),
    name: v.name,
    game: v.name,
    requiresServerId: v.requiresServerId,
  }));
}

/** The same job as normalizeCategory (catalog.ts) / normalizeShop2TopupCategory, for a GamesDrop product. */
export function normalizeGamesDropCategory(
  family: Family,
  raw: RawCategory,
  ctx: { blocklist: Record<string, string>; listedAt: string }
): CategoryRow | null {
  const r = raw as Partial<GamesDropRawCategory>;
  if (typeof r.category_id !== 'string' || r.category_id === '' || typeof r.name !== 'string' || r.name.trim() === '' || typeof r.game !== 'string') return null;
  const offerId = family === 'topups' ? gamesdropValidationOffer(r.game) : null;
  const fields: BuyerField[] = offerId
    ? [{ key: 'gameUserId', label: 'Player ID', type: 'text' }, ...(r.requiresServerId ? [{ key: 'gameServerId', label: 'Server ID', type: 'text' } as BuyerField] : [])]
    : [];
  return {
    supplier: GAMESDROP as CategoryRow['supplier'],
    family,
    category_id: r.category_id,
    name: r.name.trim(),
    game_name: r.game.trim(),
    // No reliable per-product region signal (see file header); the region a customer needs shows up in each pack's own
    // name instead ("bloodstrikeme 51"), never guessed into a lock here.
    region_label: null,
    note_region: null,
    note: null,
    validation_category_id: offerId,
    validation_fields: offerId ? fields : null,
    blocked_reason: categoryBlockReason(family, r.category_id, ctx.blocklist),
    listed_at: ctx.listedAt,
  };
}

/**
 * One product's packs and form in the raw shape normalizeOffers (catalog.ts) already understands. The BUYER-facing keys are
 * `player_id`/`server_id` -- the same convention every other supplier uses -- deliberately NOT `gameUserId`/`gameServerId`
 * (GamesDrop's own API param names, used only in normalizeGamesDropCategory's `validation_fields` and in the real
 * checkGameData call): `catalog_fields_are_safe`/`fieldsAreSafe` only accepts lowercase-and-underscore keys, so a camelCase
 * buyer field silently blocked every GamesDrop topup category as if it asked for a password (found live, 2026-09-23,
 * "Delta Force"). The purchase/check key MISMATCH this creates is not a bug: `mapValidationFields` (importPlan.ts) already
 * diffs the two and builds `validation_field_map` automatically for any game in GAMESDROP_VALIDATED_OFFERS, the same way it
 * already does for Mobile Legends' server_id-buys/zone_id-checks.
 */
export function toRawOffers(family: Family, offers: readonly GDOffer[], productId: string): { offers: unknown[]; fields: unknown[] } {
  const wanted = family === 'topups' ? (o: GDOffer) => o.isRequiredGameUserId === true : (o: GDOffer) => o.isRequiredGameUserId !== true;
  const mine = offers.filter((o) => String(o.productId) === productId && wanted(o));
  const needsServer = mine.some((o) => o.isRequiredGameServerId === true);
  const fields = family === 'topups' ? [{ key: 'player_id', label: 'Player ID', type: 'text' }, ...(needsServer ? [{ key: 'server_id', label: 'Server ID', type: 'text' }] : [])] : [];
  return {
    offers: mine
      .filter((o) => o.inStock !== false)
      .map((o) => ({
        offer_id: String(o.offerId),
        card_id: String(o.offerId),
        name: o.offerGroupName,
        price_usd: typeof o.price === 'number' ? String(o.price) : o.price,
      })),
    fields,
  };
}
