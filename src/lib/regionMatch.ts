/**
 * Region matching for region-locked packages. Pure functions with no imports.
 *
 * The supplier's ID validation returns the region the ACCOUNT belongs to ("ME").
 * A package is region-locked when the category it orders from only serves some
 * account regions; it then lists them in `accountRegionCodes`. The check is per
 * PACKAGE, because packages of one product can order from different categories.
 * The region chip a package is shown under is presentation only.
 *
 * Never guess: with no account region, the answer is "unverified". The database
 * enforces the same rules at purchase (purchase_product_option), so this only decides
 * what the screen offers: a locked package is sold only when the account's region is
 * confirmed and is one it serves. A locked package without codes is never sellable.
 */

export type RegionPackage = {
  regionLocked: boolean;
  accountRegionCodes: readonly string[];
};

export type RegionGroup = {
  id: string;
  label: string;
  /** The region's packages that are on sale. */
  packages: readonly RegionPackage[];
};

export type PackageVerdict =
  /** Not region-locked: any account may buy it. */
  | { status: 'open' }
  /** Locked, and this account's region is one it serves. */
  | { status: 'match' }
  /** Locked, and this account's region is NOT one it serves. */
  | { status: 'mismatch'; account: string }
  /** Locked, but we don't know the account's region, so we can't check. */
  | { status: 'unverified'; reason: 'no_account_region' }
  /** Locked with no codes configured: must never be sold. */
  | { status: 'unavailable'; reason: 'no_codes' };

/**
 * What an admin might type (or a label like the supplier's "MENA") -> the code the supplier's ID check actually returns.
 * Mirrors the database table public.account_region_aliases, which translates codes when they are SAVED; a test keeps the two
 * identical. Only mappings confirmed with real accounts belong here: never guess one.
 */
export const REGION_ALIASES: Readonly<Record<string, string>> = { MENA: 'ME' };

/** "me " -> "ME", "mena" -> "ME". Anything that isn't a plain short code -> null. */
export function normalizeRegionCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const code = value.trim().toUpperCase();
  if (!/^[A-Z0-9_-]{1,16}$/.test(code)) return null;
  return REGION_ALIASES[code] ?? code;
}

const codesOf = (p: RegionPackage) =>
  p.accountRegionCodes.map(normalizeRegionCode).filter((c): c is string => c !== null);

/** Is this package right for an account in `accountRegion`? */
export function judgePackage(pkg: RegionPackage, accountRegion: unknown): PackageVerdict {
  if (!pkg.regionLocked) return { status: 'open' };
  const codes = codesOf(pkg);
  if (codes.length === 0) return { status: 'unavailable', reason: 'no_codes' };
  const account = normalizeRegionCode(accountRegion);
  if (account === null) return { status: 'unverified', reason: 'no_account_region' };
  return codes.includes(account) ? { status: 'match' } : { status: 'mismatch', account };
}

/** Buying is allowed only when the package is open to everyone or the account's region is confirmed right. */
export function packageAllowsPurchase(verdict: PackageVerdict): boolean {
  return verdict.status === 'open' || verdict.status === 'match';
}

export type RegionSuggestion =
  /** The account region can't guide the choice (unknown, or nothing here is region-locked). */
  | { kind: 'unknown' }
  /** The selected region already has a package that serves this account. */
  | { kind: 'keep' }
  /** Exactly one region has packages serving this account: switch to it. */
  | { kind: 'switch'; region: RegionGroup }
  /** Several other regions serve it and none is selected: the customer must choose. */
  | { kind: 'choose'; regions: readonly RegionGroup[] }
  /** Locked packages exist, but none serves this account. */
  | { kind: 'not_carried'; account: string };

const serves = (r: RegionGroup, account: string) =>
  r.packages.some((p) => judgePackage(p, account).status === 'match');

/** Which region chip fits this account? A hint for the chips; each package is still judged on its own. */
export function suggestRegion(
  regions: readonly RegionGroup[],
  selectedId: string | null,
  accountRegion: unknown
): RegionSuggestion {
  const account = normalizeRegionCode(accountRegion);
  if (account === null) return { kind: 'unknown' };

  const anyLocked = regions.some((r) => r.packages.some((p) => p.regionLocked));
  if (!anyLocked) return { kind: 'unknown' };

  const fitting = regions.filter((r) => serves(r, account));
  if (fitting.length === 0) return { kind: 'not_carried', account };
  if (selectedId !== null && fitting.some((r) => r.id === selectedId)) return { kind: 'keep' };
  return fitting.length === 1 ? { kind: 'switch', region: fitting[0] } : { kind: 'choose', regions: fitting };
}

export type PackageState =
  /** Selectable, but the account's region isn't known yet (waiting for the ID check). */
  | 'pending'
  | 'ok'
  /** The account's region is confirmed and this package does not serve it. */
  | 'wrong_region'
  /** The ID was checked but the supplier reported no region, so a locked package can't be sold. */
  | 'region_unknown'
  /** Can never be sold to this customer as things stand. */
  | 'unavailable';

/**
 * What the screen should do with one package. `validated` + `accountRegion` come from a live ID
 * check. Where nothing can verify the account (no supplier validation), a locked package is
 * unavailable: the database would refuse it.
 */
export function packageState(
  pkg: RegionPackage,
  ctx: { idMode: 'supplier' | 'tick' | 'none'; validated: boolean; accountRegion: string | null }
): PackageState {
  if (!pkg.regionLocked) return 'ok';
  if (judgePackage(pkg, 'ZZ').status === 'unavailable') return 'unavailable'; // locked, no codes
  if (ctx.idMode !== 'supplier') return 'unavailable';
  if (!ctx.validated) return 'pending';
  const verdict = judgePackage(pkg, ctx.accountRegion);
  if (verdict.status === 'open' || verdict.status === 'match') return 'ok';
  if (verdict.status === 'mismatch') return 'wrong_region';
  if (verdict.status === 'unverified') return 'region_unknown';
  return 'unavailable';
}
