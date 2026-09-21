// Pure rules for turning the supplier's catalog into cache rows. No imports, so Node can test them
// and Deno can run them. The database guards are the real enforcement; these decide what the admin is
// shown, and a test keeps them in step with the database over the whole scanned catalog.

export type Family = 'topups' | 'giftcards';
export const SUPPLIER = 'fazercards';

export type RawCategory = { category_id?: unknown; name?: unknown; note?: unknown };
export type RawField = { key?: unknown; label?: unknown; type?: unknown; options?: unknown };
export type RawValidationGame = { category_id?: unknown; name?: unknown; fields?: unknown };
export type RawOffer = { offer_id?: unknown; card_id?: unknown; name?: unknown; price_usd?: unknown; stock?: unknown };

export type BuyerField = { key: string; label: string; type: string; options?: Record<string, unknown>[] };
export type CachedOffer = { ref: string; name: string; cost_usd: string; stock?: number };
export type ValidationGame = { id: string; name: string; fields: BuyerField[] };

export type CategoryRow = {
  supplier: string;
  family: Family;
  category_id: string;
  name: string;
  game_name: string;
  region_label: string | null;
  note_region: string | null;
  note: string | null;
  validation_category_id: string | null;
  validation_fields: BuyerField[] | null;
  blocked_reason: string | null;
  listed_at: string;
};

// ---------------------------------------------------------------- names and regions

const TRAILING_PAREN = /\s*\(([^()]*)\)\s*$/;

/** "Free Fire (MENA)" -> game "Free Fire", parenthetical "MENA". */
export function splitName(name: string): { gameName: string; paren: string | null } {
  const trimmed = name.trim();
  const m = TRAILING_PAREN.exec(trimmed);
  if (!m) return { gameName: trimmed, paren: null };
  const gameName = trimmed.slice(0, m.index).trim();
  const paren = m[1].trim();
  return gameName === '' ? { gameName: trimmed, paren: null } : { gameName, paren: paren === '' ? null : paren };
}

/** The supplier's own "Region: X" line, as written ("Asia." -> "Asia"). Null when there isn't one. */
export function noteRegion(note: unknown): string | null {
  if (typeof note !== 'string') return null;
  const m = /^Region:[ \t]*(.+)$/m.exec(note);
  if (!m) return null;
  const value = m[1].trim().replace(/\.+$/, '').trim();
  return value === '' ? null : value.slice(0, 60);
}

// ---------------------------------------------------------------- what must never be sold

/** Mirrors public.is_first_purchase_only(): offers that work once per account. */
export const FIRST_PURCHASE = /(first|1st)[ _-]?(time[ _-]?)?(purchase|recharge|top[ -]?up|buy|order|deposit)/i;
export const isFirstPurchaseOnly = (offerName: string) => FIRST_PURCHASE.test(offerName);

const LOGIN_CATEGORY = /(^|_)login($|_)/i;

/** Mirrors public.supplier_category_block_reason(). `blocklist` maps "family/category_id" to a reason. */
export function categoryBlockReason(family: Family, categoryId: string, blocklist: Record<string, string>): string | null {
  const listed = blocklist[`${family}/${categoryId}`];
  if (typeof listed === 'string') return listed;
  return LOGIN_CATEGORY.test(categoryId) ? 'login-based category (asks for the buyer\'s game account)' : null;
}

const SECRET_KEY = /(^|_)(pass|password|passcode|passwd|pwd|secret|otp|2fa|token|credential|credentials|pin|cvv)($|_)/i;
const SECRET_LABEL = /\b(pass|password|passcode|passwd|pwd|secret|otp|2fa|token|credentials?|pin|cvv)\b/i;

/** Mirrors public.catalog_fields_are_safe(): plain text/dropdown inputs, no game password. */
export function fieldsAreSafe(fields: unknown): boolean {
  if (!Array.isArray(fields)) return false;
  for (const f of fields) {
    if (f === null || typeof f !== 'object' || Array.isArray(f)) return false;
    const { key, label, type } = f as RawField;
    const k = typeof key === 'string' ? key : '';
    const l = typeof label === 'string' ? label : '';
    if (!/^[a-z0-9_]{1,40}$/.test(k)) return false;
    if (type !== undefined && type !== null && type !== 'text' && type !== 'select') return false;
    if (SECRET_KEY.test(k) || SECRET_LABEL.test(l)) return false;
  }
  return true;
}

// ---------------------------------------------------------------- ID validation

/** Only what the form needs; anything odd is dropped rather than passed on. */
export function cleanFields(fields: unknown): BuyerField[] {
  if (!Array.isArray(fields)) return [];
  const out: BuyerField[] = [];
  for (const f of fields) {
    if (f === null || typeof f !== 'object') continue;
    const { key, label, type, options } = f as RawField;
    if (typeof key !== 'string') continue;
    const field: BuyerField = { key, label: typeof label === 'string' && label !== '' ? label : key, type: type === 'select' ? 'select' : 'text' };
    if (field.type === 'select' && Array.isArray(options)) {
      field.options = options
        .filter((o): o is Record<string, unknown> => o !== null && typeof o === 'object' && typeof (o as { value?: unknown }).value === 'string')
        .map((o) => ({ label: typeof o.label === 'string' ? o.label : (o.value as string), value: o.value as string }));
    }
    out.push(field);
  }
  return out;
}

export function cleanValidationGames(raw: unknown): ValidationGame[] {
  if (!Array.isArray(raw)) return [];
  const out: ValidationGame[] = [];
  for (const g of raw as RawValidationGame[]) {
    if (typeof g?.category_id !== 'string' || typeof g?.name !== 'string') continue;
    out.push({ id: g.category_id, name: g.name, fields: cleanFields(g.fields) });
  }
  return out;
}

/**
 * Which supplier ID check (if any) fits a purchase category. Deliberately strict, because a wrong match
 * would validate the wrong game's IDs:
 *  - the category is the validated game itself, or
 *  - its id continues the game's id AND its display name is that game ("Mobile Legends (Brazil)" yes,
 *    "Mobile Legends: Adventure" no, a different game), AND
 *  - it states its region ("Region: ..."), so an unlabelled variant is never guessed at.
 */
export function matchValidationGame(
  categoryId: string,
  gameName: string,
  statedRegion: string | null,
  games: readonly ValidationGame[]
): ValidationGame | null {
  if (statedRegion === null) return null;
  let best: ValidationGame | null = null;
  for (const g of games) {
    const exact = categoryId === g.id;
    const family = categoryId.startsWith(`${g.id}_`) && gameName.toLowerCase() === g.name.toLowerCase();
    if ((exact || family) && (best === null || g.id.length > best.id.length)) best = g;
  }
  return best;
}

// ---------------------------------------------------------------- rows

export function normalizeCategory(
  family: Family,
  raw: RawCategory,
  ctx: { blocklist: Record<string, string>; validationGames: readonly ValidationGame[]; listedAt: string }
): CategoryRow | null {
  if (typeof raw.category_id !== 'string' || raw.category_id === '' || typeof raw.name !== 'string' || raw.name.trim() === '') return null;
  const note = typeof raw.note === 'string' && raw.note.trim() !== '' ? raw.note.slice(0, 1000) : null;
  const { gameName, paren } = splitName(raw.name);
  const stated = noteRegion(note);
  const game = family === 'topups' ? matchValidationGame(raw.category_id, gameName, stated, ctx.validationGames) : null;
  return {
    supplier: SUPPLIER,
    family,
    category_id: raw.category_id,
    name: raw.name.trim(),
    game_name: gameName,
    region_label: paren ?? stated,
    note_region: stated,
    note,
    validation_category_id: game ? game.id : null,
    validation_fields: game ? game.fields : null,
    blocked_reason: categoryBlockReason(family, raw.category_id, ctx.blocklist),
    listed_at: ctx.listedAt,
  };
}

export type OffersResult = {
  offers: CachedOffer[];
  fields: BuyerField[];
  hidden_offer_count: number;
  /** Set when the supplier's own buyer form asks for something we never collect. */
  blocked_reason: string | null;
};

const MONEY = /^\d{1,9}(\.\d{1,6})?$/;

/** What the admin may pick from one category. Anything unsellable is dropped and counted, never shown. */
export function normalizeOffers(family: Family, raw: { offers?: unknown; fields?: unknown }): OffersResult {
  const fields = family === 'topups' ? cleanFields(raw.fields) : [];
  const list = Array.isArray(raw.offers) ? (raw.offers as RawOffer[]) : [];

  if (family === 'topups' && !fieldsAreSafe(Array.isArray(raw.fields) ? raw.fields : [])) {
    return { offers: [], fields: [], hidden_offer_count: list.length, blocked_reason: 'asks for the buyer\'s game password or other secret' };
  }

  const offers: CachedOffer[] = [];
  let hidden = 0;
  for (const o of list) {
    const ref = family === 'topups' ? o?.offer_id : o?.card_id;
    const name = typeof o?.name === 'string' ? o.name.trim() : '';
    const cost = typeof o?.price_usd === 'number' ? String(o.price_usd) : typeof o?.price_usd === 'string' ? o.price_usd.trim() : '';
    if (typeof ref !== 'string' || ref === '' || name === '' || !MONEY.test(cost) || isFirstPurchaseOnly(name)) {
      hidden++;
      continue;
    }
    const offer: CachedOffer = { ref, name, cost_usd: cost };
    if (typeof o.stock === 'number' && Number.isFinite(o.stock)) offer.stock = o.stock;
    offers.push(offer);
  }
  return { offers, fields, hidden_offer_count: hidden, blocked_reason: null };
}
