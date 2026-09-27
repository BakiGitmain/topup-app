// Automatic fulfillment: a paid order attempts real supplier delivery before any admin ever sees it. Pure logic here,
// tested in Node; index.ts (per Edge Function) wires up the real database calls.
//
// THE SWAP POINT (2026-09-23): FULFILLMENT_MODE is 'mock' below. Everything in this file runs the real
// attemptFulfillment() flow -- the same idempotency-key pattern, the same paid->attempt->completed/failed shape a
// real supplier call will have -- but createOrder() returns a fake generated code instead of calling
// Shop2Topup/GamesDrop for real. Flip FULFILLMENT_MODE to 'live' only once createShop2TopupFulfillmentAdapter and
// createGamesDropFulfillmentAdapter below are actually implemented (today they throw); nothing else in this file,
// or in any Edge Function that imports it, needs to change.
//
// SCOPE: only a single-item order is auto-fulfilled -- either the older direct-purchase shape (orders.option_id set)
// or a cart order with exactly one order_items row. A multi-item cart order is skipped (falls straight to the
// existing manual admin queue, unchanged): vault_codes has ONE row per order (order_id is unique), the same
// limitation the manual "paste one code" admin screen already has, so a cart with two different code products has no
// clean place to put a second code without a schema change. That is out of scope here, not silently mishandled --
// attemptFulfillment logs and returns 'skipped' for it, same as it does for a product not yet linked to a supplier.

export type FulfillmentResult =
  | { status: 'completed'; code: string | null }
  /** A real supplier's order can come back processing/submitted rather than instant; there is no poller built for
   * that yet, so a 'pending' result is treated the same as a failure for now (falls back to manual). The mock
   * adapter never returns this -- it only exists so the interface matches what a real adapter will actually do. */
  | { status: 'pending' }
  | { status: 'failed'; reason: string };

export type FulfillmentRequest = {
  supplier: string;
  /** The PACK-level id at the supplier: Shop2Topup's sub_category_id, GamesDrop's offerId -- product_option_supplier.offer_ref. */
  offerRef: string;
  /** Ours, not the supplier's: this order's own id, stable and unique, so a retried attempt never double-orders. */
  idempotencyKey: string;
  quantity: number;
  /** player_id etc, from the order's own delivery.fields; {} for a pure code/voucher with nothing to submit. */
  fields: Record<string, string>;
  /** product_option_supplier.supplier_cost_usd, when known; a real supplier's own "does the price still match" check. */
  expectedCostUsd: string | null;
  /** true for 'code' fulfillment: the caller expects a redeemable key back. false for 'topup': the account credit IS the delivery. */
  needsCode: boolean;
};

export interface FulfillmentAdapter {
  createOrder(req: FulfillmentRequest): Promise<FulfillmentResult>;
}

/**
 * Deterministic within one process: the same idempotencyKey always returns the same result, the same shape a real
 * supplier's order_id/transactionId dedupe would give (see the doc comments on the real adapters below). Codes are
 * clearly marked MOCK- so nobody mistakes one for a real redeemable key if it is ever seen directly.
 */
export function createMockFulfillmentAdapter(): FulfillmentAdapter {
  const seen = new Map<string, FulfillmentResult>();
  return {
    async createOrder(req) {
      const hit = seen.get(req.idempotencyKey);
      if (hit) return hit;
      const code = req.needsCode
        ? `MOCK-${req.supplier.slice(0, 2).toUpperCase()}-${req.offerRef}-${req.idempotencyKey.replace(/-/g, '').slice(0, 8).toUpperCase()}`
        : null;
      const result: FulfillmentResult = { status: 'completed', code };
      seen.set(req.idempotencyKey, result);
      return result;
    },
  };
}

/**
 * NOT IMPLEMENTED. Confirmed live shape (2026-09-23, from Shop2Topup's own reseller-api docs, cross-checked with a
 * second independent read; NOT yet verified against a real response -- this project's own history with this
 * supplier's docs is that field names and per-endpoint behaviour have been wrong before, so treat every name here as
 * "probably right", not "confirmed live", until it has actually been called once):
 *
 *   POST https://shop2topup.com/api/endpoints/v1/orders/create
 *   body: {
 *     order_id: "<client-generated UUID, the idempotency key -- reusing it is the only safe way to retry>",
 *     sub_category_id: <offerRef, as a number>,
 *     quantity: <quantity>,
 *     requirements: <fields, e.g. {"player_id": "...", "server": "..."}>,
 *     expected_unit_price: "<expectedCostUsd, decimal string>"
 *   }
 *   response (HTTP 200): { order: { status: "pending" | "completed" | "partial" | "refunded", vouchers?: [{ code, ... }], ... } }
 *     -- codes are present ONLY once status is "completed"; a fresh create almost always comes back "pending" first
 *        (the wallet is debited immediately, delivery is async) -- poll GET /orders/:orderId (or POST /orders/batch
 *        for several at once) until it reaches a terminal state.
 *   failure: HTTP 4xx/5xx, body { error: { code, message, action, retryable } }.
 *   No sandbox: Shop2Topup's own docs say "one base URL, and it is the live one" -- the first real call here spends
 *   real balance, there is no test mode to verify against first.
 */
export function createShop2TopupFulfillmentAdapter(_config: { key: string }): FulfillmentAdapter {
  return {
    async createOrder() {
      throw new Error('shop2topup fulfillment is not implemented -- see the doc comment on createShop2TopupFulfillmentAdapter');
    },
  };
}

/**
 * NOT IMPLEMENTED. Confirmed live shape (2026-09-23, from GamesDrop's own partner-api docs, cross-checked with a
 * second independent read; same caveat as Shop2Topup above -- this supplier's docs were independently caught being
 * wrong about the balance endpoint's own path in this same round of reading, so verify against a real response
 * before trusting a field name):
 *
 *   POST https://partner.gamesdrop.io/api/v1/offers/create-order
 *   body: {
 *     offerId: <offerRef, as a number>,
 *     price: <expectedCostUsd, as a number>,
 *     transactionId: "<your own idempotency key -- reusing it returns the existing order or TRANSACTION_DUPLICATE>",
 *     useBalance: true,
 *     customer: <fields mapped onto whatever this offer's own check used, e.g. { gameUserId: fields.player_id }>
 *   }
 *   response (HTTP 200 always -- status is in the body, same as check-game-data):
 *     status: "COMPLETED"  -> key field present when is_return_data_for_customer is true (gift cards: usually this)
 *     status: "SUBMITTED" | "PROCESSING" -> async; poll POST /offers/order-status
 *     status: "CANCELED" | "FAILED" | "REFUND" -> terminal failure, no key
 *   failure codes: OUT_OF_STOCK, WRONG_PRICE, OFFER_NOT_FOUND, SERVICE_UNAVAILABLE, INVALID_REQUEST_BODY.
 *   Has a genuine test mode: productId 999 "works in test mode without a provider order" and "creates order with
 *   COMPLETED status" -- unlike Shop2Topup, GamesDrop's own create-order shape COULD be safely verified here before
 *   going live, without spending real balance. Not done yet: this function still throws until it is.
 */
export function createGamesDropFulfillmentAdapter(_config: { key: string }): FulfillmentAdapter {
  return {
    async createOrder() {
      throw new Error('gamesdrop fulfillment is not implemented -- see the doc comment on createGamesDropFulfillmentAdapter');
    },
  };
}

/** THE swap point (see file header). Flip to 'live' only once both real adapters above actually work. */
export const FULFILLMENT_MODE: 'mock' | 'live' = 'mock';

/** Picks the adapter for one supplier, honouring FULFILLMENT_MODE. Unknown supplier (or FULFILLMENT_MODE === 'live'
 * with no matching branch) = no adapter = the caller falls back to manual, same as today. */
export function adapterFor(supplier: string, liveKeys: { shop2topup: string; gamesdrop: string }): FulfillmentAdapter | null {
  if (FULFILLMENT_MODE === 'mock') return createMockFulfillmentAdapter();
  if (supplier === 'shop2topup') return createShop2TopupFulfillmentAdapter({ key: liveKeys.shop2topup });
  if (supplier === 'gamesdrop') return createGamesDropFulfillmentAdapter({ key: liveKeys.gamesdrop });
  return null;
}

// ---------------------------------------------------------------- the attempt itself

export type FulfillableOrder = {
  status: string;
  fulfillment: 'topup' | 'code';
  /** null = this pack has no supplier link on record (should not happen for a live product, but never assumed). */
  supplier: string | null;
  offerRef: string | null;
  costUsd: string | null;
  fields: Record<string, string>;
  /** true = a cart order with more than one order_items row: not supported yet, see the file header. */
  multiItem: boolean;
  /**
   * true = this is the buyer's order behind a gift or redeem code. It is NEVER sent to the supplier: the product is
   * delivered only when the gift is claimed. (The database also refuses to move such an order out of 'paid', but that
   * would only catch it after the supplier had been paid -- this skip is what stops the call.)
   */
  giftBacked?: boolean;
};

export type FulfillmentDeps = {
  getOrder: (orderId: string) => Promise<FulfillableOrder | null>;
  adapterFor: (supplier: string) => FulfillmentAdapter | null;
  recordSuccess: (orderId: string, code: string | null) => Promise<void>;
  /** Structured events only -- same discipline as every other supplier-facing log in this project: never a cost, a
   * code, a player id or a raw supplier body. */
  log: (event: Record<string, unknown>) => void;
};

export type AttemptOutcome = { outcome: 'completed' | 'skipped' | 'failed'; reason?: string };

/** Never throws: every failure path is caught and reported as { outcome: 'failed' | 'skipped' }, so a caller can
 * always safely "fire and forget" this without risking an unrelated response (a payment confirmation, a checkout
 * reply) breaking because fulfillment had a problem. */
export async function attemptFulfillment(orderId: string, deps: FulfillmentDeps): Promise<AttemptOutcome> {
  try {
    const order = await deps.getOrder(orderId);
    if (!order) return skip(deps, null, orderId, 'order_not_found');
    if (order.status !== 'paid' && order.status !== 'pending') return skip(deps, order.supplier, orderId, `status_${order.status}`);
    if (order.giftBacked) return skip(deps, order.supplier, orderId, 'gift_order');
    if (order.multiItem) return skip(deps, order.supplier, orderId, 'multi_item_not_supported');
    if (!order.supplier || !order.offerRef) return skip(deps, order.supplier, orderId, 'no_supplier_link');

    const adapter = deps.adapterFor(order.supplier);
    if (!adapter) return skip(deps, order.supplier, orderId, 'no_adapter');

    const result = await adapter.createOrder({
      supplier: order.supplier,
      offerRef: order.offerRef,
      idempotencyKey: orderId,
      quantity: 1,
      fields: order.fields,
      expectedCostUsd: order.costUsd,
      needsCode: order.fulfillment === 'code',
    });

    if (result.status === 'completed') {
      await deps.recordSuccess(orderId, result.code);
      deps.log({ event: 'fulfillment', order_id: orderId, supplier: order.supplier, outcome: 'completed' });
      return { outcome: 'completed' };
    }
    if (result.status === 'pending') {
      deps.log({ event: 'fulfillment', order_id: orderId, supplier: order.supplier, outcome: 'skipped', reason: 'pending' });
      return { outcome: 'skipped', reason: 'pending' };
    }
    deps.log({ event: 'fulfillment', order_id: orderId, supplier: order.supplier, outcome: 'failed', reason: result.reason });
    return { outcome: 'failed', reason: result.reason };
  } catch (error) {
    const message = String((error as Error)?.message ?? '').slice(0, 200);
    deps.log({ event: 'fulfillment', order_id: orderId, outcome: 'error', message });
    return { outcome: 'failed', reason: 'adapter_error' };
  }
}

function skip(deps: FulfillmentDeps, supplier: string | null, orderId: string, reason: string): AttemptOutcome {
  deps.log({ event: 'fulfillment', order_id: orderId, supplier, outcome: 'skipped', reason });
  return { outcome: 'skipped', reason };
}
