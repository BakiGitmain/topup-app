// Run with: npm run test:unit
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseCheckoutError } from './checkoutErrors.ts';

const dbError = (message, details) => ({ message, details });

describe('parseCheckoutError: discount codes', () => {
  it('code_not_found', () => {
    assert.deepEqual(parseCheckoutError(dbError('code_not_found')), { kind: 'code_not_found' });
  });
  it('code_inactive', () => {
    assert.deepEqual(parseCheckoutError(dbError('code_inactive')), { kind: 'code_inactive' });
  });
  it('code_expired', () => {
    assert.deepEqual(parseCheckoutError(dbError('code_expired')), { kind: 'code_expired' });
  });
  it('code_not_applicable', () => {
    assert.deepEqual(parseCheckoutError(dbError('code_not_applicable')), { kind: 'code_not_applicable' });
  });
  it('code_already_used', () => {
    assert.deepEqual(parseCheckoutError(dbError('code_already_used')), { kind: 'code_already_used' });
  });
  it('is checked ahead of cart_unavailable (no accidental substring collision)', () => {
    assert.equal(parseCheckoutError(dbError('code_not_found')).kind, 'code_not_found');
  });
  it('an unrecognised message is "other"', () => {
    assert.deepEqual(parseCheckoutError(dbError('something_else')), { kind: 'other' });
  });
  it('a non-error value is "other", not a throw', () => {
    assert.deepEqual(parseCheckoutError(null), { kind: 'other' });
    assert.deepEqual(parseCheckoutError(undefined), { kind: 'other' });
  });
});

describe('parseCheckoutError: wheel prizes', () => {
  it('wheel_prize_not_found', () => {
    assert.deepEqual(parseCheckoutError(dbError('wheel_prize_not_found')), { kind: 'wheel_prize_not_found' });
  });
  it('wheel_prize_unavailable', () => {
    assert.deepEqual(parseCheckoutError(dbError('wheel_prize_unavailable')), { kind: 'wheel_prize_unavailable' });
  });
  it('multiple_discounts_not_allowed', () => {
    assert.deepEqual(parseCheckoutError(dbError('multiple_discounts_not_allowed')), { kind: 'multiple_discounts_not_allowed' });
  });
});

describe('parseCheckoutError: existing kinds still work alongside the new ones', () => {
  it('cart_empty', () => {
    assert.deepEqual(parseCheckoutError(dbError('cart_empty')), { kind: 'cart_empty' });
  });
  it('not_authenticated', () => {
    assert.deepEqual(parseCheckoutError(dbError('not_authenticated')), { kind: 'not_signed_in' });
  });
  it('pending_order_exists with a valid uuid detail', () => {
    const id = '11111111-1111-1111-1111-111111111111';
    assert.deepEqual(parseCheckoutError(dbError('pending_order_exists', id)), { kind: 'pending_order_exists', orderId: id });
  });
});
