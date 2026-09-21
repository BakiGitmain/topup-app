// Run with: npm run test:unit
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { checkoutGate, cartCount, cartTotal, clampQuantity, firstProblem, idsToDrop } from './cartLogic.ts';
import { parseCheckoutError, problemKind, splitFailures } from './checkoutErrors.ts';
import { normalizeReference } from '../../supabase/functions/_shared/shegerpay.ts';
import { amountToSend, cleanReference, isProviderId, nextStep, parseVerifyAnswer } from './paymentView.ts';
import { parseStoredOrderId, pendingOrderKey, pickResumeOrder } from './resume.ts';

const ID1 = '11111111-2222-3333-4444-555555555555';
const ID2 = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

describe('cart maths', () => {
  it('quantities are whole numbers from 1 to 20', () => {
    assert.equal(clampQuantity(0), 1);
    assert.equal(clampQuantity(-4), 1);
    assert.equal(clampQuantity(3.9), 3);
    assert.equal(clampQuantity(99), 20);
    for (const bad of [NaN, Infinity, -Infinity, undefined]) assert.equal(clampQuantity(bad), 1);
  });
  it('the total counts only lines that can be bought, and keeps cents exact', () => {
    const lines = [{ unitPrice: 0.1, quantity: 3, available: true }, { unitPrice: 165.5, quantity: 2, available: true }, { unitPrice: 999, quantity: 1, available: false }];
    assert.equal(cartTotal(lines), 331.3);
    assert.equal(cartTotal([]), 0);
    assert.equal(cartTotal([{ unitPrice: 0.1 + 0.2, quantity: 1, available: true }]), 0.3);
  });
  it('the badge counts every unit', () => {
    assert.equal(cartCount([{ quantity: 2 }, { quantity: 1 }, { quantity: 4 }]), 7);
    assert.equal(cartCount([]), 0);
  });
});

describe('the checkout gate: every line needs its own valid ID', () => {
  const line = (id, blocker = null, available = true) => ({ id, name: `Game ${id}`, available, blocker });
  it('an empty cart cannot check out', () => assert.deepEqual(checkoutGate([]), { canCheckout: false, problems: [] }));
  it('all lines ready: checkout is on', () => assert.equal(checkoutGate([line('a'), line('b')]).canCheckout, true));
  it('ONE line with an unvalidated / invalid / expired ID blocks it, and NAMES that line', () => {
    for (const blocker of ['checking', 'invalid_id', 'check_expired', 'check_failed', 'fill_fields', 'confirm_id']) {
      const g = checkoutGate([line('a'), line('b', blocker), line('c')]);
      assert.equal(g.canCheckout, false, blocker);
      assert.deepEqual(g.problems, [{ lineId: 'b', name: 'Game b', problem: blocker }], blocker);
    }
  });
  it('an unavailable line blocks it too', () => {
    const g = checkoutGate([line('a'), line('b', null, false)]);
    assert.deepEqual([g.canCheckout, g.problems[0].lineId, g.problems[0].problem], [false, 'b', 'unavailable']);
  });
  it('every bad line is listed, in cart order, and the first is what to scroll to', () => {
    const g = checkoutGate([line('a', 'invalid_id'), line('b'), line('c', 'check_expired')]);
    assert.deepEqual(g.problems.map((p) => p.lineId), ['a', 'c']);
    assert.equal(firstProblem(g).lineId, 'a');
    assert.equal(firstProblem(checkoutGate([line('a')])), null);
  });
  it('lines to drop after a refusal are exactly the unavailable ones', () => {
    assert.deepEqual(idsToDrop([{ itemId: 'a', unavailable: true }, { itemId: 'b', unavailable: false }, { itemId: 'c', unavailable: true }]), ['a', 'c']);
  });
});

describe('parseCheckoutError', () => {
  const err = (message, details = '') => ({ message, details });
  it('an unpaid order already exists: tells the app which one to resume', () => {
    assert.deepEqual(parseCheckoutError(err('pending_order_exists', ID1)), { kind: 'pending_order_exists', orderId: ID1 });
    assert.deepEqual(parseCheckoutError(err('pending_order_exists', ID2.toUpperCase())), { kind: 'pending_order_exists', orderId: ID2 });
  });
  it('...but never trusts a malformed id', () => {
    for (const bad of ['', 'nope', ID1 + 'x', "'; drop table orders;--"]) assert.deepEqual(parseCheckoutError(err('pending_order_exists', bad)), { kind: 'other' });
  });
  it('an empty cart, and a signed-out user', () => {
    assert.deepEqual(parseCheckoutError(err('cart_empty')), { kind: 'cart_empty' });
    assert.deepEqual(parseCheckoutError(err('not_authenticated')), { kind: 'not_signed_in' });
  });
  it('unavailable lines: exactly which, and why', () => {
    const detail = JSON.stringify([
      { item_id: 'i1', option_id: 'o1', product_name: 'PUBG', label: '60 UC', problem: 'product_off' },
      { item_id: 'i2', option_id: 'o2', product_name: 'Free Fire', label: '110 Diamonds', problem: 'id_validation_expired' },
    ]);
    const r = parseCheckoutError(err('cart_unavailable', detail));
    assert.equal(r.kind, 'cart_unavailable');
    assert.deepEqual(r.failures.map((f) => [f.itemId, f.productName, f.label, f.problem]), [['i1', 'PUBG', '60 UC', 'product_off'], ['i2', 'Free Fire', '110 Diamonds', 'id_validation_expired']]);
  });
  it('an unknown problem word is kept as "unknown", never dropped or trusted', () => {
    const r = parseCheckoutError(err('cart_unavailable', JSON.stringify([{ item_id: 'i1', problem: 'brand_new_thing' }])));
    assert.equal(r.failures[0].problem, 'unknown');
  });
  it('garbage details are "other", not a crash', () => {
    for (const details of ['', 'not json', '{"a":1}', '[]', '[{"nothing":1}]']) assert.deepEqual(parseCheckoutError(err('cart_unavailable', details)), { kind: 'other' }, details);
    for (const e of [null, undefined, {}, { message: 5 }, new Error('fetch failed')]) assert.deepEqual(parseCheckoutError(e), { kind: 'other' });
  });
  it('splits into lines to DROP (no longer sold) and lines to FIX (their ID)', () => {
    const { failures } = parseCheckoutError(err('cart_unavailable', JSON.stringify([
      { item_id: 'a', problem: 'pack_off' }, { item_id: 'b', problem: 'region_off' }, { item_id: 'c', problem: 'product_off' },
      { item_id: 'd', problem: 'id_not_validated' }, { item_id: 'e', problem: 'region_mismatch' }, { item_id: 'f', problem: 'id_check_required' },
    ])));
    const { drop, fix } = splitFailures(failures);
    assert.deepEqual(drop.map((f) => f.itemId), ['a', 'b', 'c']);
    assert.deepEqual(fix.map((f) => f.itemId), ['d', 'e', 'f']);
    assert.equal(problemKind('pack_off'), 'unavailable');
    assert.equal(problemKind('id_validation_expired'), 'id');
  });
});

describe('the verify-payment answer', () => {
  it('reads every result the function can send', () => {
    for (const result of ['paid', 'already_paid', 'closed', 'mismatch', 'not_verified', 'reference_used', 'in_progress', 'unavailable', 'not_found']) {
      assert.equal(parseVerifyAnswer({ result }).result, result);
    }
  });
  it('anything unexpected is "unavailable", NEVER paid', () => {
    for (const bad of [null, undefined, 'paid', 5, [], {}, { result: 'PAID' }, { result: 'success' }, { status: 'paid' }, { result: true }]) {
      assert.equal(parseVerifyAnswer(bad).result, 'unavailable', JSON.stringify(bad));
    }
  });
  it('keeps the status and a known reason, drops an unknown one', () => {
    assert.deepEqual(parseVerifyAnswer({ result: 'not_verified', status: 'pending_payment', reason: 'not_found' }), { result: 'not_verified', status: 'pending_payment', reason: 'not_found' });
    assert.equal(parseVerifyAnswer({ result: 'not_verified', reason: 'made up' }).reason, undefined);
  });
  it('what the screen does with each result', () => {
    assert.deepEqual(nextStep({ result: 'paid' }), { action: 'paid' });
    assert.deepEqual(nextStep({ result: 'already_paid' }), { action: 'paid' });
    assert.deepEqual(nextStep({ result: 'mismatch' }), { action: 'mismatch' });
    assert.deepEqual(nextStep({ result: 'closed', status: 'paid' }), { action: 'paid' });
    assert.deepEqual(nextStep({ result: 'closed', status: 'payment_mismatch' }), { action: 'mismatch' });
    assert.deepEqual(nextStep({ result: 'closed', status: 'cancelled' }), { action: 'closed', status: 'cancelled' });
    assert.deepEqual(nextStep({ result: 'reference_used' }), { action: 'reference_used' });
    assert.deepEqual(nextStep({ result: 'in_progress' }), { action: 'wait' });
    assert.deepEqual(nextStep({ result: 'unavailable' }), { action: 'try_later' });
    assert.deepEqual(nextStep({ result: 'not_found' }), { action: 'try_later' });
    assert.deepEqual(nextStep({ result: 'not_verified', reason: 'not_found' }), { action: 'fix_reference', messageKey: 'pay.notVerified.not_found' });
    assert.deepEqual(nextStep({ result: 'not_verified' }), { action: 'fix_reference', messageKey: 'pay.notVerified.unknown' });
  });
  it('only "paid" and "already_paid" ever lead to a success screen', () => {
    for (const result of ['closed', 'mismatch', 'not_verified', 'reference_used', 'in_progress', 'unavailable', 'not_found']) {
      assert.notEqual(nextStep({ result }).action, 'paid', result);
    }
  });
});

describe('providers and the amount to send', () => {
  it('only Telebirr and CBE', () => {
    assert.equal(isProviderId('telebirr'), true);
    assert.equal(isProviderId('cbe'), true);
    for (const bad of ['awash', 'CBE', '', null, 7]) assert.equal(isProviderId(bad), false);
  });
  it('shows the exact amount', () => {
    assert.equal(amountToSend(790), 'Br 790');
    assert.equal(amountToSend(1250), 'Br 1,250');
    assert.equal(amountToSend(1234567), 'Br 1,234,567');
    assert.equal(amountToSend(165.5), 'Br 165.50');
    assert.equal(amountToSend(0.3), 'Br 0.30');
  });
});

describe('the reference cleaner matches the server exactly', () => {
  it('gives the same answer as the server for a wide set of inputs (so a reference the app accepts is one the server accepts)', () => {
    const samples = ['ft24352648751234', ' FT 2435 2648 ', 'cbt-12_ab', 'FT\n123\t456', '', '   ', 'abc', 'ab12', 'a'.repeat(64), 'a'.repeat(65), 'FT12345!', 'FT/12345', 'https://x.test/FT123456', "FT123'456", null, undefined, 123456, {}, 'ፊት12345', 'FT 12', 'ÀFT1234', 'ft-1', '__--', '1234'];
    for (const s of samples) assert.equal(cleanReference(s), normalizeReference(s), String(s));
  });
});

describe('crash recovery: which unpaid order to go back to', () => {
  it('a stored order still awaiting payment is resumed, and kept', () => {
    assert.deepEqual(pickResumeOrder(ID1, [{ id: ID1 }]), { orderId: ID1, clearStored: false });
  });
  it('the app crashed right after checkout, before storing: the database still knows the order', () => {
    assert.deepEqual(pickResumeOrder(null, [{ id: ID1 }]), { orderId: ID1, clearStored: false });
  });
  it('a stored order that was paid, cancelled or is under review is stale: cleared, and nothing to resume', () => {
    assert.deepEqual(pickResumeOrder(ID1, []), { orderId: null, clearStored: true });
  });
  it('a stale stored id does not hide a different awaiting order', () => {
    assert.deepEqual(pickResumeOrder(ID1, [{ id: ID2 }]), { orderId: ID2, clearStored: true });
  });
  it('nothing stored and nothing awaiting: nothing to do', () => {
    assert.deepEqual(pickResumeOrder(null, []), { orderId: null, clearStored: false });
  });
  it('ids compare case-insensitively', () => {
    assert.deepEqual(pickResumeOrder(ID2.toUpperCase(), [{ id: ID2 }]), { orderId: ID2, clearStored: false });
  });
  it('it never returns an id the database did not list (a stored id alone is never enough)', () => {
    for (const stored of [ID1, ID2, null]) assert.equal(pickResumeOrder(stored, []).orderId, null);
  });
  it('a stored value is only used if it is a UUID', () => {
    assert.equal(parseStoredOrderId(ID1), ID1);
    assert.equal(parseStoredOrderId(` ${ID2.toUpperCase()} `), ID2);
    for (const bad of [null, undefined, '', 'nope', 5, {}, ID1 + '0', "1' or '1'='1"]) assert.equal(parseStoredOrderId(bad), null, String(bad));
  });
  it('the storage key is per customer, so two people on one phone never see each other\'s order', () => {
    assert.notEqual(pendingOrderKey('user-a'), pendingOrderKey('user-b'));
    assert.match(pendingOrderKey('u'), /^pendingOrder:v1:/);
  });
});
