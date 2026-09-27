/** Pure helpers for the admin discount-code form: parsing percentages and turning the product picker's UI state
 * (a "restrict to specific products" toggle plus a set of ticked ids) into what the database column actually wants
 * (null = every product). No imports, so this is trivial to unit test. */

/** A discount must be a real discount (over 0), capped at 90 -- not 100: discount applies only to the lines a code
 * covers, so a 100%-off code covering the whole cart could zero out the order total, and wallet_transactions forbids
 * a zero-amount ledger row, which would make a Br 0 order unpayable through the wallet. Commission may be 0 (a
 * creator who earns nothing on this code) and caps at 100 -- it never reduces the order total, so it has no such gap. */
export function parsePercent(text: string, allowZero: boolean, max = 100): number | null {
  const trimmed = text.trim();
  // Number('') is 0, not NaN -- without this, leaving the field blank would silently mean "0%" whenever zero is allowed.
  if (trimmed === '') return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return null;
  if (allowZero ? value < 0 : value <= 0) return null;
  if (value > max) return null;
  return Math.round(value * 100) / 100;
}

export const MAX_DISCOUNT_PERCENT = 90;

/** How many Portal Coins a code-using order earns (replaces the flat +2 default). A whole number, at least 1. */
export function parsePortalCoinBonus(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const value = Number(trimmed);
  return Number.isInteger(value) && value >= 1 ? value : null;
}

/** null = open to every product (the database's own meaning); otherwise the ticked ids, never empty. */
export function applicableProducts(restrict: boolean, selected: ReadonlySet<string>): string[] | null {
  if (!restrict || selected.size === 0) return null;
  return [...selected];
}

/** A picked calendar date -> an ISO instant at the end of that LOCAL day, so the code still works for the whole day
 * picked, no matter the device's time zone. */
export function endOfDayIso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return new Date(`${y}-${m}-${day}T23:59:59.999Z`).toISOString();
}

export type CodeFormState = {
  code: string;
  creatorId: string | null;
  discountText: string;
  commissionText: string;
  portalCoinBonusText: string;
  restrict: boolean;
  selectedProducts: ReadonlySet<string>;
  /** null = never expires. From the native date picker, so always a real calendar date -- no free-text parsing. */
  expiresAt: Date | null;
};

export type CodeFormValid = {
  code: string;
  creator_id: string;
  discount_percent: number;
  commission_percent: number;
  applicable_products: string[] | null;
  expires_at: string | null;
  portal_coin_bonus: number;
};

/** One place that decides whether the form can be saved, so the screen doesn't duplicate this logic in a Button's
 * `disabled` prop and again in its `onPress`. Restricting to products but ticking none is treated as not-yet-valid
 * (not silently "all products"), so a half-finished restriction can't be saved by accident. */
export function validateCodeForm(state: CodeFormState): CodeFormValid | null {
  const code = state.code.trim();
  if (code.length === 0 || code.length > 40) return null;
  if (!state.creatorId) return null;
  const discount_percent = parsePercent(state.discountText, false, MAX_DISCOUNT_PERCENT);
  if (discount_percent === null) return null;
  const commission_percent = parsePercent(state.commissionText, true);
  if (commission_percent === null) return null;
  const portal_coin_bonus = parsePortalCoinBonus(state.portalCoinBonusText);
  if (portal_coin_bonus === null) return null;
  if (state.restrict && state.selectedProducts.size === 0) return null;
  return {
    code,
    creator_id: state.creatorId,
    discount_percent,
    commission_percent,
    applicable_products: applicableProducts(state.restrict, state.selectedProducts),
    expires_at: state.expiresAt ? endOfDayIso(state.expiresAt) : null,
    portal_coin_bonus,
  };
}
