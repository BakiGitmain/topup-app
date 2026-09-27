// Run with: npm run test:unit. Every outside dependency is faked: no network, no database, no supplier.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  FULFILLMENT_MODE,
  attemptFulfillment,
  createGamesDropFulfillmentAdapter,
  createMockFulfillmentAdapter,
  createShop2TopupFulfillmentAdapter,
} from './fulfillment.ts';

describe('the swap point', () => {
  it('is mock by default -- flipping it to live is the only change wiring anything real needs', () => {
    assert.equal(FULFILLMENT_MODE, 'mock');
  });
});

describe('the real adapters are not implemented yet, on purpose', () => {
  it('shop2topup throws rather than silently doing nothing or guessing', async () => {
    const adapter = createShop2TopupFulfillmentAdapter({ key: 'k' });
    await assert.rejects(
      adapter.createOrder({ supplier: 'shop2topup', offerRef: '3441', idempotencyKey: 'x', quantity: 1, fields: {}, expectedCostUsd: '1.00', needsCode: true }),
      /not implemented/
    );
  });
  it('gamesdrop throws too', async () => {
    const adapter = createGamesDropFulfillmentAdapter({ key: 'k' });
    await assert.rejects(
      adapter.createOrder({ supplier: 'gamesdrop', offerRef: '459', idempotencyKey: 'x', quantity: 1, fields: {}, expectedCostUsd: '12.41', needsCode: false }),
      /not implemented/
    );
  });
});

describe('the mock adapter', () => {
  const req = (over = {}) => ({ supplier: 'shop2topup', offerRef: '3441', idempotencyKey: 'order-1', quantity: 1, fields: {}, expectedCostUsd: '1.00', needsCode: true, ...over });

  it('a code-needing request gets a code, clearly marked as a mock, never mistakable for a real one', async () => {
    const adapter = createMockFulfillmentAdapter();
    const result = await adapter.createOrder(req());
    assert.equal(result.status, 'completed');
    assert.match(result.code, /^MOCK-/);
  });
  it('a topup request (no code expected) gets code: null', async () => {
    const adapter = createMockFulfillmentAdapter();
    const result = await adapter.createOrder(req({ needsCode: false }));
    assert.equal(result.status, 'completed');
    assert.equal(result.code, null);
  });
  it('the same idempotency key always returns the exact same result, same as a real supplier promises for order_id/transactionId', async () => {
    const adapter = createMockFulfillmentAdapter();
    const a = await adapter.createOrder(req());
    const b = await adapter.createOrder(req());
    assert.deepEqual(a, b);
  });
  it('a different key gets a different code', async () => {
    const adapter = createMockFulfillmentAdapter();
    const a = await adapter.createOrder(req({ idempotencyKey: 'order-1' }));
    const b = await adapter.createOrder(req({ idempotencyKey: 'order-2' }));
    assert.notEqual(a.code, b.code);
  });
});

describe('attemptFulfillment: never throws, never blocks the caller', () => {
  function setup(overrides = {}) {
    const calls = { recorded: [], logs: [] };
    const order = {
      status: 'paid',
      fulfillment: 'code',
      supplier: 'shop2topup',
      offerRef: '3441',
      costUsd: '1.00',
      fields: { player_id: 'baki' },
      multiItem: false,
    };
    const deps = {
      getOrder: async () => order,
      adapterFor: () => createMockFulfillmentAdapter(),
      recordSuccess: async (orderId, code) => { calls.recorded.push({ orderId, code }); },
      log: (e) => calls.logs.push(e),
      ...overrides,
    };
    return { deps, calls, order };
  }

  it('a code order that fulfils successfully records the code and reports completed', async () => {
    const { deps, calls } = setup();
    const out = await attemptFulfillment('order-1', deps);
    assert.equal(out.outcome, 'completed');
    assert.equal(calls.recorded.length, 1);
    assert.equal(calls.recorded[0].orderId, 'order-1');
    assert.match(calls.recorded[0].code, /^MOCK-/);
  });
  it('a topup order records a null code (the account credit IS the delivery)', async () => {
    const { deps, calls } = setup({ getOrder: async () => ({ status: 'paid', fulfillment: 'topup', supplier: 'gamesdrop', offerRef: '459', costUsd: '12.41', fields: { player_id: 'baki' }, multiItem: false }) });
    const out = await attemptFulfillment('order-1', deps);
    assert.equal(out.outcome, 'completed');
    assert.equal(calls.recorded[0].code, null);
  });
  it('no such order: skipped, nothing recorded', async () => {
    const { deps, calls } = setup({ getOrder: async () => null });
    const out = await attemptFulfillment('order-1', deps);
    assert.deepEqual(out, { outcome: 'skipped', reason: 'order_not_found' });
    assert.equal(calls.recorded.length, 0);
  });
  it('an order that is not paid/pending (already completed, refunded, etc) is skipped, not re-attempted', async () => {
    const { deps, calls } = setup({ getOrder: async () => ({ status: 'completed', fulfillment: 'code', supplier: 'shop2topup', offerRef: '3441', costUsd: '1.00', fields: {}, multiItem: false }) });
    const out = await attemptFulfillment('order-1', deps);
    assert.deepEqual(out, { outcome: 'skipped', reason: 'status_completed' });
    assert.equal(calls.recorded.length, 0);
  });
  it('a multi-item cart order is skipped -- not supported yet, falls to manual -- and the adapter is never called', async () => {
    let adapterCalled = false;
    const { deps, calls } = setup({
      getOrder: async () => ({ status: 'paid', fulfillment: 'code', supplier: 'shop2topup', offerRef: '3441', costUsd: '1.00', fields: {}, multiItem: true }),
      adapterFor: () => { adapterCalled = true; return createMockFulfillmentAdapter(); },
    });
    const out = await attemptFulfillment('order-1', deps);
    assert.deepEqual(out, { outcome: 'skipped', reason: 'multi_item_not_supported' });
    assert.equal(adapterCalled, false);
    assert.equal(calls.recorded.length, 0);
  });
  it("the buyer's order behind a gift or redeem code is never sent to the supplier (delivery waits for the claim)", async () => {
    let adapterCalled = false;
    const { deps, calls } = setup({
      getOrder: async () => ({ status: 'paid', fulfillment: 'code', supplier: 'shop2topup', offerRef: '3441', costUsd: '1.00', fields: {}, multiItem: false, giftBacked: true }),
      adapterFor: () => { adapterCalled = true; return createMockFulfillmentAdapter(); },
    });
    const out = await attemptFulfillment('order-1', deps);
    assert.deepEqual(out, { outcome: 'skipped', reason: 'gift_order' });
    assert.equal(adapterCalled, false);
    assert.equal(calls.recorded.length, 0);
  });
  it('no supplier link on the pack: skipped', async () => {
    const { deps } = setup({ getOrder: async () => ({ status: 'paid', fulfillment: 'code', supplier: null, offerRef: null, costUsd: null, fields: {}, multiItem: false }) });
    const out = await attemptFulfillment('order-1', deps);
    assert.deepEqual(out, { outcome: 'skipped', reason: 'no_supplier_link' });
  });
  it('a supplier with no adapter configured: skipped, not an error', async () => {
    const { deps } = setup({ adapterFor: () => null });
    const out = await attemptFulfillment('order-1', deps);
    assert.deepEqual(out, { outcome: 'skipped', reason: 'no_adapter' });
  });
  it('the adapter reports "pending" (a real async supplier): skipped for now, falls to manual (no poller built yet)', async () => {
    const { deps, calls } = setup({ adapterFor: () => ({ createOrder: async () => ({ status: 'pending' }) }) });
    const out = await attemptFulfillment('order-1', deps);
    assert.deepEqual(out, { outcome: 'skipped', reason: 'pending' });
    assert.equal(calls.recorded.length, 0);
  });
  it('the adapter reports failure: reported as failed, order untouched, nothing recorded', async () => {
    const { deps, calls } = setup({ adapterFor: () => ({ createOrder: async () => ({ status: 'failed', reason: 'OUT_OF_STOCK' }) }) });
    const out = await attemptFulfillment('order-1', deps);
    assert.deepEqual(out, { outcome: 'failed', reason: 'OUT_OF_STOCK' });
    assert.equal(calls.recorded.length, 0);
  });
  it('the adapter throwing is caught, never propagates, never blocks the caller', async () => {
    const { deps, calls } = setup({ adapterFor: () => ({ createOrder: async () => { throw new Error('network blew up'); } }) });
    const out = await attemptFulfillment('order-1', deps);
    assert.equal(out.outcome, 'failed');
    assert.equal(calls.recorded.length, 0);
  });
  it('recordSuccess throwing is also caught, never propagates', async () => {
    const { deps } = setup({ recordSuccess: async () => { throw new Error('db write failed'); } });
    const out = await attemptFulfillment('order-1', deps);
    assert.equal(out.outcome, 'failed');
  });
  it('never logs a cost, a code, a player id or a supplier body -- same discipline as every other supplier log in this project', async () => {
    const { deps, calls } = setup();
    await attemptFulfillment('order-1', deps);
    const text = JSON.stringify(calls.logs);
    for (const secret of ['baki', '1.00', 'MOCK-']) assert.equal(text.includes(secret), false, `logged ${secret}`);
  });
});
