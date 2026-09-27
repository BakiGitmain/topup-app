// Run with: npm run test:unit. Every outside dependency is faked: no network, no database.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createHandler } from './handler.ts';

const ORDER = '11111111-1111-1111-1111-111111111111';

function setup(overrides = {}) {
  const calls = { recorded: [], logs: [] };
  const order = { status: 'paid', fulfillment: 'code', supplier: 'shop2topup', offerRef: '3441', costUsd: '1.00', fields: {}, multiItem: false };
  const deps = {
    getUserId: async (t) => (t === 'owner-token' ? 'owner-1' : t === 'other-token' ? 'other-1' : null),
    ownsOrder: async (userId) => userId === 'owner-1',
    getOrder: async () => order,
    adapterFor: () => ({ createOrder: async () => ({ status: 'completed', code: 'MOCK-ST-3441-ABCD1234' }) }),
    recordSuccess: async (orderId, code) => { calls.recorded.push({ orderId, code }); },
    log: (e) => calls.logs.push(e),
    ...overrides,
  };
  const handle = createHandler(deps);
  const call = (body, { token = 'owner-token', method = 'POST', raw } = {}) =>
    handle(new Request('https://x.test/fulfill-order', {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: method === 'POST' ? (raw ?? JSON.stringify(body)) : undefined,
    }));
  return { call, calls };
}
const read = async (res) => ({ status: res.status, body: await res.json() });

describe('who may call it', () => {
  it('needs a signed-in user', async () => {
    const { call } = setup();
    assert.equal((await call({ order_id: ORDER }, { token: null })).status, 401);
    assert.equal((await call({ order_id: ORDER }, { token: 'nonsense' })).status, 401);
  });
  it('refuses someone else\'s order, without ever touching fulfillment', async () => {
    const { call, calls } = setup();
    assert.equal((await call({ order_id: ORDER }, { token: 'other-token' })).status, 403);
    assert.equal(calls.recorded.length, 0);
  });
  it('only accepts POST, valid JSON and a real order id', async () => {
    const { call } = setup();
    assert.equal((await call(null, { method: 'GET' })).status, 405);
    assert.equal((await call(null, { raw: '{oops' })).status, 400);
    assert.equal((await call({ order_id: 'not-a-uuid' })).status, 400);
    assert.equal((await call({})).status, 400);
  });
  it('answers the CORS preflight', async () => {
    const { call } = setup();
    assert.equal((await call(null, { method: 'OPTIONS' })).status, 204);
  });
});

describe('a valid request from the order\'s own owner', () => {
  it('attempts fulfillment and reports the outcome', async () => {
    const { call, calls } = setup();
    const { status, body } = await read(await call({ order_id: ORDER }));
    assert.equal(status, 200);
    assert.equal(body.outcome, 'completed');
    assert.equal(calls.recorded.length, 1);
    assert.equal(calls.recorded[0].orderId, ORDER);
  });
  it('a fulfillment failure still answers 200 (it is a normal outcome, not a server error)', async () => {
    const { call } = setup({ adapterFor: () => ({ createOrder: async () => ({ status: 'failed', reason: 'OUT_OF_STOCK' }) }) });
    const { status, body } = await read(await call({ order_id: ORDER }));
    assert.equal(status, 200);
    assert.equal(body.outcome, 'failed');
  });
});
