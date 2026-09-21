/**
 * The birr price calculator: price = supplier cost (USD) x exchange rate x (1 + percent / 100). Pure functions with no imports.
 *
 * The exchange rate is ONE shared setting; the markup percent belongs to each PACK (default 0), so every pack is adjusted on its own.
 * The one rule that matters: a price the admin TYPED is theirs. A new rate or a press of that pack's stepper leaves the price alone
 * (the pack's percent still moves, and the screen shows what the calculator would give, with a one-tap "use it"). Only "reset" on
 * that pack brings a typed price back to the calculated value. Nothing here changes a price behind the admin's back.
 */

export const RATE_MAX = 100_000; // the same ceiling the database enforces on pricing_settings.usd_to_birr
export const PERCENT_MIN = -50;
export const PERCENT_MAX = 500;
export const PERCENT_STEP = 1;
const MAX_PRICE = 1_000_000; // the largest price the import accepts (see parsePrice)

/** The part of a pack row the calculator reads and writes. `manual` = the admin typed this price; `percent` = this pack's markup. */
export type PriceDraft = { ticked: boolean; price: string; manual?: boolean; percent?: number };

export type CostedOffer = { ref: string; cost_usd: string };

/** The shared exchange rate, or null when it is not known: prices are then left for the admin to type. */
export type Rate = number | null;

export const percentOf = (draft: { percent?: number } | undefined): number => draft?.percent ?? 0;

/** A dollar-to-birr rate typed by an admin: a positive number, at most four decimals. Null when it isn't one. */
export function parseRate(text: string): number | null {
  const value = Number(text.replace(/,/g, '').trim());
  if (text.trim() === '' || !Number.isFinite(value) || value <= 0 || value > RATE_MAX) return null;
  return Math.round(value * 10_000) / 10_000;
}

/** A percent markup typed by an admin ("10", "-5", "2.5"). Empty means 0. Null when it isn't a number in range. */
export function parsePercent(text: string): number | null {
  const trimmed = text.replace(/,/g, '').trim();
  if (trimmed === '') return 0;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < PERCENT_MIN || value > PERCENT_MAX) return null;
  return Math.round(value * 100) / 100;
}

/** One press of "+" or "-". Stays inside the allowed range and never picks up floating-point dust (2.5 + 1 is 3.5). */
export function stepPercent(current: number, direction: 1 | -1): number {
  const next = Math.round((current + direction * PERCENT_STEP) * 100) / 100;
  return Math.min(PERCENT_MAX, Math.max(PERCENT_MIN, next));
}

/**
 * The birr price for one pack, in whole birr and rounded UP, so a price is never below cost x rate x markup. Null when the
 * cost or the rate isn't usable, or the result would not be a price the import accepts.
 */
export function calcPrice(costUsd: string | number, rate: number, percent: number): number | null {
  const cost = typeof costUsd === 'number' ? costUsd : Number(costUsd);
  if (!Number.isFinite(cost) || cost <= 0 || !Number.isFinite(rate) || rate <= 0 || !Number.isFinite(percent)) return null;
  const raw = cost * rate * (1 + percent / 100);
  // 175.00000000000003 must not become 176: take off the floating-point dust before rounding up.
  const price = Math.max(1, Math.ceil(Math.round(raw * 1_000_000) / 1_000_000));
  return price > MAX_PRICE ? null : price;
}

/** The text for a pack's price field: the calculated price, or '' when there is nothing to calculate from. */
export function priceText(costUsd: string | number, rate: Rate, percent: number): string {
  if (rate === null) return '';
  const price = calcPrice(costUsd, rate, percent);
  return price === null ? '' : String(price);
}

const hasTypedPrice = (draft: PriceDraft | undefined): boolean => !!draft && draft.manual === true && draft.price.trim() !== '';
const blank = <D extends PriceDraft>(draft: D | undefined) => (draft ?? { ticked: false, price: '' }) as D;

/**
 * Ticking a pack fills in its calculated price (at the pack's own percent), unless the admin already typed one for it (then that
 * stays). Unticking changes nothing but the tick, so ticking it again brings back what was there.
 */
export function withTick<D extends PriceDraft>(draft: D | undefined, offer: CostedOffer, rate: Rate, ticked: boolean): D {
  const base = blank(draft);
  if (!ticked || hasTypedPrice(base)) return { ...base, ticked };
  const calculated = priceText(offer.cost_usd, rate, percentOf(base));
  // With no rate to calculate from, whatever is in the field stays (it may be an earlier calculated price).
  return { ...base, ticked, price: calculated === '' ? base.price : calculated, manual: false };
}

/** The admin typed in the price field. Any price they type is theirs (manual); clearing the field gives it back to the calculator. */
export function withTypedPrice<D extends PriceDraft>(draft: D | undefined, text: string): D {
  return { ...blank(draft), price: text, manual: text.trim() !== '' };
}

/**
 * This pack's markup changed (its stepper or its percent box). The price follows, UNLESS the admin typed it: then only the percent
 * moves, and the price stays exactly as typed.
 */
export function withPercent<D extends PriceDraft>(draft: D | undefined, offer: CostedOffer, rate: Rate, percent: number): D {
  const base = { ...blank(draft), percent };
  if (hasTypedPrice(base)) return base;
  const calculated = priceText(offer.cost_usd, rate, percent);
  return calculated === '' ? base : { ...base, price: calculated, manual: false };
}

/** One press of this pack's "+" or "-". */
export function withStep<D extends PriceDraft>(draft: D | undefined, offer: CostedOffer, rate: Rate, direction: 1 | -1): D {
  return withPercent(draft, offer, rate, stepPercent(percentOf(draft), direction));
}

/** "Use it" on one pack: back to the calculated price at the pack's own percent. Nothing else changes. */
export function withReset<D extends PriceDraft>(draft: D | undefined, offer: CostedOffer, rate: Rate): D {
  const base = blank(draft);
  const calculated = priceText(offer.cost_usd, rate, percentOf(base));
  return calculated === '' ? base : { ...base, price: calculated, manual: false };
}

/** True when the pack shows a price different from what the calculator gives it now (at its own percent). */
export function differsFromCalculated(draft: PriceDraft | undefined, offer: CostedOffer, rate: Rate): boolean {
  if (!draft || draft.price.trim() === '') return false;
  const calculated = priceText(offer.cost_usd, rate, percentOf(draft));
  return calculated !== '' && Number(draft.price.replace(/,/g, '')) !== Number(calculated);
}

export type Recalc<D> = { drafts: Record<string, D>; changed: number; kept: number };

/**
 * The shared rate changed: recalculates every TICKED pack of one region at its OWN percent. A price the admin typed is kept (and
 * counted in `kept`). Unticked packs are not touched.
 */
export function recalcDrafts<D extends PriceDraft>(drafts: Record<string, D>, offers: readonly CostedOffer[], rate: Rate): Recalc<D> {
  if (rate === null) return { drafts, changed: 0, kept: 0 };
  const out: Record<string, D> = { ...drafts };
  let changed = 0;
  let kept = 0;
  for (const offer of offers) {
    const draft = drafts[offer.ref];
    if (!draft || !draft.ticked) continue;
    if (hasTypedPrice(draft)) {
      kept++;
      continue;
    }
    const calculated = priceText(offer.cost_usd, rate, percentOf(draft));
    if (calculated === '') continue;
    if (calculated !== draft.price) changed++;
    out[offer.ref] = { ...draft, price: calculated, manual: false };
  }
  return { drafts: out, changed, kept };
}

/**
 * The markup a saved price already contains, for the edit screen (a saved pack has no stored percent): (price / (cost x rate) - 1),
 * as a percent with two decimals. Null when there is no usable cost, rate or price.
 */
export function impliedPercent(price: number, costUsd: string | number, rate: Rate): number | null {
  const cost = typeof costUsd === 'number' ? costUsd : Number(costUsd);
  if (rate === null || !Number.isFinite(price) || price <= 0 || !Number.isFinite(cost) || cost <= 0) return null;
  return Math.round((price / (cost * rate) - 1) * 10_000) / 100;
}
