// Run with: npm run test:unit. ShegerPay and the database are faked. The in-memory ledger mirrors what
// begin/finish_deposit_verification do in SQL (which supabase/tests/wallet-requests.test.mjs proves against real Postgres),
// so these tests exercise the SHARED HANDLER's orchestration for deposits: exact-amount credit, no partial credit,
// idempotency, the double tap, reference reuse and the notification flush.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';

import { createShegerPayCaller } from '../_shared/shegerpayCall.ts';
import { createHandler } from './handler.ts';

const DEP = '11111111-2222-3333-4444-555555555555';

function ledger() {
  const deposits = new Map();
  const refs = new Map();
  const credits = [];
  const L = {
    deposits, refs, credits,
    add(id, user, amount) { deposits.set(id, { id, user, amount, status: 'pending_reference', key: null }); },
    begin: async (id, user, provider, ref) => {
      const d = deposits.get(id);
      if (!d || d.user !== user) return { result: 'not_found' };
      if (!['pending_reference', 'pending_verification'].includes(d.status)) return { result: 'closed', status: d.status };
      if (d.status === 'pending_verification') return { result: 'in_progress' };
      const key = `${provider}|${ref}`;
      const holder = refs.get(key);
      if (holder && holder !== id) return { result: 'reference_used' };
      refs.set(key, id); d.key = key; d.status = 'pending_verification';
      return { result: 'go', amount: d.amount, account_name: 'Eyosiyas Daniel Debebe' };
    },
    finish: async (id, decision) => {
      const d = deposits.get(id);
      if (d.status !== 'pending_verification') return { result: 'closed', status: d.status };
      if (decision.outcome === 'paid') {
        if (decision.amount !== d.amount) throw new Error('paid_amount_must_equal_requested');
        credits.push({ id, amount: d.amount });
        d.status = 'paid';
      } else if (decision.outcome === 'mismatch') {
        d.status = 'mismatch';
      } else { refs.delete(d.key); d.key = null; d.status = 'pending_reference'; }
      return { result: decision.outcome };
    },
  };
  return L;
}

function setup({ sheger, amount = 500, afterFinish } = {}) {
  const L = ledger();
  L.add(DEP, 'user-A', amount);
  const shegerCalls = [];
  const flushes = [];
  const logs = [];
  const deps = {
    getUserId: async (t) => ({ 'tok-A': 'user-A', 'tok-B': 'user-B' })[t] ?? null,
    begin: (...a) => L.begin(...a),
    finish: (...a) => L.finish(...a),
    callShegerPay: async (args) => { shegerCalls.push(args); return (sheger ?? (async () => ({ http: 200, body: { verified: true, status: 'verified', amount, mode: 'test' } })))(args); },
    afterFinish: afterFinish ?? (async (outcome) => { flushes.push(outcome); }),
    log: (e) => logs.push(e),
  };
  const handle = createHandler(deps);
  const ask = async (body, token = 'tok-A') => {
    const r = await handle(new Request('https://x.test/verify-deposit', { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) }));
    return { status: r.status, body: await r.json() };
  };
  return { L, shegerCalls, flushes, logs, ask };
}
const req = (extra = {}) => ({ deposit_id: DEP, provider: 'telebirr', reference: 'FT25DEPOSIT0001', ...extra });

describe('the request', () => {
  it('needs deposit_id (an order_id is not a deposit)', async () => {
    const { ask, shegerCalls } = setup();
    assert.equal((await ask({ order_id: DEP, provider: 'telebirr', reference: 'FT25DEPOSIT0001' })).status, 400);
    assert.equal((await ask(req({ deposit_id: 'not-a-uuid' }))).status, 400);
    assert.equal(shegerCalls.length, 0);
  });
  it('needs a signed-in customer, and only THEIR deposit', async () => {
    const { ask, shegerCalls } = setup();
    assert.equal((await ask(req(), null)).status, 401);
    assert.equal((await ask(req(), 'tok-B')).status, 404);
    assert.equal(shegerCalls.length, 0);
  });
});

describe('a good deposit', () => {
  it('asks ShegerPay with the deposit\'s OWN amount and credits exactly once', async () => {
    const { ask, L, shegerCalls } = setup();
    const r = await ask(req());
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { result: 'paid', status: 'paid' });
    assert.deepEqual(L.credits, [{ id: DEP, amount: 500 }]);
    assert.deepEqual(shegerCalls, [{ provider: 'telebirr', reference: 'FT25DEPOSIT0001', amount: 500, merchantName: 'Eyosiyas Daniel Debebe' }]);
  });
  it('a client-supplied amount is ignored (the database\'s number is used)', async () => {
    const { ask, shegerCalls } = setup();
    await ask({ ...req(), amount: 1, total: 1 });
    assert.equal(shegerCalls[0].amount, 500);
  });
  it('the notification flush runs after a paid deposit', async () => {
    const { ask, flushes } = setup();
    await ask(req());
    assert.deepEqual(flushes, ['paid']);
  });
});

describe('idempotency and the double tap', () => {
  it('the same deposit + reference twice: the second is already_paid, NO second call to ShegerPay, NO second credit', async () => {
    const { ask, L, shegerCalls } = setup();
    await ask(req());
    const again = await ask(req());
    assert.deepEqual(again.body, { result: 'already_paid', status: 'paid' });
    assert.equal(L.credits.length, 1);
    assert.equal(shegerCalls.length, 1);
  });
  it('two taps at the same instant: exactly one credit', async () => {
    const { ask, L } = setup({ sheger: async () => { await new Promise((r) => setTimeout(r, 15)); return { http: 200, body: { verified: true, status: 'verified', amount: 500 } }; } });
    const [a, b] = await Promise.all([ask(req()), ask(req())]);
    assert.equal(L.credits.length, 1);
    assert.deepEqual([a.body.result, b.body.result].sort(), ['in_progress', 'paid']);
  });
});

describe('no partial credit', () => {
  it('a transfer for a different amount is a mismatch: nothing credited, the customer is told it needs a person', async () => {
    const { ask, L, flushes } = setup({ sheger: async (args) => (args.amount === null ? { http: 200, body: { verified: true, status: 'verified', amount: 400 } } : { http: 200, body: { verified: false, status: 'failed', message: 'amount mismatch' } }) });
    const r = await ask(req());
    assert.deepEqual(r.body, { result: 'mismatch', status: 'mismatch' });
    assert.equal(L.credits.length, 0);
    assert.deepEqual(flushes, ['mismatch'], 'the admin is told');
  });
  it('even if the function were wrong, the ledger refuses "paid" for another amount', async () => {
    const { ask, L } = setup({ amount: 500 });
    await ask(req());
    // the SQL guard is exercised in wallet-requests.test.mjs; here the mirror throws the same way and the handler answers 500
    const L2 = setup({ amount: 500, sheger: async () => ({ http: 200, body: { verified: true, status: 'verified', amount: 499.99 } }) });
    const r = await L2.ask(req());
    assert.notEqual(r.body.result, 'paid');
    assert.equal(L2.L.credits.length, 0);
    assert.equal(L.credits.length, 1);
  });
});

describe('a reference that is not confirmed, or used already', () => {
  it('not found: stays open with a reason and nothing credited', async () => {
    const { ask, L, flushes } = setup({ sheger: async () => ({ http: 404, body: { error_code: 'TRANSACTION_NOT_FOUND', message: 'Transaction not found' } }) });
    const r = await ask(req());
    assert.equal(r.body.result, 'not_verified');
    assert.equal(r.body.status, 'pending_reference');
    assert.equal(L.credits.length, 0);
    assert.deepEqual(flushes, ['not_verified'], 'the handler reports every outcome; index.ts only flushes for paid / mismatch (guarded below)');
  });
  it('a transfer that already funded another deposit is refused before ShegerPay is asked', async () => {
    const { ask, L, shegerCalls } = setup();
    L.refs.set('telebirr|FT25DEPOSIT0001', 'some-other-deposit');
    const r = await ask(req());
    assert.deepEqual(r.body, { result: 'reference_used', status: 'pending_reference' });
    assert.equal(shegerCalls.length, 0);
    assert.equal(L.credits.length, 0);
  });
  it('ShegerPay being down is "unavailable": nothing credited, the customer may retry', async () => {
    const { ask, L } = setup({ sheger: async () => { throw new Error('timeout'); } });
    const r = await ask(req());
    assert.equal(r.body.result, 'unavailable');
    assert.equal(L.credits.length, 0);
  });
});

describe('notifications never affect the answer', () => {
  it('a failing flush is swallowed', async () => {
    const { ask, L } = setup({ afterFinish: async () => { throw new Error('telegram-notify unreachable'); } });
    const r = await ask(req());
    assert.equal(r.status, 200);
    assert.equal(r.body.result, 'paid');
    assert.equal(L.credits.length, 1);
  });
});

describe('the notification flush is only for outcomes that queue a message', () => {
  it('verify-deposit/index.ts flushes for paid and mismatch only', () => {
    const index = fs.readFileSync(new URL('../verify-deposit/index.ts', import.meta.url), 'utf8');
    assert.ok(index.includes("if (outcome === 'paid' || outcome === 'mismatch') await flushNotifications(admin);"));
  });
});

describe('hygiene', () => {
  it('logs carry no reference, amount, or ShegerPay body', async () => {
    const { ask, logs } = setup();
    await ask(req());
    const all = JSON.stringify(logs);
    assert.ok(!all.includes('FT25DEPOSIT0001') && !all.includes('500') && !all.includes('Eyosiyas'));
  });
});

describe('ONE copy of the ShegerPay logic (source guards)', () => {
  const root = new URL('../', import.meta.url);
  const read = (p) => fs.readFileSync(new URL(p, root), 'utf8');
  it('orders and deposits share the same handler, decision logic and HTTP caller', () => {
    for (const f of ['verify-payment/index.ts', 'verify-deposit/index.ts']) {
      assert.match(read(f), /createShegerPayCaller/, f);
      assert.ok(!/api\.shegerpay\.com|fetch\(/.test(read(f)), `${f} must not make its own ShegerPay call`);
    }
    for (const f of ['verify-payment/handler.ts', 'verify-deposit/handler.ts']) {
      assert.match(read(f), /createVerifyHandler/, f);
      assert.ok(!/decidePayment|callShegerPay/.test(read(f)), `${f} must not re-implement the check`);
    }
    assert.match(read('_shared/verifyHandler.ts'), /decidePayment/);
  });
  it('only the shared caller knows ShegerPay\'s URL and header', () => {
    for (const dir of ['verify-payment', 'verify-deposit', 'wallet-request', 'telegram-notify']) {
      for (const f of fs.readdirSync(new URL(`${dir}/`, root)).filter((n) => n.endsWith('.ts'))) {
        assert.ok(!/api\/v1\/verify|X-API-Key/.test(read(`${dir}/${f}`)), `${dir}/${f}`);
      }
    }
    assert.match(read('_shared/shegerpayCall.ts'), /api\/v1\/verify/);
  });
});

describe('the shared HTTP caller', () => {
  it('sends the key in X-API-Key with the documented body, and never returns or throws the key', async () => {
    const seen = [];
    const call = createShegerPayCaller({
      key: 'sk_test_SECRETSECRET', baseUrl: 'https://sheger.test/',
      fetchFn: async (url, init) => { seen.push({ url, init }); return { status: 200, text: async () => JSON.stringify({ verified: true }) }; },
    });
    const out = await call({ provider: 'cbe', reference: 'FT1', amount: 500, merchantName: 'Eyosiyas Daniel Debebe' });
    assert.deepEqual(out, { http: 200, body: { verified: true } });
    assert.equal(seen[0].url, 'https://sheger.test/api/v1/verify');
    assert.equal(seen[0].init.headers['X-API-Key'], 'sk_test_SECRETSECRET');
    assert.deepEqual(JSON.parse(seen[0].init.body), { provider: 'cbe', transaction_id: 'FT1', amount: 500, merchant_name: 'Eyosiyas Daniel Debebe' });
    assert.ok(!JSON.stringify(out).includes('SECRETSECRET'));
  });
  it('a lookup sends amount null; a non-JSON body is kept as a short raw excerpt', async () => {
    const call = createShegerPayCaller({ key: 'k', fetchFn: async (u, init) => ({ status: 502, text: async () => `<html>${'x'.repeat(2000)}</html>`, init }) });
    const out = await call({ provider: 'telebirr', reference: 'FT2', amount: null, merchantName: null });
    assert.equal(out.http, 502);
    assert.ok(out.body.raw.length <= 500);
  });
  it('no key configured: refuses (503) without making any request', async () => {
    let calls = 0;
    const call = createShegerPayCaller({ key: '', fetchFn: async () => { calls++; return { status: 200, text: async () => '{}' }; } });
    await assert.rejects(call({ provider: 'cbe', reference: 'FT3', amount: 1, merchantName: null }), (e) => e.status === 503 && !/sk_/.test(e.message));
    assert.equal(calls, 0);
  });
  it('a hung request is aborted', async () => {
    const call = createShegerPayCaller({ key: 'k', timeoutMs: 20, fetchFn: (u, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')))) });
    await assert.rejects(call({ provider: 'cbe', reference: 'FT4', amount: 1, merchantName: null }), /aborted/);
  });
});
