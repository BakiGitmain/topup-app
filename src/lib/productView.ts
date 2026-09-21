/** What the product page shows, decided from catalog rows. Pure functions; imports are types only. */
import type { BuyerField } from './idValidation';

export type RegionView = {
  id: string;
  code: string;
  label: string;
  buyerFields: BuyerField[];
  idValidation: 'supplier' | 'none';
  sortOrder: number;
};

export type PackageView = {
  id: string;
  label: string;
  groupLabel: string | null;
  price: number;
  oldPrice: number | null;
  regionId: string | null;
  regionLocked: boolean;
  accountRegionCodes: string[];
  sortOrder: number;
  /** Set when an admin picked an image for this pack; null shows the text-only card. */
  imageUrl: string | null;
  categoryId: string | null;
};

export type PackageGroup = { label: string | null; packages: PackageView[] };

const byOrder = (a: PackageView, b: PackageView) => a.sortOrder - b.sortOrder || a.price - b.price || a.label.localeCompare(b.label);

/** Packages grouped by their group label, groups in the order they first appear, cheapest-first inside. */
export function groupPackages(packages: readonly PackageView[]): PackageGroup[] {
  const groups: PackageGroup[] = [];
  for (const pkg of [...packages].sort(byOrder)) {
    const label = pkg.groupLabel?.trim() || null;
    let group = groups.find((g) => g.label === label);
    if (!group) {
      group = { label, packages: [] };
      groups.push(group);
    }
    group.packages.push(pkg);
  }
  return groups;
}

export function sortRegions(regions: readonly RegionView[]): RegionView[] {
  return [...regions].sort((a, b) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label));
}

/** Region chips only make sense when there is a choice. */
export function needsRegionChips(regions: readonly RegionView[]): boolean {
  return regions.length > 1;
}

/** The packages a region offers (a legacy product with no regions uses region null). */
export function packagesInRegion(packages: readonly PackageView[], regionId: string | null): PackageView[] {
  return packages.filter((p) => p.regionId === regionId);
}

/** The region to start on: the one a package was pre-selected in, else the first. */
export function initialRegionId(
  regions: readonly RegionView[],
  packages: readonly PackageView[],
  preselectedOptionId: string | null | undefined
): string | null {
  const sorted = sortRegions(regions);
  const wanted = packages.find((p) => p.id === preselectedOptionId)?.regionId;
  if (wanted && sorted.some((r) => r.id === wanted)) return wanted;
  return sorted[0]?.id ?? null;
}

/** "player_id" -> "Player ID", "server" -> "Server". For showing stored IDs when only the key is known. */
export function humanizeKey(key: string): string {
  return key
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((w) => (w.toLowerCase() === 'id' ? 'ID' : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

/** How an order's stored ID fields read on screen: [["Player ID", "3327..."], ...]. */
export function describeFields(
  delivery: { fields?: Record<string, unknown>; account_id?: string } | null | undefined
): [string, string][] {
  const fields = delivery?.fields;
  if (fields && typeof fields === 'object') {
    const entries = Object.entries(fields).filter(([, v]) => typeof v === 'string' || typeof v === 'number');
    if (entries.length > 0) return entries.map(([k, v]) => [humanizeKey(k), String(v)]);
  }
  return delivery?.account_id ? [['Game ID', delivery.account_id]] : [];
}

// ---------------------------------------------------------------- categories ("UC", "Coins", "Membership", ...)

export type CategoryView = { id: string; label: string; sortOrder: number };

const byCategoryOrder = (a: CategoryView, b: CategoryView) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label);

/**
 * The category a pack is shown under. A pack with no category (or one that isn't in the list) is shown under the
 * FIRST category, so a pack can never be unreachable behind the pills.
 */
export function effectiveCategoryId(pkg: Pick<PackageView, 'categoryId'>, categories: readonly CategoryView[]): string | null {
  const sorted = [...categories].sort(byCategoryOrder);
  if (sorted.length === 0) return null;
  return sorted.some((c) => c.id === pkg.categoryId) ? pkg.categoryId : sorted[0].id;
}

export type CategoryFilter = {
  /** The pills to draw. Empty means: draw no row at all. */
  pills: CategoryView[];
  /** The selected pill (the first one until a customer picks another), or null with no pills. */
  activeId: string | null;
  /** The packs to show: everything when there are no pills, else only the active category's. */
  visible: PackageView[];
};

/**
 * Category pills for the packs on screen (the ones in the selected region). Pills exist only when there is a real
 * choice: two or more categories that each have a pack here. A category with nothing to buy here gets no pill (it would
 * be an empty tab). Zero or one category means no row and every pack is shown. `chosenId` is what the customer
 * tapped; if it isn't a pill any more (say they switched region) the first pill is used.
 */
export function categoryFilter(packages: readonly PackageView[], categories: readonly CategoryView[], chosenId: string | null): CategoryFilter {
  const withPacks = new Set(packages.map((p) => effectiveCategoryId(p, categories)));
  const pills = [...categories].sort(byCategoryOrder).filter((c) => withPacks.has(c.id));
  if (pills.length < 2) return { pills: [], activeId: null, visible: [...packages] };
  const activeId = pills.some((p) => p.id === chosenId) ? (chosenId as string) : pills[0].id;
  return { pills, activeId, visible: packages.filter((p) => effectiveCategoryId(p, categories) === activeId) };
}
