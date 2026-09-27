// Shop2Topup, the second supplier. Pure code plus an HTTP client whose `fetch` is injected, so Node can test all of it.
//
// API (https://shop2topup.com/en/reseller-api, checked against the live service 2026-09-21):
//   base   https://shop2topup.com/api/endpoints/v1
//   auth   Authorization: Bearer <keyId>.<secret>
//   GET  /account                                   the key check ({success, account:{email, wallet}})
//   GET  /catalog/big-categories                    games and brands            {id, name}
//   GET  /catalog/categories?bigCategoryId=         regional / server variants  {id, name, region_ids, country_ids, requirements}
//   GET  /catalog/subcategories?categoryId=         the packs                   {id, name, price (USD), product_type, ...}
//   GET  /catalog/category/:id/requirements         the buyer form              [{field_name, data_type, select_options}] (404 NO_REQUIREMENTS_FOUND = none)
//   POST /player/validate                           {sub_category_id, player_id, zone_id?} -> {data:{player_id, player_name, region?}}
// Two things the docs get wrong: the zone field is `zone_id` (the docs say `server`), and validation is per PACK, not per category.
// This file never calls /orders: ordering is not built (see CLAUDE.md).
import { categoryBlockReason, fieldsAreSafe, type BuyerField, type CategoryRow, type Family, type RawCategory } from './catalog.ts';

export const SHOP2TOPUP = 'shop2topup';
export const SHOP2TOPUP_BASE = 'https://shop2topup.com/api/endpoints/v1';

// ---------------------------------------------------------------- errors

/**
 * Carries the HTTP status the rest of the code already understands (classifySupplierError, failReason):
 * 401/403 = "our key is refused", 400 = "that player ID does not exist", anything else = "couldn't check".
 */
export class S2Error extends Error {
  status: number | null;
  code: string | null;
  retryAfter: number | null;
  constructor(message: string, status: number | null, code: string | null, retryAfter: number | null = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

/**
 * The ONLY answer that means "this player ID is wrong" is PLAYER_NOT_FOUND. Shop2Topup also answers HTTP 400 for a missing
 * field, a bad request or an unsupported game: telling a customer their ID is wrong for those would be a lie, so they all
 * become 503 ("couldn't check"), which keeps Continue off without blaming the customer.
 */
export function validationStatusFor(httpStatus: number, code: string | null): number {
  if (code === 'PLAYER_NOT_FOUND') return 400;
  if (httpStatus === 401 || httpStatus === 403) return httpStatus;
  return 503;
}

// ---------------------------------------------------------------- the client

export type S2Config = { key: string; baseUrl?: string; timeoutMs?: number; fetchFn?: typeof fetch };
export type S2Category = {
  id: number;
  name: string;
  description?: string | null;
  big_category_id?: number;
  region_ids?: { id: number; name: string }[];
  country_ids?: { id: number; code?: string; name: string }[];
  /** "player_id", "player_id, zone_id", or {} (an empty object) for a voucher category. */
  requirements?: unknown;
};
export type S2Sub = { id: number; name: string; price: number | string; product_type?: string; returns_voucher?: boolean };
export type S2Requirement = { field_name: string; data_type?: string; placeholder?: string; select_options?: unknown };

export function createShop2TopupClient(config: S2Config) {
  const base = (config.baseUrl ?? SHOP2TOPUP_BASE).replace(/\/$/, '');
  const doFetch = config.fetchFn ?? fetch;
  const timeoutMs = config.timeoutMs ?? 20_000;

  async function request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ http: number; json: any }> {
    if (!config.key) throw new S2Error('shop2topup key is not configured', 503, 'NO_KEY');
    // Never place or read orders from here.
    if (/^\/orders(\/|$|\?)/.test(path)) throw new S2Error('orders are not available from this client', 500, 'BLOCKED');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await doFetch(`${base}${path}`, {
        method,
        headers: { Authorization: `Bearer ${config.key}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
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

  const errorOf = (http: number, json: any) => {
    const code = typeof json?.error?.code === 'string' ? json.error.code : null;
    const retry = typeof json?.error?.retry_after === 'number' ? json.error.retry_after : null;
    return { code, retry };
  };

  async function getData(path: string): Promise<any> {
    const { http, json } = await request('GET', path);
    if (http === 200 && json?.success === true) return json.data;
    const { code, retry } = errorOf(http, json);
    // The message never carries a body, the key, or anything the supplier said.
    throw new S2Error(`shop2topup ${path.split('?')[0]} failed`, http === 429 ? 429 : http, code, retry);
  }

  return {
    /** The key check. Throws S2Error(401) for a wrong key. */
    async account(): Promise<{ email: string | null; wallet: string | null }> {
      const { http, json } = await request('GET', '/account');
      if (http === 200 && json?.success === true) {
        return { email: typeof json.account?.email === 'string' ? json.account.email : null, wallet: json.account?.wallet != null ? String(json.account.wallet) : null };
      }
      const { code, retry } = errorOf(http, json);
      throw new S2Error('shop2topup /account failed', http, code, retry);
    },
    async bigCategories(): Promise<{ id: number; name: string }[]> {
      const data = await getData('/catalog/big-categories');
      return Array.isArray(data) ? data : [];
    },
    async categories(bigCategoryId: number): Promise<S2Category[]> {
      const data = await getData(`/catalog/categories?bigCategoryId=${encodeURIComponent(String(bigCategoryId))}`);
      return Array.isArray(data) ? data : [];
    },
    async subcategories(categoryId: number | string): Promise<S2Sub[]> {
      const data = await getData(`/catalog/subcategories?categoryId=${encodeURIComponent(String(categoryId))}`);
      return Array.isArray(data) ? data : [];
    },
    /** [] when the category asks for nothing (a voucher category answers 404 NO_REQUIREMENTS_FOUND). */
    async requirements(categoryId: number | string): Promise<S2Requirement[]> {
      const { http, json } = await request('GET', `/catalog/category/${encodeURIComponent(String(categoryId))}/requirements`);
      if (http === 200 && json?.success === true) return Array.isArray(json.data) ? json.data : [];
      const { code, retry } = errorOf(http, json);
      if (http === 404 && code === 'NO_REQUIREMENTS_FOUND') return [];
      throw new S2Error('shop2topup requirements failed', http, code, retry);
    },
    /**
     * Checks a player ID for one PACK. Returns the shape parseSupplierResult understands. Throws S2Error with the status
     * from validationStatusFor: only PLAYER_NOT_FOUND is 400 ("invalid").
     */
    async validate(input: { subCategoryId: number; playerId: string; zoneId?: string }): Promise<{ valid: true; player_name: string | null; region: string | null }> {
      const body: Record<string, unknown> = { sub_category_id: input.subCategoryId, player_id: input.playerId };
      if (input.zoneId !== undefined && input.zoneId !== '') body.zone_id = input.zoneId;
      const { http, json } = await request('POST', '/player/validate', body);
      if (http === 200 && json?.success === true && json.data && typeof json.data === 'object') {
        const name = typeof json.data.player_name === 'string' && json.data.player_name.trim() !== '' ? json.data.player_name : null;
        const region = typeof json.data.region === 'string' && json.data.region.trim() !== '' ? json.data.region : null;
        return { valid: true, player_name: name, region };
      }
      // REGION_MISMATCH is not a problem with the ID: the account WAS found, and its region can't receive this category. The reply
      // carries that region, so it is returned like any found account and OUR region lock decides ("not for your account's region"),
      // instead of "couldn't check" forever (Retry could never help).
      if (http === 400 && json?.error?.code === 'REGION_MISMATCH' && typeof json.error.player_region === 'string' && json.error.player_region.trim() !== '') {
        const name = typeof json.error.player_name === 'string' && json.error.player_name.trim() !== '' ? json.error.player_name : null;
        return { valid: true, player_name: name, region: json.error.player_region };
      }
      const { code, retry } = errorOf(http, json);
      throw new S2Error('shop2topup player check failed', validationStatusFor(http, code), code, retry);
    },
  };
}
export type Shop2TopupClient = ReturnType<typeof createShop2TopupClient>;

// ---------------------------------------------------------------- what can be ID-checked

/**
 * Games whose ID check was PROVEN against the live service with real accounts (see CLAUDE.md, 2026-09-21). Only these import as
 * "the supplier checks the ID"; every other game falls back to the customer's tick, exactly like Blood Strike. Add a game here
 * only after seeing a real successful check for it.
 */
export const VALIDATED_GAMES: readonly string[] = ['Free Fire', 'PUBG Mobile', 'Mobile Legends: Bang Bang', 'Blood Strike', 'Delta Force Mobile'];

/**
 * Games whose ID check answers with the player's name but NO account region (seen live: PUBG Mobile, Blood Strike). A region
 * lock needs the check to report the account's region, and "unknown region" is refused, so for these a region name stays a LABEL
 * (the chip customers see) and is never turned into a lock: the pack would otherwise be impossible to buy.
 */
export const CHECK_REPORTS_NO_REGION: readonly string[] = ['PUBG Mobile', 'Blood Strike'];
const reportsNoRegion = (gameName: string) => CHECK_REPORTS_NO_REGION.some((g) => g.toLowerCase() === gameName.toLowerCase());

/**
 * Which categories' packs an ID check may use, in order. A check is asked of a PACK, and a category can be out of stock (Blood
 * Strike MENA: every pack "temporarily unavailable") while the game is fine. For a game whose check does not depend on the region
 * (CHECK_REPORTS_NO_REGION) every category of the game checks the same IDs, so the category's own packs come first and its sibling
 * categories' packs follow; for any other game only the category's own packs are used (a Free Fire region check must stay in its region).
 */
export function categoriesForCheck(rows: readonly { category_id: string; game_name: string }[], own: string): string[] {
  const mine = rows.find((r) => r.category_id === own);
  if (!mine || !reportsNoRegion(mine.game_name)) return [own];
  return [own, ...rows.filter((r) => r.category_id !== own && r.game_name.toLowerCase() === mine.game_name.toLowerCase()).map((r) => r.category_id)];
}

/** Variants of a validated game that are not the plain game (kept out, as with FazerCards' Exclusive / Special). */
const VARIANT = /exclusive|special|promo/i;

export function isValidatedCategory(gameName: string, categoryName: string): boolean {
  return VALIDATED_GAMES.some((g) => g.toLowerCase() === gameName.toLowerCase()) && !VARIANT.test(categoryName);
}

// ---------------------------------------------------------------- mapping into the app's catalog shapes

const FIELD_LABELS: Record<string, string> = { player_id: 'Player ID', zone_id: 'Zone ID', charname: 'Character name' };
const titleCase = (key: string) => key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

/** "player_id, zone_id" (the categories list) -> buyer fields. Anything not a plain key is dropped. */
export function fieldsFromRequirementString(text: unknown): BuyerField[] {
  if (typeof text !== 'string') return [];
  return text
    .split(/[,\s]+/)
    .filter((k) => /^[a-z0-9_]{1,40}$/.test(k))
    .map((k) => ({ key: k, label: FIELD_LABELS[k] ?? titleCase(k), type: 'text' }));
}

/** The requirements endpoint -> buyer fields (a single_select becomes a dropdown with its options). */
export function fieldsFromRequirements(list: readonly S2Requirement[]): BuyerField[] {
  const out: BuyerField[] = [];
  for (const r of list) {
    if (typeof r?.field_name !== 'string' || !/^[a-z0-9_]{1,40}$/.test(r.field_name)) continue;
    const field: BuyerField = { key: r.field_name, label: FIELD_LABELS[r.field_name] ?? titleCase(r.field_name), type: 'text' };
    if (r.data_type === 'single_select' && Array.isArray(r.select_options)) {
      field.type = 'select';
      field.options = (r.select_options as unknown[]).filter((o): o is string => typeof o === 'string' && o !== '').map((o) => ({ label: o, value: o }));
    }
    out.push(field);
  }
  return out;
}

/** A category that asks the buyer for something is a top-up; one that asks for nothing is a voucher (gift card / code). */
export const familyOf = (cat: S2Category): Family => (typeof cat.requirements === 'string' && cat.requirements.trim() !== '' ? 'topups' : 'giftcards');

/** The real region a category serves: a country code ("BR"), else a named region ("MENA"), else null. */
export function regionLabelOf(cat: S2Category): string | null {
  const country = (cat.country_ids ?? []).find((c) => typeof c?.code === 'string' && c.code !== '');
  if (country?.code) return country.code.toUpperCase();
  const region = (cat.region_ids ?? []).find((r) => typeof r?.name === 'string' && r.name !== '');
  return region?.name.trim() ?? null;
}

/** What tells two variants of one game apart when there is no region: "Direct Topup Exclusive" -> "Exclusive". */
export function variantLabelOf(cat: S2Category): string | null {
  const stripped = String(cat.name ?? '').replace(/\b(direct\s+topup|direct|topup|top-up)\b/gi, ' ').replace(/\s+/g, ' ').trim();
  return stripped === '' ? null : stripped;
}

export type Shop2TopupRawCategory = RawCategory & {
  game: string;
  region_label: string | null;
  variant_label: string | null;
  requirements: string | null;
  s2_family: Family;
};

/** Every category of every game as raw rows (one per Shop2Topup category), for one family. */
export function toRawCategories(games: readonly { id: number; name: string; categories: readonly S2Category[] }[], family: Family): Shop2TopupRawCategory[] {
  const out: Shop2TopupRawCategory[] = [];
  for (const g of games) {
    for (const c of g.categories) {
      if (familyOf(c) !== family) continue;
      const region = regionLabelOf(c);
      const variant = region ? null : variantLabelOf(c);
      out.push({
        category_id: String(c.id),
        name: region ? `${g.name} (${region})` : variant && variant.toLowerCase() !== g.name.toLowerCase() ? `${g.name} (${variant})` : g.name,
        note: region ? `Region: ${region}` : typeof c.description === 'string' && c.description.trim() !== '' ? c.description : undefined,
        game: g.name,
        region_label: region,
        variant_label: variant,
        requirements: typeof c.requirements === 'string' ? c.requirements : null,
        s2_family: family,
      });
    }
  }
  return out;
}

/** The same job as normalizeCategory (catalog.ts) for FazerCards, for a Shop2Topup category. Null when the row is unusable. */
export function normalizeShop2TopupCategory(
  family: Family,
  raw: RawCategory,
  ctx: { blocklist: Record<string, string>; listedAt: string }
): CategoryRow | null {
  const r = raw as Partial<Shop2TopupRawCategory>;
  if (typeof r.category_id !== 'string' || r.category_id === '' || typeof r.name !== 'string' || r.name.trim() === '' || typeof r.game !== 'string') return null;
  const fields = family === 'topups' ? fieldsFromRequirementString(r.requirements) : [];
  const checked = family === 'topups' && fields.length > 0 && isValidatedCategory(r.game, r.name);
  const secret = family === 'topups' && fields.length > 0 && !fieldsAreSafe(fields) ? "asks for the buyer's game password or other secret" : null;
  const note = typeof r.note === 'string' && r.note.trim() !== '' ? r.note.slice(0, 1000) : null;
  return {
    supplier: SHOP2TOPUP as CategoryRow['supplier'],
    family,
    category_id: r.category_id,
    name: r.name.trim(),
    game_name: r.game.trim(),
    region_label: r.region_label ?? r.variant_label ?? null,
    // Only a REAL region locks packs; a variant name ("Exclusive") is a label, not a region.
    note_region: checked && reportsNoRegion(r.game) ? null : (r.region_label ?? null),
    note,
    // The validation "game" is the category itself: at check time a working pack of THIS category is used.
    validation_category_id: checked ? r.category_id : null,
    validation_fields: checked ? fields : null,
    blocked_reason: secret ?? categoryBlockReason(family, r.category_id, ctx.blocklist),
    listed_at: ctx.listedAt,
  };
}

/** One category's packs and form in the raw shape normalizeOffers (catalog.ts) already understands. */
export function toRawOffers(family: Family, subs: readonly S2Sub[], fields: readonly BuyerField[]): { offers: unknown[]; fields: unknown[] } {
  return {
    offers: subs.map((s) => ({ offer_id: String(s.id), card_id: String(s.id), name: s.name, price_usd: typeof s.price === 'number' ? String(s.price) : s.price })),
    fields: family === 'topups' ? [...fields] : [],
  };
}

/**
 * The pack to check an ID against. Validation is per pack and a pack can be "temporarily unavailable" while the game is fine
 * (PUBG's first pack was, its others were not), so packs are tried in order, at most `max`, until one is not unavailable.
 */
export async function validateWithAnyPack(
  client: Pick<Shop2TopupClient, 'validate'>,
  packIds: readonly number[],
  input: { playerId: string; zoneId?: string },
  max = 3
): Promise<{ valid: true; player_name: string | null; region: string | null }> {
  let last: unknown = new S2Error('no pack to check against', 503, 'NO_PACK');
  for (const id of packIds.slice(0, max)) {
    try {
      return await client.validate({ subCategoryId: id, ...input });
    } catch (error) {
      last = error;
      const code = (error as S2Error)?.code;
      // Only "this pack is unavailable" moves on to the next pack. A wrong ID, a refused key, a busy game: stop.
      if (code !== 'PRODUCT_UNAVAILABLE') break;
    }
  }
  throw last;
}
