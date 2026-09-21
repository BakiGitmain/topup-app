// Run with: npm run test:unit. ShegerPay and the database are faked. The in-memory ledger below mirrors what
// begin/finish_payment_verification do in SQL (which supabase/tests/payments.test.mjs proves against real Postgres),
// so these tests exercise the HANDLER's orchestration: idempotency, the double-tap race, mismatch, reference reuse.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createHandler } from './handler.ts';

const ORDER = '11111111-2222-3333-4444-555555555555';
const ORDER2 = '66666666-7777-8888-9999-000000000000';

function ledger() {
  const orders = new Map();
  const refs = new Map();
  const finished = [];
  const L = {
    orders, refs, finished,
    add(id, user, amount) { orders.set(id, { id, user, amount, status: 'pending_payment', key: null, verifying: false, verified: null, mode: null }); },
    begin: async (id, user, provider, ref) => {
      const o = orders.get(id);
      if (!o || o.user !== user) return { result: 'not_found' };
      if (o.status !== 'pending_payment') return { result: 'closed', status: o.status };
      if (o.verifying) return { result: 'in_progress' };
      const key = `${provider}|${ref}`;
      const holder = refs.get(key);
      if (holder && holder !== id) return { result: 'reference_used' };
      refs.set(key, id); o.key = key; o.verifying = true;
      return { result: 'go', amount: o.amount, account_name: 'Eyosiyas Daniel Debebe' };
    },
    finish: async (id, decision) => {
      const o = orders.get(id);
      if (o.status !== 'pending_payment') return { result: 'closed', status: o.status };
      finished.push({ id, outcome: decision.outcome, amount: decision.amount, mode: decision.mode, raw: decision.raw });
      o.verifying = false;
      if (decision.outcome === 'paid') {
        if (decision.amount !== o.amount) throw new Error('paid_amount_must_equal_total');
        o.status = 'paid'; o.verified = decision.amount; o.mode = decision.mode ?? 'live';
      } else if (decision.outcome === 'mismatch') {
        o.status = 'payment_mismatch'; o.verified = decision.amount; o.mode = decision.mode ?? 'live';
      } else { refs.delete(o.key); o.key = null; }
      return { result: decision.outcome };
    },
  };
  return L;
}

function setup({ sheger, amount = 100 } = {}) {
  const L = ledger();
  L.add(ORDER, 'user-A', amount);
  const calls = [];
  const logs = [];
  const shegerCalls = [];
  const deps = {
    getUserId: async (t) => ({ 'tok-A': 'user-A', 'tok-B': 'user-B' })[t] ?? null,
    begin: (...a) => { calls.push(['begin', ...a]); return L.begin(...a); },
    finish: (...a) => { calls.push(['finish', a[0], a[1].outcome]); return L.finish(...a); },
    callShegerPay: async (args) => { shegerCalls.push(args); return (sheger ?? (async () => ({ http: 200, body: { verified: true, status: 'verified', amount, mode: 'test' } })))(args); },
    log: (e) => logs.push(e),
  };
  const handle = createHandler(deps);
  const post = (body, token = 'tok-A') => handle(new Request('https://x.test/verify-payment', {
    method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
  }));
  const ask = async (body, token) => { const r = await post(body, token); return { status: r.status, body: await r.json() }; };
  return { L, calls, logs, shegerCalls, handle, post, ask };
}
const req = (extra = {}) => ({ order_id: ORDER, provider: 'cbe', reference: 'FT24352648751234', ...extra });

describe('a good payment', () => {
  it('is verified by ShegerPay with the ORDER\'S total and merchant name, then marked paid', async () => {
    const { ask, L, shegerCalls } = setup();
    const { status, body } = await ask(req());
    assert.equal(status, 200);
    assert.deepEqual(body, { result: 'paid', status: 'paid' });
    assert.equal(L.orders.get(ORDER).status, 'paid');
    assert.deepEqual(shegerCalls, [{ provider: 'cbe', reference: 'FT24352648751234', amount: 100, merchantName: 'Eyosiyas Daniel Debebe' }]);
  });
  it('works for Telebirr, and normalises the reference (spaces, case)', async () => {
    const { ask, shegerCalls, L } = setup();
    const { body } = await ask(req({ provider: 'telebirr', reference: ' cbt 24ab\n99 ' }));
    assert.equal(body.result, 'paid');
    assert.deepEqual([shegerCalls[0].provider, shegerCalls[0].reference], ['telebirr', 'CBT24AB99']);
    assert.ok(L.refs.has('telebirr|CBT24AB99'));
  });
  it('records the mode ShegerPay reported (a test key verifies nothing real, and the order says so)', async () => {
    const { ask, L } = setup();
    await ask(req());
    assert.equal(L.orders.get(ORDER).mode, 'test');
    assert.equal(L.finished[0].mode, 'test');
  });
  it('keeps ShegerPay\'s raw answer for audit', async () => {
    const { ask, L } = setup();
    await ask(req());
    assert.equal(L.finished[0].raw.with_amount.verified, true);
  });
  it('the amount comes from the ORDER, never from the request (a client-sent amount is ignored)', async () => {
    const { ask, shegerCalls } = setup({ amount: 250 });
    await ask({ ...req(), amount: 1, total: 1 });
    assert.equal(shegerCalls[0].amount, 250);
  });
});

describe('idempotency: the same order and reference twice', () => {
  it('the second call gets "already_paid" and does NOT call ShegerPay or process again', async () => {
    const { ask, shegerCalls, L } = setup();
    const first = await ask(req());
    const second = await ask(req());
    assert.equal(first.body.result, 'paid');
    assert.deepEqual(second.body, { result: 'already_paid', status: 'paid' });
    assert.equal(shegerCalls.length, 1, 'ShegerPay was asked exactly once');
    assert.equal(L.finished.length, 1, 'the payment was recorded exactly once');
  });
  it('a paid order also answers "already_paid" to a DIFFERENT reference, and claims nothing', async () => {
    const { ask, shegerCalls, L } = setup();
    await ask(req());
    const again = await ask(req({ reference: 'FT99999999' }));
    assert.equal(again.body.result, 'already_paid');
    assert.equal(shegerCalls.length, 1);
    assert.equal(L.refs.has('cbe|FT99999999'), false);
  });
  it('a mismatched order answers with its status (a person is looking), and does not re-verify', async () => {
    const { ask, shegerCalls } = setup({ sheger: async () => ({ http: 200, body: { verified: true, amount: 50 } }) });
    assert.equal((await ask(req())).body.result, 'mismatch');
    const again = await ask(req());
    assert.deepEqual(again.body, { result: 'closed', status: 'payment_mismatch' });
    assert.equal(shegerCalls.length, 1);
  });
});

describe('the double-tap race', () => {
  it('two requests at once: exactly one verifies and pays; the other is told to wait or that it is paid', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const { post, L, shegerCalls } = setup({ sheger: async () => { await gate; return { http: 200, body: { verified: true, amount: 100 } }; } });
    const a = post(req());
    const b = post(req());
    await new Promise((r) => setTimeout(r, 20)); // both are past begin(); the first is waiting on ShegerPay
    release();
    const answers = await Promise.all([a, b].map(async (p) => (await p).json()));
    const results = answers.map((x) => x.result).sort();
    assert.deepEqual(results, ['in_progress', 'paid']);
    assert.equal(shegerCalls.length, 1, 'only one request reached ShegerPay');
    assert.equal(L.finished.length, 1, 'only one payment was recorded: never two deliveries');
    assert.equal(L.orders.get(ORDER).status, 'paid');
  });
  it('five taps at once still produce exactly one payment', async () => {
    const { post, L, shegerCalls } = setup({ sheger: async () => { await new Promise((r) => setTimeout(r, 15)); return { http: 200, body: { verified: true, amount: 100 } }; } });
    const answers = await Promise.all(Array.from({ length: 5 }, () => post(req()).then((r) => r.json())));
    assert.equal(answers.filter((a) => a.result === 'paid').length, 1);
    assert.equal(answers.filter((a) => a.result === 'in_progress' || a.result === 'already_paid').length, 4);
    assert.equal(shegerCalls.length, 1);
    assert.equal(L.finished.length, 1);
  });
});

describe('amount mismatch', () => {
  it('a short payment is NOT paid: the order becomes payment_mismatch and the customer is told it is being reviewed', async () => {
    const { ask, L } = setup({ sheger: async () => ({ http: 200, body: { verified: true, status: 'verified', amount: 60 } }) });
    const { body } = await ask(req());
    assert.deepEqual(body, { result: 'mismatch', status: 'payment_mismatch' });
    assert.equal(L.orders.get(ORDER).status, 'payment_mismatch');
    assert.equal(L.orders.get(ORDER).verified, 60);
  });
  it('an over-payment is a mismatch too (a person decides about the change)', async () => {
    const { ask, L } = setup({ sheger: async () => ({ http: 200, body: { verified: true, amount: 150 } }) });
    assert.equal((await ask(req())).body.result, 'mismatch');
    assert.notEqual(L.orders.get(ORDER).status, 'paid');
  });
  it('the wrong-amount transfer stays claimed: it cannot then be used to pay a different order', async () => {
    const { ask, L } = setup({ sheger: async () => ({ http: 200, body: { verified: true, amount: 60 } }) });
    await ask(req());
    L.add(ORDER2, 'user-B', 60);
    const { body } = await ask({ ...req(), order_id: ORDER2 }, 'tok-B');
    assert.equal(body.result, 'reference_used');
    assert.equal(L.orders.get(ORDER2).status, 'pending_payment');
  });
  it('mismatch found only by the lookup (the amount-checked call refused it)', async () => {
    const answers = [{ http: 200, body: { verified: false, status: 'failed', reason: 'amount mismatch' } }, { http: 200, body: { verified: true, amount: 40 } }];
    const { ask, shegerCalls, L } = setup({ sheger: async () => answers.shift() });
    assert.equal((await ask(req())).body.result, 'mismatch');
    assert.deepEqual(shegerCalls.map((c) => c.amount), [100, null]);
    assert.equal(L.orders.get(ORDER).verified, 40);
  });
});

describe('a reference cannot pay two orders', () => {
  it('a reference already paid on another order is refused clearly, without asking ShegerPay', async () => {
    const { ask, L, shegerCalls } = setup();
    assert.equal((await ask(req())).body.result, 'paid');
    L.add(ORDER2, 'user-B', 100);
    const before = shegerCalls.length;
    const { status, body } = await ask({ ...req(), order_id: ORDER2 }, 'tok-B');
    assert.equal(status, 200);
    assert.deepEqual(body, { result: 'reference_used', status: 'pending_payment' });
    assert.equal(shegerCalls.length, before, 'ShegerPay was never asked about the reused reference');
    assert.equal(L.orders.get(ORDER2).status, 'pending_payment');
  });
  it('the same characters under the OTHER provider are a different transfer', async () => {
    const { ask, L } = setup();
    await ask(req({ provider: 'cbe' }));
    L.add(ORDER2, 'user-B', 100);
    assert.equal((await ask({ ...req({ provider: 'telebirr' }), order_id: ORDER2 }, 'tok-B')).body.result, 'paid');
  });
  it('the same reference typed differently (case, spaces) is still the same transfer', async () => {
    const { ask, L } = setup();
    await ask(req({ reference: 'FT24352648751234' }));
    L.add(ORDER2, 'user-B', 100);
    assert.equal((await ask({ ...req({ reference: ' ft 2435 2648 751234 ' }), order_id: ORDER2 }, 'tok-B')).body.result, 'reference_used');
  });
});

describe('not verified / outages leave the order payable', () => {
  it('a reference ShegerPay cannot find: not_verified with a safe reason; the reference is freed to retry', async () => {
    const answers = [{ http: 404, body: { error_code: 'NOT_FOUND', message: 'Transaction not found' } }];
    const { ask, L } = setup({ sheger: async () => answers[0] });
    const { body } = await ask(req());
    assert.deepEqual(body, { result: 'not_verified', status: 'pending_payment', reason: 'not_found' });
    assert.equal(L.orders.get(ORDER).status, 'pending_payment');
    assert.equal(L.refs.size, 0, 'freed');
    // ...and a corrected reference then works
    const fixed = setup({ sheger: async () => ({ http: 200, body: { verified: true, amount: 100 } }) });
    assert.equal((await fixed.ask(req({ reference: 'FT11111111' }))).body.result, 'paid');
  });
  it("the provider's own wording is never passed to the app", async () => {
    const { post } = setup({ sheger: async () => ({ http: 200, body: { verified: false, reason: 'SECRET INTERNAL: receiver acct 0911 mismatch' } }) });
    const text = await (await post(req())).text();
    assert.equal(/SECRET|0911|acct/.test(text), false);
  });
  it('ShegerPay down, slow or rejecting our key: "unavailable", the order stays payable, nothing is blamed on the customer', async () => {
    for (const sheger of [async () => { throw new Error('timeout'); }, async () => ({ http: 503, body: {} }), async () => ({ http: 401, body: { error_code: 'AUTH_REQUIRED', message: 'Invalid API Key' } }), async () => ({ http: 429, body: {} })]) {
      const { ask, L } = setup({ sheger });
      const { body } = await ask(req());
      assert.deepEqual(body, { result: 'unavailable', status: 'pending_payment' });
      assert.equal(L.orders.get(ORDER).status, 'pending_payment');
      assert.equal(L.refs.size, 0);
    }
  });
  it('after an outage the very same request can be retried and paid', async () => {
    let up = false;
    const { ask, L } = setup({ sheger: async () => { if (!up) throw new Error('down'); return { http: 200, body: { verified: true, amount: 100 } }; } });
    assert.equal((await ask(req())).body.result, 'unavailable');
    up = true;
    assert.equal((await ask(req())).body.result, 'paid');
    assert.equal(L.finished.length, 2);
  });
});

describe('who may call it, and what it accepts', () => {
  it("someone else's order is 'not_found' (404) and ShegerPay is never called", async () => {
    const { ask, shegerCalls } = setup();
    const { status, body } = await ask(req(), 'tok-B');
    assert.equal(status, 404);
    assert.equal(body.result, 'not_found');
    assert.equal(shegerCalls.length, 0);
  });
  it('an unknown order is not_found too', async () => {
    const { ask } = setup();
    assert.equal((await ask(req({ order_id: ORDER2 }))).status, 404);
  });
  it('needs a signed-in user', async () => {
    const { ask, calls } = setup();
    assert.equal((await ask(req(), null)).status, 401);
    assert.equal((await ask(req(), 'garbage')).status, 401);
    assert.equal(calls.length, 0);
  });
  it('rejects bad input before touching anything', async () => {
    const { ask, calls } = setup();
    for (const bad of [{ order_id: 'nope' }, { order_id: undefined }, { provider: 'awash' }, { provider: 'CBE' }, { provider: undefined }, { reference: 'abc' }, { reference: '' }, { reference: 12345678 }, { reference: 'https://x.test/FT1234' }]) {
      const r = await ask(req(bad));
      assert.equal(r.status, 400, JSON.stringify(bad));
    }
    assert.equal(calls.length, 0);
  });
  it('POST only, valid JSON, and answers the CORS preflight', async () => {
    const { handle, post } = setup();
    assert.equal((await handle(new Request('https://x.test/', { method: 'GET' }))).status, 405);
    assert.equal((await handle(new Request('https://x.test/', { method: 'OPTIONS' }))).status, 204);
    const r = await handle(new Request('https://x.test/', { method: 'POST', headers: { authorization: 'Bearer tok-A' }, body: '{oops' }));
    assert.equal(r.status, 400);
    assert.equal((await post(req())).status, 200);
  });
});

describe('failures and logging', () => {
  it('a database error while recording is a 500, never a "paid"', async () => {
    const L = ledger(); L.add(ORDER, 'user-A', 100);
    const handle = createHandler({
      getUserId: async () => 'user-A', begin: L.begin, finish: async () => { throw new Error('connection reset'); },
      callShegerPay: async () => ({ http: 200, body: { verified: true, amount: 100 } }), log: () => {},
    });
    const r = await handle(new Request('https://x.test/', { method: 'POST', headers: { authorization: 'Bearer t' }, body: JSON.stringify(req()) }));
    assert.equal(r.status, 500);
    assert.equal((await r.json()).result, undefined);
    assert.notEqual(L.orders.get(ORDER).status, 'paid');
  });
  it('the database refusing a wrong amount as "paid" surfaces as an error, and the order is not paid', async () => {
    const L = ledger(); L.add(ORDER, 'user-A', 100);
    // a bug in the decision would still be stopped by the ledger (the SQL does the same): simulate a wrong "paid" decision
    const handle = createHandler({
      getUserId: async () => 'user-A', begin: L.begin,
      finish: (id, d) => L.finish(id, { ...d, outcome: 'paid', amount: 99 }),
      callShegerPay: async () => ({ http: 200, body: { verified: true, amount: 100 } }), log: () => {},
    });
    const r = await handle(new Request('https://x.test/', { method: 'POST', headers: { authorization: 'Bearer t' }, body: JSON.stringify(req()) }));
    assert.equal(r.status, 500);
    assert.notEqual(L.orders.get(ORDER).status, 'paid');
  });
  it('logs outcomes only: never a reference, an amount, an order id or a ShegerPay body', async () => {
    const { ask, logs } = setup({ sheger: async () => ({ http: 200, body: { verified: true, amount: 100, payer: 'Abebe Kebede', receiver: 'Eyosiyas' } }) });
    await ask(req());
    await ask(req());
    const text = JSON.stringify(logs);
    for (const secret of ['FT24352648751234', 'Abebe', 'Eyosiyas', ORDER, '100', 'user-A']) assert.equal(text.includes(secret), false, `logged ${secret}`);
    assert.ok(logs.length >= 1);
  });
});
