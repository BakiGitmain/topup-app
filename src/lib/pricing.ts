/**
 * Price display and price-input rules. Pure functions with no imports, so the
 * customer screens, the admin preview and the unit tests all run the exact same
 * code and can never disagree.
 *
 * The client only DISPLAYS prices. The database is the authority: it charges
 * its own current price and never accepts an amount from the app.
 */

export type Money = number | string | null | undefined;

/** Money as the database stores it: two decimal places. */
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Largest price an admin can enter (Br 1,000,000). */
export const MAX_PRICE = 1_000_000;

/** Turns a number, a numeric string ("70.00", "1,250.5") or nothing into a finite number, else null. */
export function toMoney(value: Money): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = value.replace(/,/g, '').trim();
  if (text === '') return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

/** "Br 55", "Br 1,250.50". Whole amounts drop the decimals. Anything unusable shows "—". */
export function formatBirr(amount: Money): string {
  const n = toMoney(amount);
  if (n === null) return '—';
  const r = round2(n);
  return `Br ${r.toLocaleString('en-US', {
    minimumFractionDigits: Number.isInteger(r) ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

export type PriceDisplay = {
  /** Current price, or null if there isn't a usable one. */
  price: number | null;
  /** Struck-through old price. Null unless it is a genuine markdown. */
  oldPrice: number | null;
  /** Whole-number percentage off (1 to 99), or null when there is no genuine discount. */
  discountPct: number | null;
};

/**
 * What to show for a package.
 *
 * The old price and the "-N%" pill appear ONLY when the old price is a real
 * number, above zero, and strictly greater than the current price, AND the
 * discount rounds to at least 1%. Otherwise the current price is shown alone:
 * no strikethrough, no badge, never "0% OFF" or "-0%".
 */
export function priceDisplay(price: Money, oldPrice: Money): PriceDisplay {
  const p0 = toMoney(price);
  if (p0 === null || p0 <= 0) return { price: null, oldPrice: null, discountPct: null };
  const p = round2(p0);

  const o0 = toMoney(oldPrice);
  if (o0 === null || o0 <= 0) return { price: p, oldPrice: null, discountPct: null };
  const o = round2(o0);
  if (!(o > p)) return { price: p, oldPrice: null, discountPct: null };

  const pct = Math.round(((o - p) / o) * 100);
  if (pct < 1) return { price: p, oldPrice: null, discountPct: null };

  // A 99.7% markdown reads as "-100%", which is never true of a real sale.
  return { price: p, oldPrice: o, discountPct: Math.min(pct, 99) };
}

/** One line of plain text, e.g. "Br 55" or "Br 55 · was Br 70 · -21%". Used for the admin's live preview. */
export function priceSummary(price: Money, oldPrice: Money): string {
  const d = priceDisplay(price, oldPrice);
  if (d.price === null) return 'No price set';
  if (d.oldPrice === null || d.discountPct === null) return formatBirr(d.price);
  return `${formatBirr(d.price)} · was ${formatBirr(d.oldPrice)} · -${d.discountPct}%`;
}

/** "Br 55", "Br 55 – Br 550", or "No prices set". Ignores unusable prices. */
export function formatPriceRange(prices: Money[]): string {
  const usable = prices.map(toMoney).filter((n): n is number => n !== null && n > 0);
  if (usable.length === 0) return 'No prices set';
  const min = Math.min(...usable);
  const max = Math.max(...usable);
  return min === max ? formatBirr(min) : `${formatBirr(min)} – ${formatBirr(max)}`;
}

export type PriceCheck =
  | { ok: true; price: number; oldPrice: number | null }
  | {
      ok: false;
      reason:
        | 'price_required'
        | 'price_not_positive'
        | 'price_too_large'
        | 'old_price_invalid'
        | 'old_price_not_above_price';
    };

/**
 * Validates what an admin typed, with the same rules the database enforces
 * (price > 0; old price, if given, strictly above the price), so the form can
 * explain the problem before the database has to refuse it.
 */
export function checkPrices(priceInput: Money, oldPriceInput: Money): PriceCheck {
  const p = toMoney(priceInput);
  if (p === null) return { ok: false, reason: 'price_required' };
  if (p <= 0) return { ok: false, reason: 'price_not_positive' };
  if (p > MAX_PRICE) return { ok: false, reason: 'price_too_large' };
  const price = round2(p);
  if (price <= 0) return { ok: false, reason: 'price_not_positive' };

  const blank = oldPriceInput === null || oldPriceInput === undefined || String(oldPriceInput).trim() === '';
  if (blank) return { ok: true, price, oldPrice: null };

  const o = toMoney(oldPriceInput);
  if (o === null || o <= 0 || o > MAX_PRICE) return { ok: false, reason: 'old_price_invalid' };
  const oldPrice = round2(o);
  if (!(oldPrice > price)) return { ok: false, reason: 'old_price_not_above_price' };
  return { ok: true, price, oldPrice };
}

/** Plain-English message for a failed check, shown under the field. */
export function priceCheckMessage(check: Extract<PriceCheck, { ok: false }>): string {
  switch (check.reason) {
    case 'price_required':
      return 'Enter a price.';
    case 'price_not_positive':
      return 'The price must be above Br 0.';
    case 'price_too_large':
      return 'That price is too large.';
    case 'old_price_invalid':
      return 'Enter the old price as a number, or leave it empty.';
    case 'old_price_not_above_price':
      return 'The old price must be higher than the selling price.';
  }
}
