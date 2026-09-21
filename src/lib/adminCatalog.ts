/** Admin catalog decisions: what is on sale, filters, guards, error wording. Pure functions, no runtime imports. */

export type StatusPack = {
  is_active: boolean;
  region_id: string | null;
  missing_upstream?: boolean;
};
export type StatusRegion = { id: string; is_active: boolean };
export type StatusProduct = {
  name: string;
  tagline: string;
  is_active: boolean;
  options: readonly StatusPack[];
  regions: readonly StatusRegion[];
};

export type HiddenReason = 'product_off' | 'no_packs_on' | 'region_off';
export type ProductStatus = { status: 'on_sale'; reason: null } | { status: 'hidden'; reason: HiddenReason };

/** A pack customers can actually buy: it is on, and so is its region (if it has one). */
export function isLivePack(pack: StatusPack, regions: readonly StatusRegion[]): boolean {
  if (!pack.is_active) return false;
  if (pack.region_id === null) return true;
  return regions.some((r) => r.id === pack.region_id && r.is_active);
}

/** Same rule the shop uses: on sale only when the product is on AND at least one pack is live. */
export function productStatus(product: StatusProduct): ProductStatus {
  if (!product.is_active) return { status: 'hidden', reason: 'product_off' };
  if (product.options.some((o) => isLivePack(o, product.regions))) return { status: 'on_sale', reason: null };
  return { status: 'hidden', reason: product.options.some((o) => o.is_active) ? 'region_off' : 'no_packs_on' };
}

export function hiddenReasonText(reason: HiddenReason): string {
  switch (reason) {
    case 'product_off':
      return 'The product is switched off.';
    case 'no_packs_on':
      return 'No pack is switched on, so customers see nothing to buy.';
    case 'region_off':
      return "The packs that are on belong to a region that is switched off.";
  }
}

export type ListFilter = 'all' | 'on_sale' | 'hidden';

/** Search by name or short description (case-insensitive), then by filter. */
export function filterProducts<T extends StatusProduct>(products: readonly T[], filter: ListFilter, query: string): T[] {
  const needle = query.trim().toLowerCase();
  return products.filter((p) => {
    if (needle && !p.name.toLowerCase().includes(needle) && !p.tagline.toLowerCase().includes(needle)) return false;
    if (filter === 'all') return true;
    return (productStatus(p).status === 'on_sale') === (filter === 'on_sale');
  });
}

/** Chip counts. They follow the search, so they always add up to what the list would show. */
export function filterCounts(products: readonly StatusProduct[], query: string): Record<ListFilter, number> {
  const matching = filterProducts(products, 'all', query);
  const onSale = matching.filter((p) => productStatus(p).status === 'on_sale').length;
  return { all: matching.length, on_sale: onSale, hidden: matching.length - onSale };
}

/** Packs whose supplier offer has disappeared. They stay on sale and fail at order time, so admins need to see them. */
export function missingUpstreamCount(product: Pick<StatusProduct, 'options'>): number {
  return product.options.filter((o) => o.missing_upstream === true).length;
}

// ---------------------------------------------------------------- region lock

/** Codes typed as "me, BR ,me" -> ["BR","ME"]. Anything that is not a short plain code is reported, not guessed at. */
export function parseRegionCodes(text: string): { codes: string[]; invalid: string[] } {
  const seen = new Set<string>();
  const invalid: string[] = [];
  for (const raw of text.split(/[\s,;]+/)) {
    const code = raw.trim();
    if (code === '') continue;
    if (/^[A-Za-z0-9_-]{1,16}$/.test(code)) seen.add(code.toUpperCase());
    else invalid.push(code.slice(0, 20));
  }
  return { codes: [...seen].sort(), invalid };
}

export type LockState = 'open' | 'locked' | 'locked_no_codes';

export function lockState(pack: { region_locked: boolean; account_region_codes: readonly string[] }): LockState {
  if (!pack.region_locked) return 'open';
  return pack.account_region_codes.length > 0 ? 'locked' : 'locked_no_codes';
}

export function lockLabel(pack: { region_locked: boolean; account_region_codes: readonly string[] }): string {
  const state = lockState(pack);
  if (state === 'open') return 'Any account region';
  if (state === 'locked') return `${pack.account_region_codes.join(', ')} accounts only`;
  return 'Region-locked, but no account regions set';
}

/** Why a pack can't be switched on yet, or null. The database enforces the same rule. */
export function switchOnBlocker(pack: { region_locked: boolean; account_region_codes: readonly string[] }): string | null {
  return lockState(pack) === 'locked_no_codes'
    ? "This pack is region-locked but has no account regions, so it can't be switched on. Add the regions (for example ME) first."
    : null;
}

/** What the lock editor would save, or why it can't. */
export function checkLock(locked: boolean, codesText: string):
  | { ok: true; region_locked: boolean; account_region_codes: string[] }
  | { ok: false; message: string } {
  const { codes, invalid } = parseRegionCodes(codesText);
  if (invalid.length > 0) return { ok: false, message: `These aren't valid region codes: ${invalid.join(', ')}. Use short codes like ME or BR.` };
  if (!locked && codes.length > 0) return { ok: false, message: 'Turn the region lock on to keep account regions, or clear them.' };
  return { ok: true, region_locked: locked, account_region_codes: locked ? codes : [] };
}

// ---------------------------------------------------------------- grouping for the editor

export type EditorPack = { id: string; group_label: string | null; region_id: string | null; sort_order: number; price: number; label: string };
export type EditorRegion = { id: string; sort_order: number; label: string };
export type EditorSection<P, R> = { region: R | null; groups: { label: string | null; packs: P[] }[] };

/** Packs by region, then by group label. Packs with no region come last. */
export function sectionsForEditor<P extends EditorPack, R extends EditorRegion>(packs: readonly P[], regions: readonly R[]): EditorSection<P, R>[] {
  const order = (a: P, b: P) => a.sort_order - b.sort_order || a.price - b.price || a.label.localeCompare(b.label);
  const ordered = [...regions].sort((a, b) => a.sort_order - b.sort_order || a.label.localeCompare(b.label));
  const build = (region: R | null, list: P[]): EditorSection<P, R> => {
    const groups: { label: string | null; packs: P[] }[] = [];
    for (const pack of [...list].sort(order)) {
      const label = pack.group_label?.trim() || null;
      let group = groups.find((g) => g.label === label);
      if (!group) groups.push((group = { label, packs: [] }));
      group.packs.push(pack);
    }
    return { region, groups };
  };
  const sections = ordered.map((r) => build(r, packs.filter((p) => p.region_id === r.id))).filter((s) => s.groups.length > 0);
  const loose = packs.filter((p) => p.region_id === null || !ordered.some((r) => r.id === p.region_id));
  if (loose.length > 0) sections.push(build(null, [...loose]));
  return sections;
}

// ---------------------------------------------------------------- errors

/** A friendly message for a database refusal on the catalog tables, or null if it isn't one we know. */
export function catalogErrorMessage(error: unknown): string | null {
  const message = String((error as { message?: unknown } | null)?.message ?? '');
  const detail = String((error as { details?: unknown } | null)?.details ?? '').slice(0, 80);
  if (message.includes('locked_needs_codes_to_be_live')) return switchOnBlocker({ region_locked: true, account_region_codes: [] });
  if (message.includes('codes_need_lock')) return 'Turn the region lock on to keep account regions, or clear them.';
  if (message.includes('region_codes_safe')) return "Region codes must be short, like ME or BR.";
  if (message.includes('old_price_check')) return 'The old price must be higher than the selling price.';
  if (message.includes('price_check')) return 'The price must be above Br 0.';
  if (message.includes('already_imported')) return `${detail ? `"${detail}" was` : 'A pack was'} already imported. Each supplier pack can only be imported once, so untick it or edit the product it is in.`;
  if (message.includes('offer_name_required')) return "A pack has no supplier name, so it can't be imported.";
  if (message.includes('first_purchase_only_not_sellable')) return "A pack is a first-purchase-only offer. Those work once per account, so they can't be sold.";
  if (message.includes('blocked_supplier_category')) return "This game asks the buyer for a login or password. We never collect those, so it can't be imported.";
  if (message.includes('import_invalid')) return `The import was refused (${detail || 'invalid data'}). Check the names, prices and account regions, then try again.`;
  if (message.includes('product_has_orders')) return "This product has orders, so it can't be removed (that would break their history). Switch it off to hide it instead.";
  if (message.includes('pack_image_not_in_gallery')) return "That image isn't one of this product's images. Add it to the product's images first.";
  if (message.includes('pack_category_wrong_product')) return "That category belongs to a different product.";
  if (message.includes('product_categories_label_unique')) return 'This product already has a category with that name.';
  if (message.includes('product_categories_label_check')) return 'Give the category a name (40 characters at most).';
  if (message.includes('product_options_category_id_fkey')) return "Packs are still in this category. Move them to another category first, then delete it.";
  if (message.includes('not_updated')) return "That change wasn't saved. You may not have admin access, or the item was removed. Pull to refresh and try again.";
  if (message.includes('row-level security') || message.includes('permission denied')) return "You don't have admin access.";
  return null;
}
