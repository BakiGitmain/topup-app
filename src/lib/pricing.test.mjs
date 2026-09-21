// Run with: npm run test:unit   (Node's built-in test runner). Plain JS on purpose.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  checkPrices,
  formatBirr,
  formatPriceRange,
  MAX_PRICE,
  priceDisplay,
  priceSummary,
  toMoney,
} from './pricing.ts';

const NONE = { oldPrice: null, discountPct: null };

describe('priceDisplay: when is a discount shown?', () => {
  it('old_price null -> price alone', () => {
    assert.deepEqual(priceDisplay(55, null), { price: 55, ...NONE });
  });
  it('old_price undefined -> price alone', () => {
    assert.deepEqual(priceDisplay(55, undefined), { price: 55, ...NONE });
  });
  it('old_price 0 -> price alone, never "-100%"', () => {
    assert.deepEqual(priceDisplay(55, 0), { price: 55, ...NONE });
  });
  it('old_price negative -> price alone', () => {
    assert.deepEqual(priceDisplay(55, -10), { price: 55, ...NONE });
  });
  it('old_price equal to price -> price alone, no "0% OFF"', () => {
    assert.deepEqual(priceDisplay(55, 55), { price: 55, ...NONE });
  });
  it('old_price below price -> price alone (never a negative discount)', () => {
    assert.deepEqual(priceDisplay(55, 40), { price: 55, ...NONE });
  });
  it('old_price above price -> struck-through old price and the percentage', () => {
    assert.deepEqual(priceDisplay(55, 70), { price: 55, oldPrice: 70, discountPct: 21 });
  });
  it('the percentage is a rounded whole number: (70-55)/70 = 21.43 -> 21', () => {
    assert.equal(priceDisplay(55, 70).discountPct, 21);
  });
  it('rounds half up: (200-150)/200 = 25 exactly', () => {
    assert.equal(priceDisplay(150, 200).discountPct, 25);
  });
  it('a markdown that rounds to 0% is not shown at all ("0% OFF" is forbidden)', () => {
    assert.deepEqual(priceDisplay(999.9, 1000), { price: 999.9, ...NONE });
    assert.deepEqual(priceDisplay(995.5, 1000), { price: 995.5, ...NONE }); // 0.45% rounds to 0
    assert.deepEqual(priceDisplay(995, 1000), { price: 995, oldPrice: 1000, discountPct: 1 }); // 0.5% rounds up to 1
  });
  it('never shows 100%: a 99.9% markdown is capped at -99%', () => {
    assert.equal(priceDisplay(1, 5000).discountPct, 99);
  });
  it('10% off', () => {
    assert.deepEqual(priceDisplay(90, 100), { price: 90, oldPrice: 100, discountPct: 10 });
  });
});

describe('priceDisplay: bad input never produces NaN, -0 or garbage', () => {
  const noPrice = { price: null, oldPrice: null, discountPct: null };
  for (const [name, price, old] of [
    ['price null', null, 70],
    ['price undefined', undefined, 70],
    ['price 0', 0, 70],
    ['price negative', -5, 70],
    ['price NaN', NaN, 70],
    ['price Infinity', Infinity, 70],
    ['price empty string', '', 70],
    ['price not a number', 'abc', 70],
  ]) {
    it(`${name} -> no price, no discount`, () => {
      assert.deepEqual(priceDisplay(price, old), noPrice);
    });
  }
  it('old_price NaN -> price alone', () => {
    assert.deepEqual(priceDisplay(55, NaN), { price: 55, ...NONE });
  });
  it('old_price Infinity -> price alone', () => {
    assert.deepEqual(priceDisplay(55, Infinity), { price: 55, ...NONE });
  });
  it('old_price garbage string -> price alone', () => {
    assert.deepEqual(priceDisplay(55, 'soon'), { price: 55, ...NONE });
  });
  it('no result is ever NaN, -0 or infinite', () => {
    const values = [null, undefined, 0, -0, -1, 1, 55, 70, NaN, Infinity, -Infinity, '', ' ', '55', '70.00', 'x', 1e12];
    for (const p of values) {
      for (const o of values) {
        const d = priceDisplay(p, o);
        for (const n of [d.price, d.oldPrice, d.discountPct]) {
          if (n === null) continue;
          assert.ok(Number.isFinite(n), `non-finite for ${String(p)} / ${String(o)}`);
          assert.ok(!Object.is(n, -0), `negative zero for ${String(p)} / ${String(o)}`);
        }
        if (d.discountPct !== null) {
          assert.ok(d.discountPct >= 1 && d.discountPct <= 99, `pct out of range for ${String(p)} / ${String(o)}`);
          assert.ok(d.oldPrice !== null && d.price !== null && d.oldPrice > d.price);
        } else {
          assert.equal(d.oldPrice, null, 'an old price is never shown without a percentage');
        }
      }
    }
  });
});

describe('priceDisplay: numbers that arrive as text (PostgREST returns numeric as a string sometimes)', () => {
  it('"70.00" and "55.00"', () => {
    assert.deepEqual(priceDisplay('55.00', '70.00'), { price: 55, oldPrice: 70, discountPct: 21 });
  });
  it('thousands separators', () => {
    assert.deepEqual(priceDisplay('1,000', '1,250'), { price: 1000, oldPrice: 1250, discountPct: 20 });
  });
  it('floating-point noise is rounded away (0.1 + 0.2)', () => {
    assert.equal(priceDisplay(0.1 + 0.2, 1).price, 0.3);
  });
});

describe('formatBirr', () => {
  it('whole amounts have no decimals', () => {
    assert.equal(formatBirr(55), 'Br 55');
    assert.equal(formatBirr(0), 'Br 0');
    assert.equal(formatBirr(1000), 'Br 1,000');
  });
  it('fractions have exactly two', () => {
    assert.equal(formatBirr(1250.5), 'Br 1,250.50');
    assert.equal(formatBirr(0.1 + 0.2), 'Br 0.30');
  });
  it('rounds to two places, and a rounded-up whole number drops its decimals', () => {
    assert.equal(formatBirr(54.999), 'Br 55');
    assert.equal(formatBirr('99.999'), 'Br 100');
  });
  it('unusable values show a dash, never "Br NaN"', () => {
    for (const v of [null, undefined, NaN, Infinity, '', 'abc']) assert.equal(formatBirr(v), '—');
  });
  it('accepts numeric strings', () => {
    assert.equal(formatBirr('165.00'), 'Br 165');
  });
});

describe('formatPriceRange', () => {
  it('none -> "No prices set"', () => {
    assert.equal(formatPriceRange([]), 'No prices set');
    assert.equal(formatPriceRange([null, undefined, 0, NaN]), 'No prices set');
  });
  it('one price', () => {
    assert.equal(formatPriceRange([55]), 'Br 55');
  });
  it('several equal prices collapse to one', () => {
    assert.equal(formatPriceRange([55, 55]), 'Br 55');
  });
  it('a range, low to high, whatever the order', () => {
    assert.equal(formatPriceRange([550, 55, 165]), 'Br 55 – Br 550');
  });
  it('ignores unusable prices', () => {
    assert.equal(formatPriceRange([null, 55, 'x', 550]), 'Br 55 – Br 550');
  });
});

describe('priceSummary (the admin preview line)', () => {
  it('plain price', () => {
    assert.equal(priceSummary(55, null), 'Br 55');
  });
  it('markdown', () => {
    assert.equal(priceSummary(55, 70), 'Br 55 · was Br 70 · -21%');
  });
  it('no price', () => {
    assert.equal(priceSummary(null, 70), 'No price set');
  });
  it('an old price that is not a markdown is left out', () => {
    assert.equal(priceSummary(55, 55), 'Br 55');
    assert.equal(priceSummary(55, 0), 'Br 55');
  });
  it('agrees with priceDisplay by construction', () => {
    for (const [p, o] of [[55, 70], [55, 55], [55, 40], [90, 100], [1, 5000], [999.9, 1000]]) {
      const d = priceDisplay(p, o);
      assert.equal(priceSummary(p, o).includes('%'), d.discountPct !== null);
    }
  });
});

describe('checkPrices: the same rules the database enforces', () => {
  it('a price alone is fine', () => {
    assert.deepEqual(checkPrices('55', ''), { ok: true, price: 55, oldPrice: null });
    assert.deepEqual(checkPrices(55, null), { ok: true, price: 55, oldPrice: null });
  });
  it('a proper old price is fine', () => {
    assert.deepEqual(checkPrices('55', '70'), { ok: true, price: 55, oldPrice: 70 });
  });
  it('rounds to two decimals', () => {
    assert.deepEqual(checkPrices('55.126', ''), { ok: true, price: 55.13, oldPrice: null });
  });
  it('missing price', () => {
    assert.deepEqual(checkPrices('', ''), { ok: false, reason: 'price_required' });
    assert.deepEqual(checkPrices('abc', ''), { ok: false, reason: 'price_required' });
  });
  it('zero and negative prices are refused', () => {
    assert.deepEqual(checkPrices('0', ''), { ok: false, reason: 'price_not_positive' });
    assert.deepEqual(checkPrices('-5', ''), { ok: false, reason: 'price_not_positive' });
    assert.deepEqual(checkPrices('0.001', ''), { ok: false, reason: 'price_not_positive' });
  });
  it('absurd prices are refused', () => {
    assert.deepEqual(checkPrices(MAX_PRICE + 1, ''), { ok: false, reason: 'price_too_large' });
    assert.equal(checkPrices(MAX_PRICE, '').ok, true);
  });
  it('old price equal to or below the price is refused (matches the database CHECK)', () => {
    assert.deepEqual(checkPrices('55', '55'), { ok: false, reason: 'old_price_not_above_price' });
    assert.deepEqual(checkPrices('55', '40'), { ok: false, reason: 'old_price_not_above_price' });
  });
  it('old price that is not a positive number is refused', () => {
    assert.deepEqual(checkPrices('55', 'abc'), { ok: false, reason: 'old_price_invalid' });
    assert.deepEqual(checkPrices('55', '0'), { ok: false, reason: 'old_price_invalid' });
    assert.deepEqual(checkPrices('55', '-3'), { ok: false, reason: 'old_price_invalid' });
  });
  it('anything checkPrices accepts is also shown correctly by priceDisplay', () => {
    const c = checkPrices('55', '70');
    assert.ok(c.ok);
    if (c.ok) assert.equal(priceDisplay(c.price, c.oldPrice).discountPct, 21);
  });
});

describe('toMoney', () => {
  it('parses what it should', () => {
    assert.equal(toMoney(5), 5);
    assert.equal(toMoney('5.5'), 5.5);
    assert.equal(toMoney(' 1,250.50 '), 1250.5);
  });
  it('rejects what it should', () => {
    for (const v of [null, undefined, '', '  ', 'x', NaN, Infinity, -Infinity]) assert.equal(toMoney(v), null);
  });
});
