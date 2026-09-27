// Run with: npm run test:unit
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { attemptText, classifyOrderQuery, fulfilmentOf, idStartsWith, paymentMethodOf, receiptAvailable, shortOrderId, verificationOf } from './orderView.ts';

describe('verificationOf: a verified purchase vs a self-declared one', () => {
  it('a validation record means validated, with what was checked', () => {
    assert.deepEqual(verificationOf({ validation_id: 'v1', validated_account_region: 'ME', validated_player_name: 'ᴹᴿ᭄༄' }),
      { kind: 'validated', recordId: 'v1', playerName: 'ᴹᴿ᭄༄', accountRegion: 'ME' });
  });
  it('a validated order with no name or region still says validated', () => {
    assert.deepEqual(verificationOf({ validation_id: 'v1' }), { kind: 'validated', recordId: 'v1', playerName: null, accountRegion: null });
  });
  it('the tick means self-declared, with the time', () => {
    assert.deepEqual(verificationOf({ id_self_declared_at: '2026-09-24T10:00:00Z' }), { kind: 'self_declared', at: '2026-09-24T10:00:00Z' });
  });
  it('a validation record wins over a tick', () => {
    assert.equal(verificationOf({ validation_id: 'v1', id_self_declared_at: '2026-09-24T10:00:00Z' }).kind, 'validated');
  });
  it('old orders and orders with nothing to check say none', () => {
    for (const o of [{}, { validation_id: null }, { validation_id: null, id_self_declared_at: null }, { validation_id: '' }]) {
      assert.deepEqual(verificationOf(o), { kind: 'none' });
    }
  });
});


describe('receipts: which orders have one, and the words on it', () => {
  it('only orders whose money was received', () => {
    for (const s of ['paid', 'pending', 'processing', 'completed', 'failed', 'refunded']) assert.equal(receiptAvailable(s), true, s);
    for (const s of ['pending_payment', 'payment_mismatch', 'cancelled']) assert.equal(receiptAvailable(s), false, s);
  });
  it('how it was paid', () => {
    assert.equal(paymentMethodOf({ payment_provider: 'telebirr' }), 'telebirr');
    assert.equal(paymentMethodOf({ payment_provider: 'cbe' }), 'cbe');
    assert.equal(paymentMethodOf({ payment_provider: 'wallet' }), 'wallet');
    for (const v of [null, undefined, '', 'mpesa']) assert.equal(paymentMethodOf({ payment_provider: v }), null);
    assert.equal(paymentMethodOf({}), null);
  });
  it('the short order id customers and admins quote', () => assert.equal(shortOrderId('1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d'), '#1A2B3C4D'));
});

describe('the admin payment trail', () => {
  it('says what happened in plain words, flags the test key, and shows the amount found', () => {
    assert.equal(attemptText({ outcome: 'paid', verified_amount: '500.00', mode: 'live' }), 'Verified, amount matched · found Br 500');
    assert.match(attemptText({ outcome: 'mismatch', verified_amount: 450, mode: 'test' }), /WRONG amount .* found Br 450 · TEST KEY/);
    assert.equal(attemptText({ outcome: 'not_verified', verified_amount: null, mode: null }), 'Not found / not verified');
    assert.equal(attemptText({ outcome: 'unavailable', verified_amount: null, mode: 'live' }), 'Could not reach ShegerPay');
    assert.equal(attemptText({ outcome: 'weird', verified_amount: null, mode: null }), 'weird');
  });
});

describe('the fulfilment slot', () => {
  it('carries a real delivery status through the whole funnel', () => {
    assert.deepEqual(fulfilmentOf('pending').steps.map((s) => s.state), ['done', 'current', 'todo']);
    assert.deepEqual(fulfilmentOf('processing').steps.map((s) => s.state), ['done', 'done', 'todo']);
    assert.deepEqual(fulfilmentOf('completed').steps.map((s) => s.state), ['done', 'done', 'done']);
  });
  it('a "paid" order (bank transfer or instant wallet payment) is the same starting point as "pending" (2026-09-23 fix: it used to have no delivery status at all)', () => {
    assert.deepEqual(fulfilmentOf('paid'), fulfilmentOf('pending'));
    assert.deepEqual(fulfilmentOf('paid').steps.map((s) => s.state), ['done', 'current', 'todo']);
  });
  it('anything else has NO delivery status, and says so instead of inventing one', () => {
    for (const s of ['pending_payment', 'payment_mismatch', 'cancelled', 'failed', 'refunded']) assert.deepEqual(fulfilmentOf(s), { tracked: false, steps: [] }, s);
  });
});

describe('the admin order search understands ids and references', () => {
  const id = '1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d';
  it('a full id, the short form, and the start of an id', () => {
    assert.deepEqual(classifyOrderQuery(id), { uuid: id, prefix: id.replace(/-/g, ''), reference: id.toUpperCase() });
    assert.equal(classifyOrderQuery('#1A2B3C4D')?.prefix, '1a2b3c4d');
    assert.equal(classifyOrderQuery(' 1a2b3c4d ')?.prefix, '1a2b3c4d');
    assert.equal(classifyOrderQuery('1a2b3c4d-5e6f')?.prefix, '1a2b3c4d5e6f');
  });
  it('a bank transaction number is a reference, not an id', () => {
    assert.deepEqual(classifyOrderQuery('ft24352648751234'), { uuid: null, prefix: null, reference: 'FT24352648751234' });
  });
  it('hex-looking short text could be either, so both are searched', () => {
    const q = classifyOrderQuery('1A2B3C4D');
    assert.equal(q.prefix, '1a2b3c4d');
    assert.equal(q.reference, '1A2B3C4D');
  });
  it('too short, junk, or hostile text finds nothing and never reaches the database', () => {
    for (const bad of ['', '  ', 'ab', '#12', "x'; drop table orders;--", 'a b c', '%%%%%', 'x'.repeat(65), null, undefined]) assert.equal(classifyOrderQuery(bad), null, String(bad));
  });
  it('idStartsWith ignores dashes and case', () => {
    assert.equal(idStartsWith(id, '1A2B3C4D'), true);
    assert.equal(idStartsWith(id, '1a2b3c4d5e6f'), true);
    assert.equal(idStartsWith(id, '2b3c'), false);
  });
});
