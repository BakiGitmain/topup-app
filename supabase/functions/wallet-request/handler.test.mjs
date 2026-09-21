// Run with: npm run test:unit. The database and Telegram are faked.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createHandler } from './handler.ts';

const DEP = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function setup({ deposit, withdrawal } = {}) {
  const calls = [];
  const notified = [];
  const logs = [];
  const deps = {
    getUserId: async (t) => ({ 'tok-A': 'user-A' })[t] ?? null,
    createDeposit: async (token, amount) => { calls.push(['deposit', token, amount]); return (deposit ?? (() => ({ data: { deposit_id: DEP, amount, accounts: [] } })))(amount); },
    createWithdrawal: async (token, args) => { calls.push(['withdraw', token, args]); return (withdrawal ?? (() => ({ data: { withdrawal_id: 'w1', amount: args.amount, balance: 700 } })))(args); },
    notify: async () => { notified.push(true); },
    log: (e) => logs.push(e),
  };
  const handle = createHandler(deps);
  const ask = async (body, token = 'tok-A', raw = false) => {
    const r = await handle(new Request('https://x.test/wallet-request', { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: raw ? body : JSON.stringify(body) }));
    return { status: r.status, body: await r.json() };
  };
  return { ask, calls, notified, logs };
}

describe('authentication', () => {
  it('no token / a bad token: 401 and nothing is called', async () => {
    for (const token of [null, 'nope']) {
      const { ask, calls, notified } = setup();
      const r = await ask({ action: 'deposit', amount: 100 }, token);
      assert.equal(r.status, 401);
      assert.equal(calls.length + notified.length, 0);
    }
  });
  it('the database is called with the CUSTOMER\'S OWN token, never a privileged one', async () => {
    const { ask, calls } = setup();
    await ask({ action: 'deposit', amount: 100 });
    assert.equal(calls[0][1], 'tok-A');
  });
});

describe('deposit', () => {
  it('creates the request and notifies afterwards', async () => {
    const { ask, notified } = setup();
    const r = await ask({ action: 'deposit', amount: 500 });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true, deposit_id: DEP, amount: 500, accounts: [] });
    assert.equal(notified.length, 1);
  });
  it('accepts an amount typed as text ("250.50")', async () => {
    const { ask, calls } = setup();
    await ask({ action: 'deposit', amount: '250.50' });
    assert.equal(calls[0][2], 250.5);
  });
  it('rejects nonsense amounts before the database', async () => {
    for (const amount of [0, -5, 'abc', '1e9', null, undefined, NaN, Infinity, {}, [], '12.345', 1e12]) {
      const { ask, calls } = setup();
      const r = await ask({ action: 'deposit', amount });
      assert.equal(r.status, 400, String(amount));
      assert.equal(r.body.error, 'invalid_amount');
      assert.equal(calls.length, 0);
    }
  });
  it('an open deposit is a 409 that says which one to resume', async () => {
    const { ask, notified } = setup({ deposit: () => ({ error: { message: 'deposit_open', details: DEP } }) });
    const r = await ask({ action: 'deposit', amount: 100 });
    assert.equal(r.status, 409);
    assert.deepEqual(r.body, { error: 'deposit_open', deposit_id: DEP });
    assert.equal(notified.length, 0, 'nothing was created, so nothing is announced');
  });
  it('never trusts a malformed id in the error detail', async () => {
    const { ask } = setup({ deposit: () => ({ error: { message: 'deposit_open', details: "'; drop table x;--" } }) });
    assert.deepEqual((await ask({ action: 'deposit', amount: 100 })).body, { error: 'deposit_open' });
  });
});

describe('withdraw', () => {
  const body = { action: 'withdraw', amount: 300, provider: 'telebirr', account: '0911223344' };
  it('creates the request with the database\'s own checks, then notifies', async () => {
    const { ask, calls, notified } = setup();
    const r = await ask(body);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true, withdrawal_id: 'w1', amount: 300, balance: 700 });
    assert.deepEqual(calls[0][2], { amount: 300, provider: 'telebirr', account: '0911223344' });
    assert.equal(notified.length, 1);
  });
  it('an overdraw is a 409 and NOTHING is announced', async () => {
    const { ask, notified } = setup({ withdrawal: () => ({ error: { message: 'insufficient_balance' } }) });
    const r = await ask(body);
    assert.equal(r.status, 409);
    assert.deepEqual(r.body, { error: 'insufficient_balance' });
    assert.equal(notified.length, 0);
  });
  it('each of the database refusals maps to its own answer', async () => {
    for (const [message, status, code] of [['invalid_amount', 400, 'invalid_amount'], ['invalid_provider', 400, 'invalid_provider'], ['invalid_account', 400, 'invalid_account'], ['too_many_pending', 409, 'too_many_pending'], ['not_authenticated', 401, 'unauthorized']]) {
      const { ask } = setup({ withdrawal: () => ({ error: { message } }) });
      const r = await ask(body);
      assert.equal(r.status, status, message);
      assert.equal(r.body.error, code);
    }
  });
  it('bad shapes are refused before the database', async () => {
    for (const bad of [{ ...body, provider: 5 }, { ...body, account: null }, { ...body, account: 'x'.repeat(50) }, { ...body, provider: 'x'.repeat(30) }, { ...body, amount: -1 }]) {
      const { ask, calls } = setup();
      assert.equal((await ask(bad)).status, 400);
      assert.equal(calls.length, 0);
    }
  });
});

describe('robustness and hygiene', () => {
  it('a Telegram problem never changes the answer', async () => {
    const calls = [];
    const handle = createHandler({
      getUserId: async () => 'u', createDeposit: async () => ({ data: { deposit_id: DEP } }), createWithdrawal: async () => ({ data: {} }),
      notify: async () => { throw new Error('telegram down'); }, log: (e) => calls.push(e),
    });
    const r = await handle(new Request('https://x.test', { method: 'POST', headers: { authorization: 'Bearer t' }, body: JSON.stringify({ action: 'deposit', amount: 100 }) }));
    assert.equal(r.status, 200);
    assert.equal((await r.json()).ok, true);
  });
  it('an unknown action, bad JSON, or a non-POST', async () => {
    const { ask } = setup();
    assert.equal((await ask({ action: 'steal', amount: 1 })).status, 400);
    assert.equal((await ask('{not json', 'tok-A', true)).status, 400);
  });
  it('an unexpected database failure is a 500 with no internals', async () => {
    const { ask } = setup({ deposit: () => ({ error: { message: 'relation "deposit_requests" does not exist at db.internal' } }) });
    const r = await ask({ action: 'deposit', amount: 100 });
    assert.equal(r.status, 500);
    assert.deepEqual(r.body, { error: 'server_error' });
  });
  it('logs carry no amounts, accounts or names', async () => {
    const { ask, logs } = setup();
    await ask({ action: 'withdraw', amount: 312.5, provider: 'cbe', account: '1000727257229' });
    const all = JSON.stringify(logs);
    assert.ok(!all.includes('312') && !all.includes('1000727257229'));
  });
});
