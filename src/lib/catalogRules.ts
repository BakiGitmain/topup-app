/** What the shop shows, decided from catalog rows. Pure functions with no imports. */

/** Only real web addresses are used as artwork; anything else falls back to the letter tile. */
export function safeImageUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const url = value.trim();
  return /^https?:\/\/[^\s]+$/i.test(url) ? url : null;
}

/** First character of the name for the letter tile, whole (an emoji or a styled letter is not split). */
export function tileLetter(name: unknown): string {
  if (typeof name !== 'string') return '?';
  const first = Array.from(name.trim())[0];
  return first ? first.toUpperCase() : '?';
}

type PackageRow = { is_active: boolean; region_id: string | null };
type RegionRow = { id: string; is_active: boolean };

/**
 * Packages a customer can actually buy: on, and (when the package belongs to a region)
 * that region is on too. The purchase function refuses packages in an off region, so
 * showing them would only lead to a dead end. A product with none is hidden.
 */
export function purchasablePackages<T extends PackageRow>(
  packages: readonly T[] | null | undefined,
  regions: readonly RegionRow[] | null | undefined
): T[] {
  const liveRegions = new Set((regions ?? []).filter((r) => r.is_active).map((r) => r.id));
  return (packages ?? []).filter((p) => p.is_active && (p.region_id === null || liveRegions.has(p.region_id)));
}
