// Run with: npm run test:unit. No network: ShegerPay is always faked.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PROVIDERS, amountsEqual, classifyHttp, decidePayment, isProvider, normalizeReference, parseVerification, reasonCategory } from './shegerpay.ts';

describe('providers', () => {
  it('only Telebirr and CBE, in the exact lower-case values ShegerPay takes', () => {
    assert.deepEqual([...PROVIDERS], ['telebirr', 'cbe']);
    for (const ok of ['telebirr', 'cbe']) assert.equal(isProvider(ok), true);
    for (const bad of ['CBE', 'Telebirr', 'awash', 'boa', 'mpesa', '', null, undefined, 5]) assert.equal(isProvider(bad), false, String(bad));
  });
});

describe('normalizeReference', () => {
  it('upper-cases and removes spaces, so the same transfer is always the same key', () => {
    assert.equal(normalizeReference('ft24352648751234'), 'FT24352648751234');
    assert.equal(normalizeReference('  FT 2435 2648  '), 'FT24352648');
    assert.equal(normalizeReference('cbt-12_ab'), 'CBT-12_AB');
    assert.equal(normalizeReference('FT\n123\t456'), 'FT123456');
  });
  it('refuses anything that is not a plausible reference', () => {
    for (const bad of ['', '   ', 'abc', 'FT 1', 'a'.repeat(65), 'FT12345!', 'FT/12345', 'https://x.test/FT123456', "FT123'456", null, undefined, 123456, {}]) {
      assert.equal(normalizeReference(bad), null, String(bad));
    }
  });
  it('accepts the shortest and longest allowed', () => {
    assert.equal(normalizeReference('ab12'), 'AB12');
    assert.equal(normalizeReference('a'.repeat(64)), 'A'.repeat(64));
  });
});

describe('amountsEqual (whole cents)', () => {
  it('equal money is equal, float noise is not', () => {
    assert.equal(amountsEqual(100, 100), true);
    assert.equal(amountsEqual(0.1 + 0.2, 0.3), true);
    assert.equal(amountsEqual(100.004, 100), true);
  });
  it('a short or long payment is never equal', () => {
    for (const [a, b] of [[99.99, 100], [100.01, 100], [50, 100], [0, 100], [1000, 100]]) assert.equal(amountsEqual(a, b), false, `${a} vs ${b}`);
  });
  it('nonsense is never equal', () => {
    for (const [a, b] of [[NaN, 100], [100, NaN], [Infinity, Infinity]]) assert.equal(amountsEqual(a, b), false);
  });
});

describe('parseVerification: both spellings the two official SDKs use', () => {
  it('snake_case (the Python SDK, and how the server writes its errors)', () => {
    const v = parseVerification({ valid: true, verified: true, status: 'verified', provider: 'cbe', transaction_id: 'FT1', amount: 100, mode: 'test', payer: 'X' });
    assert.deepEqual(v, { verified: true, status: 'verified', amount: 100, mode: 'test', reason: null, errorCode: null });
  });
  it('camelCase (the JS SDK types)', () => {
    const v = parseVerification({ verified: true, valid: true, status: 'verified', transactionId: 'FT1', amount: '100.00', mode: 'live', errorCode: 'X_1', message: 'hello' });
    assert.equal(v.verified, true);
    assert.equal(v.amount, 100);
    assert.equal(v.mode, 'live');
    assert.equal(v.errorCode, 'X_1');
    assert.equal(v.reason, 'hello');
  });
  it('"valid" alone (no "verified") counts, as in the Python SDK', () => assert.equal(parseVerification({ valid: true }).verified, true));
  it('error_code / reason / message are all read', () => {
    assert.equal(parseVerification({ verified: false, error_code: 'AUTH_REQUIRED', message: 'Invalid API Key' }).errorCode, 'AUTH_REQUIRED');
    assert.equal(parseVerification({ valid: false, reason: 'Transaction not found' }).reason, 'Transaction not found');
  });
  it('success must be a real boolean true, never a truthy string or number', () => {
    for (const flag of ['true', 'yes', 1, 'verified', {}, [], null]) assert.equal(parseVerification({ verified: flag, status: 'verified' }).verified, false, JSON.stringify(flag));
  });
  it('a failure status wins over a stray true', () => {
    for (const status of ['failed', 'pending', 'processing', 'error', 'not_found', 'rejected', 'unknown']) {
      assert.equal(parseVerification({ verified: true, valid: true, status }).verified, false, status);
    }
    for (const status of ['success', 'completed', 'paid', 'VERIFIED']) assert.equal(parseVerification({ verified: true, status }).verified, true, status);
  });
  it('amounts: numbers and numeric strings, nothing else', () => {
    assert.equal(parseVerification({ verified: true, amount: 12.5 }).amount, 12.5);
    assert.equal(parseVerification({ verified: true, amount: '12.50' }).amount, 12.5);
    for (const bad of ['', 'abc', null, undefined, {}, NaN]) assert.equal(parseVerification({ verified: true, amount: bad }).amount, null, String(bad));
  });
  it('mode is only ever "test" or "live"', () => {
    assert.equal(parseVerification({ verified: true, mode: 'sandbox' }).mode, null);
    assert.equal(parseVerification({ verified: true }).mode, null);
  });
  it('not an object at all is null, never a success', () => {
    for (const bad of [null, undefined, 'ok', 5, [], true]) assert.equal(parseVerification(bad), null, String(bad));
  });
  it('the reason is length-capped', () => assert.equal(parseVerification({ reason: 'x'.repeat(5000) }).reason.length, 300));
});

describe('classifyHttp', () => {
  it('2xx is an answer; 400/404/422 is "does not verify"; everything else is not an answer about the payment', () => {
    for (const s of [200, 201, 204, 299]) assert.equal(classifyHttp(s), 'ok', String(s));
    for (const s of [400, 404, 422]) assert.equal(classifyHttp(s), 'rejected', String(s));
    for (const s of [401, 402, 403, 408, 429, 500, 502, 503, 504, 0]) assert.equal(classifyHttp(s), 'unavailable', String(s));
  });
});

describe('reasonCategory: a safe label, never the provider\'s own words', () => {
  it('maps the usual failures', () => {
    assert.equal(reasonCategory('Transaction not found'), 'not_found');
    assert.equal(reasonCategory('No transaction with that id'), 'not_found');
    assert.equal(reasonCategory('Receiver name does not match'), 'provider_mismatch');
    assert.equal(reasonCategory('This looks like a Telebirr receipt, wrong provider'), 'provider_mismatch');
    assert.equal(reasonCategory('Invalid transaction id format'), 'invalid_request');
    assert.equal(reasonCategory(null, 'pending'), 'pending');
    assert.equal(reasonCategory('something odd'), 'unknown');
    assert.equal(reasonCategory(undefined), 'unknown');
  });
});

// ---------------------------------------------------------------------------------------------------
const ok = (body) => ({ http: 200, body });
const script = (...answers) => {
  const calls = [];
  const fn = async (amount) => { calls.push(amount); const a = answers[Math.min(calls.length - 1, answers.length - 1)]; if (a instanceof Error) throw a; return a; };
  fn.calls = calls;
  return fn;
};

describe('decidePayment: paid only when verified AND exactly the total', () => {
  it('verified, amount matches: paid, one call, asked with the order total', async () => {
    const call = script(ok({ verified: true, status: 'verified', amount: 100, mode: 'live' }));
    const d = await decidePayment(call, 100);
    assert.deepEqual([d.outcome, d.amount, d.mode], ['paid', 100, 'live']);
    assert.deepEqual(call.calls, [100]);
  });
  it('verified with no amount reported: the server matched the amount we sent, so paid (amount = total)', async () => {
    const d = await decidePayment(script(ok({ valid: true, status: 'verified' })), 250.5);
    assert.deepEqual([d.outcome, d.amount], ['paid', 250.5]);
  });
  it('AMOUNT MISMATCH: verified but it reports a different amount = payment_mismatch, NEVER paid', async () => {
    for (const reported of [50, 99.99, 100.01, 1000, 0]) {
      const d = await decidePayment(script(ok({ verified: true, status: 'verified', amount: reported })), 100);
      assert.deepEqual([d.outcome, d.amount], ['mismatch', reported], String(reported));
    }
  });
  it('test mode is passed through for the order to record', async () => {
    assert.equal((await decidePayment(script(ok({ verified: true, mode: 'test' })), 100)).mode, 'test');
  });
  it('not verified, and a lookup with no amount finds the transfer at another amount: mismatch (a person looks)', async () => {
    const call = script(ok({ verified: false, status: 'failed', reason: 'amount mismatch' }), ok({ verified: true, amount: 40 }));
    const d = await decidePayment(call, 100);
    assert.deepEqual([d.outcome, d.amount], ['mismatch', 40]);
    assert.deepEqual(call.calls, [100, null], 'the second call is a lookup with no amount');
    assert.ok(d.raw.with_amount && d.raw.lookup, 'both raw answers are kept');
  });
  it('...or finds it but reports no amount: still mismatch, amount unknown (null)', async () => {
    const d = await decidePayment(script(ok({ verified: false }), ok({ verified: true })), 100);
    assert.deepEqual([d.outcome, d.amount], ['mismatch', null]);
  });
  it('...or says it is the right amount after all: still a person\'s call, never automatic', async () => {
    const d = await decidePayment(script(ok({ verified: false }), ok({ verified: true, amount: 100 })), 100);
    assert.equal(d.outcome, 'mismatch');
  });
  it('not verified either way: not_verified with a safe reason, both answers kept', async () => {
    const call = script(ok({ verified: false, status: 'failed', reason: 'Transaction not found' }), ok({ verified: false, reason: 'Transaction not found' }));
    const d = await decidePayment(call, 100);
    assert.deepEqual([d.outcome, d.reason, d.amount], ['not_verified', 'not_found', null]);
    assert.equal(call.calls.length, 2);
  });
  it('a 404 / 400 / 422 answer counts as "does not verify" (then the lookup runs)', async () => {
    for (const http of [400, 404, 422]) {
      const call = script({ http, body: { error_code: 'NOT_FOUND', message: 'Transaction not found' } });
      const d = await decidePayment(call, 100);
      assert.equal(d.outcome, 'not_verified', String(http));
      assert.equal(call.calls.length, 2);
    }
  });
  it('a pending / processing answer: not_verified "pending", no second call (nothing to look up yet)', async () => {
    for (const status of ['pending', 'processing']) {
      const call = script(ok({ verified: false, status }));
      const d = await decidePayment(call, 100);
      assert.deepEqual([d.outcome, d.reason], ['not_verified', 'pending'], status);
      assert.equal(call.calls.length, 1);
    }
  });
  it('an odd body (not JSON object) is never a success', async () => {
    for (const body of ['OK', null, 'true', 42, [], { raw: '<html>' }]) {
      const d = await decidePayment(script({ http: 200, body }, { http: 200, body }), 100);
      assert.notEqual(d.outcome, 'paid', JSON.stringify(body));
    }
  });
});

describe('decidePayment: an outage is never a verdict', () => {
  it('the network failing or timing out: unavailable, no second call', async () => {
    const call = script(new Error('fetch failed'));
    const d = await decidePayment(call, 100);
    assert.deepEqual([d.outcome, d.http], ['unavailable', null]);
    assert.equal(call.calls.length, 1);
    assert.equal((await decidePayment(script(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })), 100)).outcome, 'unavailable');
  });
  it('401 (our key is wrong), 402 (quota), 429, 5xx: unavailable, and the customer is not blamed', async () => {
    for (const http of [401, 402, 403, 429, 500, 502, 503]) {
      const d = await decidePayment(script({ http, body: { error_code: 'AUTH_REQUIRED', message: 'Invalid API Key' } }), 100);
      assert.deepEqual([d.outcome, d.http], ['unavailable', http], String(http));
    }
  });
  it('the LOOKUP failing after a not-verified first answer: unavailable (we cannot tell which it was)', async () => {
    const d = await decidePayment(script(ok({ verified: false }), new Error('timeout')), 100);
    assert.equal(d.outcome, 'unavailable');
    const d2 = await decidePayment(script(ok({ verified: false }), { http: 503, body: {} }), 100);
    assert.equal(d2.outcome, 'unavailable');
  });
  it('the raw error text is short-capped', async () => {
    const d = await decidePayment(script(new Error('x'.repeat(1000))), 100);
    assert.ok(d.raw.error.length <= 120);
  });
});
