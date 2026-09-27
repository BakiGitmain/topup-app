// Run with: npm run test:unit
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MAX_DISCOUNT_PERCENT, applicableProducts, endOfDayIso, parsePercent, parsePortalCoinBonus, validateCodeForm } from './discountCodeForm.ts';

describe('parsePercent', () => {
  it('a discount (allowZero=false) must be over 0', () => {
    assert.equal(parsePercent('0', false), null);
    assert.equal(parsePercent('-5', false), null);
    assert.equal(parsePercent('10', false), 10);
  });
  it('a commission (allowZero=true) may be exactly 0', () => {
    assert.equal(parsePercent('0', true), 0);
    assert.equal(parsePercent('-1', true), null);
  });
  it('caps at 100 by default for both', () => {
    assert.equal(parsePercent('100', false), 100);
    assert.equal(parsePercent('100.5', false), null);
    assert.equal(parsePercent('101', true), null);
  });
  it('an explicit max (the discount field passes MAX_DISCOUNT_PERCENT=90) is honoured, inclusive', () => {
    assert.equal(MAX_DISCOUNT_PERCENT, 90);
    assert.equal(parsePercent('90', false, MAX_DISCOUNT_PERCENT), 90);
    assert.equal(parsePercent('91', false, MAX_DISCOUNT_PERCENT), null);
    assert.equal(parsePercent('100', false, MAX_DISCOUNT_PERCENT), null);
  });
  it('junk is null, not NaN or a throw', () => {
    for (const bad of ['', 'abc', 'NaN', '1e999']) assert.equal(parsePercent(bad, true), null, bad);
  });
  it('rounds to 2 decimal places', () => {
    assert.equal(parsePercent('12.3456', true), 12.35);
  });
});

describe('parsePortalCoinBonus', () => {
  it('a whole number of at least 1 is valid', () => {
    assert.equal(parsePortalCoinBonus('2'), 2);
    assert.equal(parsePortalCoinBonus('1'), 1);
  });
  it('0, negatives, fractions and junk are invalid', () => {
    for (const bad of ['0', '-1', '2.5', '', 'abc']) assert.equal(parsePortalCoinBonus(bad), null, bad);
  });
});

describe('applicableProducts', () => {
  it('not restricted -> null (every product), regardless of what is ticked', () => {
    assert.equal(applicableProducts(false, new Set(['a', 'b'])), null);
  });
  it('restricted but nothing ticked -> null too (never an empty array -- the database forbids it)', () => {
    assert.equal(applicableProducts(true, new Set()), null);
  });
  it('restricted with ticks -> the ticked ids', () => {
    assert.deepEqual(applicableProducts(true, new Set(['a', 'b'])), ['a', 'b']);
  });
});

describe('endOfDayIso', () => {
  it('a picked date -> an ISO instant at the end of that local calendar day', () => {
    assert.equal(endOfDayIso(new Date(2026, 11, 31)), '2026-12-31T23:59:59.999Z');
  });
});

describe('validateCodeForm', () => {
  const base = { code: 'SAVE10', creatorId: 'creator-1', discountText: '10', commissionText: '5', portalCoinBonusText: '2', restrict: false, selectedProducts: new Set(), expiresAt: null };

  it('a complete, open-to-all form is valid', () => {
    const v = validateCodeForm(base);
    assert.ok(v);
    assert.equal(v.code, 'SAVE10');
    assert.equal(v.applicable_products, null);
    assert.equal(v.expires_at, null);
    assert.equal(v.portal_coin_bonus, 2);
    assert.ok(!('ok' in v), 'must not carry an extra "ok" field into the DB payload');
  });
  it('a picked expiry date is carried through as an end-of-day ISO instant', () => {
    assert.equal(validateCodeForm({ ...base, expiresAt: new Date(2026, 11, 31) })?.expires_at, '2026-12-31T23:59:59.999Z');
  });
  it('an invalid Portal Coin bonus blocks saving', () => {
    assert.equal(validateCodeForm({ ...base, portalCoinBonusText: '0' }), null);
    assert.equal(validateCodeForm({ ...base, portalCoinBonusText: '' }), null);
  });
  it('trims the code and rejects an empty one', () => {
    assert.equal(validateCodeForm({ ...base, code: '   ' }), null);
    assert.equal(validateCodeForm({ ...base, code: '  save10  ' })?.code, 'save10');
  });
  it('no creator picked -> invalid', () => {
    assert.equal(validateCodeForm({ ...base, creatorId: null }), null);
  });
  it('a 0% discount -> invalid (must be a real discount)', () => {
    assert.equal(validateCodeForm({ ...base, discountText: '0' }), null);
  });
  it('a 0% commission is fine', () => {
    assert.ok(validateCodeForm({ ...base, commissionText: '0' }));
  });
  it('a discount over 90% is invalid (a 100% code could zero out an order); a commission over 90% is still fine', () => {
    assert.equal(validateCodeForm({ ...base, discountText: '91' }), null);
    assert.equal(validateCodeForm({ ...base, discountText: '100' }), null);
    assert.ok(validateCodeForm({ ...base, discountText: '90' }));
    assert.ok(validateCodeForm({ ...base, commissionText: '95' }));
  });
  it('restrict is on but nothing ticked -> invalid, not silently "all products"', () => {
    assert.equal(validateCodeForm({ ...base, restrict: true, selectedProducts: new Set() }), null);
  });
  it('restrict is on with ticks -> valid, carries exactly those ids', () => {
    const v = validateCodeForm({ ...base, restrict: true, selectedProducts: new Set(['p1', 'p2']) });
    assert.deepEqual(v?.applicable_products, ['p1', 'p2']);
  });
});
