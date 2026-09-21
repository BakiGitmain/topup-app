/**
 * Supplier import decisions: grouping the saved catalog by game, what a region imports as (ID check,
 * region lock, account-region codes), the payload for admin_import_product, and the parsing of what
 * the supplier-catalog function returns. Pure functions with no imports.
 *
 * The database enforces every rule that matters (blocked categories, first-purchase offers, the region
 * lock needing codes, the supplier offer name). These decide what the admin is offered and what is sent.
 */

export type CatalogFamily = 'topups' | 'giftcards';

/** The suppliers the shop can import from. A region's category and packs always belong to exactly one of them. */
export type SupplierName = 'fazercards' | 'shop2topup';
export const SUPPLIERS: readonly SupplierName[] = ['fazercards', 'shop2topup'];
export const SUPPLIER_LABEL: Readonly<Record<SupplierName, string>> = { fazercards: 'FazerCards', shop2topup: 'Shop2Topup' };

export type BuyerField = { key: string; label: string; type: string; options?: Record<string, unknown>[] };
export type CatalogOffer = { ref: string; name: string; cost_usd: string; stock?: number };

/** A saved supplier category, as admins read it from public.supplier_catalog. */
export type CatalogRow = {
  /** Which supplier this category belongs to. Missing means FazerCards (rows read before suppliers were named). */
  supplier?: SupplierName;
  family: CatalogFamily;
  category_id: string;
  name: string;
  game_name: string;
  region_label: string | null;
  note_region: string | null;
  validation_category_id: string | null;
  validation_fields: BuyerField[] | null;
  /** Null until this category's packs have been fetched at least once. */
  offers: CatalogOffer[] | null;
  fields: BuyerField[] | null;
  hidden_offer_count: number;
  offers_fetched_at: string | null;
};

// ---------------------------------------------------------------- search results

export type GameGroup = { key: string; family: CatalogFamily; name: string; regions: CatalogRow[] };

/** One entry per game (and family): "Free Fire" with its 13 regions underneath. */
export function groupByGame(rows: readonly CatalogRow[]): GameGroup[] {
  const groups = new Map<string, GameGroup>();
  for (const row of rows) {
    const key = `${row.family}|${row.game_name.trim().toLowerCase()}`;
    let group = groups.get(key);
    if (!group) groups.set(key, (group = { key, family: row.family, name: row.game_name, regions: [] }));
    group.regions.push(row);
  }
  const byLabel = (a: CatalogRow, b: CatalogRow) => (a.region_label ?? '').localeCompare(b.region_label ?? '') || a.name.localeCompare(b.name);
  return [...groups.values()]
    .map((g) => ({ ...g, regions: [...g.regions].sort(byLabel) }))
    .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.family.localeCompare(b.family));
}

const usd = (value: string) => Number(value);

/** Cheapest and dearest pack in USD, or null with no packs. */
export function costRange(offers: readonly CatalogOffer[] | null): { min: number; max: number } | null {
  const costs = (offers ?? []).map((o) => usd(o.cost_usd)).filter((n) => Number.isFinite(n));
  return costs.length === 0 ? null : { min: Math.min(...costs), max: Math.max(...costs) };
}

/** "$0.95", "$0.95 - $18.91". Costs have up to four decimals in the data; the screen shows two unless it matters. */
export function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return '-';
  const text = value >= 0.995 || value === 0 ? value.toFixed(2) : value.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
  return `$${text}`;
}

export function formatUsdRange(range: { min: number; max: number } | null): string {
  if (!range) return 'no packs';
  return range.min === range.max ? formatUsd(range.min) : `${formatUsd(range.min)} - ${formatUsd(range.max)}`;
}

/** How old saved prices are, so an admin knows how far to trust them. */
export function staleLevel(fetchedAt: string | null, now = Date.now()): 'never' | 'fresh' | 'aging' | 'old' {
  if (!fetchedAt) return 'never';
  const ms = now - new Date(fetchedAt).getTime();
  if (!Number.isFinite(ms)) return 'never';
  if (ms < 24 * 3600_000) return 'fresh';
  return ms < 7 * 24 * 3600_000 ? 'aging' : 'old';
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** "just now", "5 minutes ago", "3 hours ago", "2 days ago". Spelled out on purpose: it has to be read at a glance. */
export function ageText(iso: string | null, now = Date.now()): string {
  const t = iso ? new Date(iso).getTime() : NaN;
  if (!Number.isFinite(t)) return 'never';
  const mins = Math.max(0, Math.floor((now - t) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${plural(mins, 'minute')} ago`;
  if (mins < 60 * 24) return `${plural(Math.floor(mins / 60), 'hour')} ago`;
  return `${plural(Math.floor(mins / (60 * 24)), 'day')} ago`;
}

/** The oldest of the dates that exist (the least trustworthy price in a group), or null when there are none. */
export function oldestDate(dates: readonly (string | null)[]): string | null {
  let oldest: { iso: string; t: number } | null = null;
  for (const iso of dates) {
    const t = iso ? new Date(iso).getTime() : NaN;
    if (Number.isFinite(t) && (oldest === null || t < oldest.t)) oldest = { iso: iso as string, t };
  }
  return oldest ? oldest.iso : null;
}

/** One line per region whose saved prices are more than a day old (or missing), shown before an import. */
export function stalePriceWarnings(regions: readonly { label: string; fetchedAt: string | null }[], now = Date.now()): string[] {
  const out: string[] = [];
  for (const r of regions) {
    const level = staleLevel(r.fetchedAt, now);
    if (level === 'fresh') continue;
    out.push(
      level === 'never'
        ? `"${r.label}": no prices have been saved for it.`
        : `"${r.label}": these prices were saved ${ageText(r.fetchedAt, now)}. The supplier's costs may have changed since, so refresh them first if you can.`
    );
  }
  return out;
}

// ---------------------------------------------------------------- what a region imports as

/**
 * Account-region codes the supplier really reports, keyed by the supplier's "Region:" text (upper-case).
 * Only confirmed ones belong here: MENA accounts come back as "ME" (verified live with two real Free Fire
 * IDs). Never add a code that has not been seen in a real validation response.
 */
export const KNOWN_ACCOUNT_REGION_CODES: Readonly<Record<string, readonly string[]>> = { MENA: ['ME'] };

export type RegionDefaults = {
  idMode: 'supplier' | 'none';
  validationCategoryId: string | null;
  validationFieldMap: Record<string, string>;
  locked: boolean;
  /** Prefilled account regions. Empty when unknown: the pack then stays off until the admin types them. */
  codes: string[];
  /** Why the supplier ID check could not be used, when the game has one but this region can't. */
  idCheckNote: string | null;
};

/**
 * Purchase form key -> the key the supplier's ID check expects, where they differ (Mobile Legends buys with
 * server_id but validates with zone_id). Only an unambiguous pairing counts; anything else is null and the
 * region falls back to the customer's tick.
 */
export function mapValidationFields(purchase: readonly BuyerField[], check: readonly BuyerField[]): Record<string, string> | null {
  const p = purchase.map((f) => f.key);
  const v = check.map((f) => f.key);
  if (p.length === 0 || new Set(p).size !== p.length || new Set(v).size !== v.length) return null;
  const onlyPurchase = p.filter((k) => !v.includes(k));
  const onlyCheck = v.filter((k) => !p.includes(k));
  if (onlyPurchase.length === 0 && onlyCheck.length === 0) return {};
  if (onlyPurchase.length === 1 && onlyCheck.length === 1) return { [onlyPurchase[0]]: onlyCheck[0] };
  return null;
}

/**
 * The defaults for one supplier category:
 *  - The supplier checks the ID only when the category matched one of its 5 checkable games AND the
 *    purchase form maps onto the check's form. Otherwise the customer ticks "I've checked my ID".
 *  - It is region-locked only when the supplier checks the ID (a lock needs a verified account region),
 *    the category states a real region, and that region is not "Global". Gift cards are never locked.
 *  - Codes are prefilled only for regions with a confirmed code. Everything else imports locked with no
 *    codes, and stays off until they are typed. A code is never guessed.
 * Needs the category's packs to have been fetched (that is where its buyer form comes from).
 */
export function regionDefaults(row: Pick<CatalogRow, 'family' | 'validation_category_id' | 'validation_fields' | 'note_region' | 'fields'>): RegionDefaults {
  const none: RegionDefaults = { idMode: 'none', validationCategoryId: null, validationFieldMap: {}, locked: false, codes: [], idCheckNote: null };
  if (row.family !== 'topups') return none;
  if (!row.validation_category_id || !row.validation_fields) return none;

  const map = mapValidationFields(row.fields ?? [], row.validation_fields);
  if (map === null) {
    return { ...none, idCheckNote: "The supplier can check this game's IDs, but not from this form, so customers will tick that they checked their ID." };
  }

  const region = row.note_region?.trim() ?? '';
  // "Global" (FazerCards) and "Worldwide" (Shop2Topup) both mean any account can use it: nothing to lock.
  const locked = region !== '' && !['GLOBAL', 'WORLDWIDE'].includes(region.toUpperCase());
  const codes = locked ? [...(KNOWN_ACCOUNT_REGION_CODES[region.toUpperCase()] ?? [])] : [];
  return { idMode: 'supplier', validationCategoryId: row.validation_category_id, validationFieldMap: map, locked, codes, idCheckNote: null };
}

// ---------------------------------------------------------------- names

const PACK = /^([\d][\d,.]*)\s*(?:\+\s*[\d,.]+\s*)?(?:bonus\s+)?([A-Za-z][A-Za-z .'&\-/]*?)\s*(?:\(.*\))?$/;

/** "110 Diamonds" -> "Diamonds". Null when the name isn't "<number> <unit>". */
export function unitOf(offerName: string): string | null {
  const m = PACK.exec(offerName.trim());
  const unit = m?.[2].trim();
  return unit && unit.length <= 40 ? unit : null;
}

/** The unit word most of the chosen packs share ("Diamonds"), for the product's short description. */
export function commonUnit(offerNames: readonly string[]): string | null {
  const counts = new Map<string, { unit: string; n: number }>();
  for (const name of offerNames) {
    const unit = unitOf(name);
    if (!unit) continue;
    const key = unit.toLowerCase();
    const entry = counts.get(key) ?? { unit, n: 0 };
    entry.n++;
    counts.set(key, entry);
  }
  let best: { unit: string; n: number } | null = null;
  for (const entry of counts.values()) if (!best || entry.n > best.n) best = entry;
  return best ? best.unit : null;
}

/** A region code that satisfies the database's ^[a-z0-9_]{1,40}$, unique within the product. */
export function regionCodeFor(label: string, fallback: string, used: ReadonlySet<string>): string {
  const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 36);
  const base = slug(label) || slug(fallback) || 'region';
  let code = base;
  for (let i = 2; used.has(code); i++) code = `${base}_${i}`;
  return code;
}

// ---------------------------------------------------------------- the payload

/** A category the admin created for this product ("UC", "Coins"). `key` only links packs to it inside one import. */
export type ImportCategory = { key: string; label: string };

export const MAX_CATEGORIES = 12;
export const MAX_GALLERY_IMAGES = 12;

/** A short key for a new category that is unique among `used` and accepted by the database (^[a-z0-9_-]{1,40}$). */
export function categoryKeyFor(label: string, used: ReadonlySet<string>): string {
  const base = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30) || 'category';
  let key = base;
  for (let i = 2; used.has(key); i++) key = `${base}_${i}`;
  return key;
}

export type PackChoice = { offer: CatalogOffer; price: number | null; categoryKey?: string | null };
export type RegionChoice = {
  row: CatalogRow;
  label: string;
  packs: PackChoice[];
  /** Account regions the admin typed, already parsed. */
  codes: string[];
  /** Anything in the typed codes that isn't a plain short code. */
  invalidCodes: string[];
};

export type ImportInput = {
  name: string;
  imageUrl: string | null;
  regions: RegionChoice[];
  /** Categories for this product. With two or more, every pack must be assigned to one. */
  categories?: ImportCategory[];
  /** Storage paths of the card images already uploaded for this product. */
  imagePaths?: string[];
};

export type ImportPayload = {
  name: string;
  category: 'games' | 'gift-cards';
  tagline: string;
  currency_label: string | null;
  image_url: string | null;
  images?: { path: string }[];
  categories?: ImportCategory[];
  regions: {
    code: string;
    label: string;
    buyer_fields: BuyerField[];
    id_validation: 'supplier' | 'none';
    family: CatalogFamily;
    category_id: string;
    validation_category_id: string | null;
    validation_field_map: Record<string, string>;
    /** Which supplier the category and every pack below belong to. */
    supplier: SupplierName;
    packs: {
      offer_ref: string;
      offer_name: string;
      label: string;
      price: number;
      cost_usd: string;
      group_label: string | null;
      region_locked: boolean;
      account_region_codes: string[];
      category_key?: string;
    }[];
  }[];
};

export type PlanResult = { ok: true; payload: ImportPayload; warnings: string[] } | { ok: false; problems: string[] };

/** Cheapest first, so packs read in ascending order like a shop shelf. */
const byCost = (a: CatalogOffer, b: CatalogOffer) => usd(a.cost_usd) - usd(b.cost_usd) || a.name.localeCompare(b.name);

/** Everything the admin chose, checked, and shaped for admin_import_product. Nothing is guessed here. */
export function buildImportPayload(input: ImportInput): PlanResult {
  const problems: string[] = [];
  const warnings: string[] = [];

  const name = input.name.trim();
  if (name === '') problems.push('Give the product a name.');
  else if (name.length > 120) problems.push('The product name is too long (120 characters at most).');

  // ---- categories and images
  const categories = (input.categories ?? []).map((c) => ({ key: c.key, label: c.label.trim() }));
  const imagePaths = input.imagePaths ?? [];
  if (categories.length > MAX_CATEGORIES) problems.push(`Use at most ${MAX_CATEGORIES} categories.`);
  if (categories.some((c) => c.label === '')) problems.push('Give every category a name.');
  if (categories.some((c) => c.label.length > 40)) problems.push('A category name is too long (40 characters at most).');
  const labels = categories.map((c) => c.label.toLowerCase());
  if (new Set(labels).size !== labels.length) problems.push('Two categories have the same name.');
  if (imagePaths.length > MAX_GALLERY_IMAGES) problems.push(`Use at most ${MAX_GALLERY_IMAGES} card images.`);
  const categoryKeys = new Set(categories.map((c) => c.key));

  if (input.regions.length === 0) problems.push('Tick at least one region.');
  if (new Set(input.regions.map((r) => r.row.family)).size > 1) problems.push("Top-ups and gift cards can't share one product.");
  if (new Set(input.regions.map((r) => r.row.supplier ?? 'fazercards')).size > 1) problems.push("Regions from different suppliers can't be imported into one product. Import them one supplier at a time.");

  const used = new Set<string>();
  const regions: ImportPayload['regions'] = [];
  for (const region of input.regions) {
    const where = region.label.trim() || region.row.name;
    const label = region.label.trim();
    if (label === '') problems.push(`Give the region "${region.row.name}" a name customers will see.`);
    else if (label.length > 60) problems.push(`"${where}" has too long a name (60 characters at most).`);
    if (region.packs.length === 0) problems.push(`Tick at least one pack in "${where}".`);
    if (region.invalidCodes.length > 0) problems.push(`"${where}": ${region.invalidCodes.join(', ')} ${region.invalidCodes.length === 1 ? "isn't a valid region code" : "aren't valid region codes"}. Use short codes like ME.`);

    const unpriced = region.packs.filter((p) => p.price === null || !(p.price > 0));
    if (unpriced.length > 0) problems.push(`"${where}": set a birr price for ${unpriced.length === 1 ? `"${unpriced[0].offer.name}"` : `${unpriced.length} packs`}.`);

    const row = region.row;
    if (!row.fields || !row.offers) {
      problems.push(`"${where}": its packs haven't been loaded yet.`);
      continue;
    }
    const defaults = regionDefaults(row);
    const codes = defaults.locked ? region.codes : [];
    if (!defaults.locked && region.codes.length > 0) warnings.push(`"${where}" isn't region-locked, so its account regions were ignored.`);
    if (defaults.locked && codes.length === 0) warnings.push(`"${where}" is region-locked but has no account regions, so its packs stay off until you add them.`);

    // With two or more categories a pack without one would be unreachable behind the category pills.
    const uncategorised = region.packs.filter((p) => !p.categoryKey);
    if (categories.length >= 2 && uncategorised.length > 0) {
      problems.push(`"${where}": choose a category for ${uncategorised.length === 1 ? `"${uncategorised[0].offer.name}"` : `${uncategorised.length} packs`}.`);
    }
    if (region.packs.some((p) => p.categoryKey && !categoryKeys.has(p.categoryKey))) {
      problems.push(`"${where}": a pack is in a category that no longer exists.`);
    }

    const packs = [...region.packs]
      .filter((p) => p.price !== null && p.price > 0)
      .sort((a, b) => byCost(a.offer, b.offer))
      .map((p) => ({
        offer_ref: p.offer.ref,
        offer_name: p.offer.name,
        label: p.offer.name,
        price: p.price as number,
        cost_usd: p.offer.cost_usd,
        group_label: unitOf(p.offer.name),
        region_locked: defaults.locked,
        account_region_codes: codes,
        ...(p.categoryKey ? { category_key: p.categoryKey } : {}),
      }));

    const code = regionCodeFor(label, row.category_id, used);
    used.add(code);
    regions.push({
      code,
      label,
      buyer_fields: row.fields,
      id_validation: defaults.idMode,
      family: row.family,
      category_id: row.category_id,
      validation_category_id: defaults.validationCategoryId,
      validation_field_map: defaults.validationFieldMap,
      supplier: row.supplier ?? 'fazercards',
      packs,
    });
  }

  if (problems.length > 0) return { ok: false, problems };

  const family = input.regions[0].row.family;
  const unit = commonUnit(regions.flatMap((r) => r.packs.map((p) => p.offer_name)));
  return {
    ok: true,
    warnings,
    payload: {
      name,
      category: family === 'topups' ? 'games' : 'gift-cards',
      tagline: unit ?? '',
      currency_label: unit,
      image_url: input.imageUrl,
      ...(imagePaths.length > 0 ? { images: imagePaths.map((path) => ({ path })) } : {}),
      ...(categories.length > 0 ? { categories } : {}),
      regions,
    },
  };
}

// ---------------------------------------------------------------- what the function returns

export type OffersData = {
  offers: CatalogOffer[];
  fields: BuyerField[];
  hidden_offer_count: number;
  offers_fetched_at: string | null;
};

export type LoadOffersOutcome =
  | { kind: 'fresh'; data: OffersData }
  /** The supplier couldn't be reached. `data` is what was saved earlier, if anything. */
  | { kind: 'saved'; reason: 'refused' | 'timeout' | 'error'; data: OffersData | null }
  | { kind: 'blocked'; reason: string }
  | { kind: 'error' };

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

function parseOffers(raw: unknown): CatalogOffer[] | null {
  if (!Array.isArray(raw)) return null;
  const out: CatalogOffer[] = [];
  for (const o of raw) {
    if (!isRecord(o) || typeof o.ref !== 'string' || typeof o.name !== 'string' || typeof o.cost_usd !== 'string') return null;
    const offer: CatalogOffer = { ref: o.ref, name: o.name, cost_usd: o.cost_usd };
    if (typeof o.stock === 'number') offer.stock = o.stock;
    out.push(offer);
  }
  return out;
}

function parseFields(raw: unknown): BuyerField[] | null {
  if (!Array.isArray(raw)) return null;
  const out: BuyerField[] = [];
  for (const f of raw) {
    if (!isRecord(f) || typeof f.key !== 'string' || typeof f.label !== 'string') return null;
    const field: BuyerField = { key: f.key, label: f.label, type: f.type === 'select' ? 'select' : 'text' };
    if (Array.isArray(f.options)) field.options = f.options.filter(isRecord);
    out.push(field);
  }
  return out;
}

function parseData(raw: unknown): OffersData | null {
  if (!isRecord(raw)) return null;
  const offers = parseOffers(raw.offers);
  const fields = parseFields(raw.fields);
  if (!offers || !fields) return null;
  return {
    offers,
    fields,
    hidden_offer_count: typeof raw.hidden_offer_count === 'number' ? raw.hidden_offer_count : 0,
    offers_fetched_at: typeof raw.offers_fetched_at === 'string' ? raw.offers_fetched_at : null,
  };
}

export function parseLoadOffers(body: unknown): LoadOffersOutcome {
  if (!isRecord(body)) return { kind: 'error' };
  if (body.status === 'ok') {
    const data = parseData(body);
    return data && data.offers_fetched_at ? { kind: 'fresh', data } : { kind: 'error' };
  }
  if (body.status === 'blocked') return { kind: 'blocked', reason: typeof body.reason === 'string' ? body.reason : 'not sellable' };
  if (body.status === 'unavailable') {
    const reason = body.reason === 'refused' || body.reason === 'timeout' ? body.reason : 'error';
    return { kind: 'saved', reason, data: parseData(body.cached) };
  }
  return { kind: 'error' };
}

export type RefreshOutcome =
  | { kind: 'ok'; categories: number; removed: number; refreshedAt: string }
  | { kind: 'unavailable'; reason: 'refused' | 'timeout' | 'error' }
  | { kind: 'suspicious'; found: number; saved: number }
  | { kind: 'error' };

export function parseRefresh(body: unknown): RefreshOutcome {
  if (!isRecord(body)) return { kind: 'error' };
  if (body.status === 'ok' && typeof body.categories === 'number' && typeof body.refreshed_at === 'string') {
    return { kind: 'ok', categories: body.categories, removed: typeof body.removed === 'number' ? body.removed : 0, refreshedAt: body.refreshed_at };
  }
  if (body.status === 'unavailable') return { kind: 'unavailable', reason: body.reason === 'refused' || body.reason === 'timeout' ? body.reason : 'error' };
  if (body.status === 'suspicious' && typeof body.found === 'number' && typeof body.saved === 'number') return { kind: 'suspicious', found: body.found, saved: body.saved };
  return { kind: 'error' };
}

/** What to tell the admin when the supplier can't be reached and saved data is shown instead. */
export function unreachableText(reason: 'refused' | 'timeout' | 'error'): string {
  if (reason === 'refused') return 'The supplier refused the request (the trial may have ended).';
  if (reason === 'timeout') return "The supplier didn't answer in time.";
  return "Couldn't reach the supplier.";
}

// ---------------------------------------------------------------- the import screen's per-region state

/** `manual` is true when the admin typed the price: recalculating from the exchange rate leaves it alone (see priceCalc.ts). */
export type PackDraft = { ticked: boolean; price: string; categoryKey?: string | null; manual?: boolean; /** This pack's own markup in percent (default 0). */ percent?: number };

/** The packs currently on screen for a region: what was saved, or what was just fetched. */
export type RegionData = { offers: CatalogOffer[]; fields: BuyerField[]; hidden: number; fetchedAt: string | null };

export type RegionState = {
  ticked: boolean;
  label: string;
  codesText: string;
  packs: Record<string, PackDraft>;
  data: RegionData | null;
  busy: boolean;
  notice: string | null;
};

/** What a region starts as. The account regions start as the region's own defaults (ME for MENA, else empty). */
export function initialRegionState(row: CatalogRow): RegionState {
  const data = row.offers && row.fields ? { offers: row.offers, fields: row.fields, hidden: row.hidden_offer_count, fetchedAt: row.offers_fetched_at } : null;
  return {
    ticked: false,
    label: row.region_label ?? 'Standard',
    codesText: data ? regionDefaults({ ...row, fields: data.fields }).codes.join(', ') : '',
    packs: {},
    data,
    busy: false,
    notice: null,
  };
}

/** The row as the import sees it: with the packs and form that are on screen. */
export function effectiveRow(row: CatalogRow, state: RegionState): CatalogRow {
  return { ...row, offers: state.data?.offers ?? null, fields: state.data?.fields ?? null };
}

/**
 * What the screen shows after asking the function for a category's packs. Saved packs are never thrown
 * away because the supplier was unreachable, and the admin's typed account regions are only replaced by
 * the defaults the FIRST time packs arrive (never after they have had a chance to edit them).
 */
export function applyOutcome(prev: RegionState, row: CatalogRow, out: LoadOffersOutcome): RegionState {
  const settled = { ...prev, busy: false };
  const withData = (d: OffersData, notice: string | null): RegionState => {
    const data: RegionData = { offers: d.offers, fields: d.fields, hidden: d.hidden_offer_count, fetchedAt: d.offers_fetched_at };
    const codesText = prev.data === null ? regionDefaults({ ...row, fields: data.fields }).codes.join(', ') : prev.codesText;
    return { ...settled, data, codesText, notice };
  };
  switch (out.kind) {
    case 'fresh':
      return withData(out.data, null);
    case 'saved':
      return out.data
        ? withData(out.data, `${unreachableText(out.reason)} Showing the prices saved earlier.`)
        : {
            ...settled,
            notice: `${unreachableText(out.reason)} ${prev.data ? 'Showing the prices saved earlier.' : 'There are no saved prices for this one.'}`,
          };
    case 'blocked':
      return { ...settled, ticked: false, notice: `This one can't be imported: ${out.reason}.` };
    case 'error':
      return { ...settled, notice: `Couldn't refresh the prices. ${prev.data ? 'Showing the prices saved earlier.' : 'Try again.'}` };
  }
}
