/** How an order's ID check reads on screen. Pure functions with no imports. */

/**
 * How a gift-related order reads in the customer's Orders list, or null for an ordinary order. The buyer's order
 * behind a gift or redeem code never completes (it only backs the gift), so its label is the gift's own state; the
 * recipient's delivery order is a normal order, marked as a gift received. `tone` picks the status-badge colour.
 */
export function giftOrderView(order: {
  status: string;
  gift_kind?: 'gift' | 'redeem_code' | null;
  gift_state?: string | null;
  gift_id?: string | null;
}): { label: 'orders.gift.sent' | 'orders.gift.code' | 'orders.gift.received'; state: string | null; tone: 'processing' | 'completed' | 'cancelled' | null } | null {
  if (order.gift_id) return { label: 'orders.gift.received', state: null, tone: null };
  if (!order.gift_kind) return null;
  const label = order.gift_kind === 'gift' ? 'orders.gift.sent' : 'orders.gift.code';
  // Not paid yet (or cancelled): the order's own status says it best.
  if (order.status !== 'paid' || !order.gift_state) return { label, state: null, tone: null };
  const state = order.gift_state;
  const tone = state === 'claimed' || state === 'redeemed' ? 'completed' : state === 'expired' ? 'cancelled' : 'processing';
  return { label, state, tone };
}

export type OrderCheckFields = {
  validation_id?: string | null;
  validated_account_region?: string | null;
  validated_player_name?: string | null;
  id_self_declared_at?: string | null;
};

export type Verification =
  /** The server checked the ID with the game before the order was placed. */
  | { kind: 'validated'; recordId: string; playerName: string | null; accountRegion: string | null }
  /** The customer vouched for the ID themselves, at this time. */
  | { kind: 'self_declared'; at: string }
  /** Nothing was checked (orders from before ID checks existed, or nothing to check). */
  | { kind: 'none' };

export function verificationOf(order: OrderCheckFields): Verification {
  if (order.validation_id) {
    return {
      kind: 'validated',
      recordId: order.validation_id,
      playerName: order.validated_player_name ?? null,
      accountRegion: order.validated_account_region ?? null,
    };
  }
  if (order.id_self_declared_at) return { kind: 'self_declared', at: order.id_self_declared_at };
  return { kind: 'none' };
}

// ---------------------------------------------------------------- receipts and the payment trail

export type PaymentMethod = 'telebirr' | 'cbe' | 'wallet';

/** How the order was paid: a bank transfer (Telebirr / CBE), the wallet, or null (not paid, or an older wallet purchase). */
export function paymentMethodOf(order: { payment_provider?: string | null }): PaymentMethod | null {
  const p = order.payment_provider;
  return p === 'telebirr' || p === 'cbe' || p === 'wallet' ? p : null;
}

/** "#1A2B3C4D": the short form of an order id that customers and admins quote. */
export const shortOrderId = (id: string) => `#${String(id).slice(0, 8).toUpperCase()}`;

/**
 * A receipt is proof that money was received, so an order that is still waiting for payment, is under review for a wrong amount, or
 * was cancelled has none.
 */
export function receiptAvailable(status: string): boolean {
  return !['pending_payment', 'payment_mismatch', 'cancelled'].includes(status);
}

/** What an admin reads for one payment attempt: what ShegerPay said, the amount it found, and whether it was the test key. */
export function attemptText(a: { outcome: string; verified_amount: number | string | null; mode: string | null }): string {
  const label: Record<string, string> = {
    paid: 'Verified, amount matched',
    mismatch: 'Transfer found, WRONG amount (nothing credited)',
    not_verified: 'Not found / not verified',
    unavailable: 'Could not reach ShegerPay',
  };
  const amount = a.verified_amount === null || a.verified_amount === undefined ? '' : ` · found Br ${Number(a.verified_amount)}`;
  const mode = a.mode === 'test' ? ' · TEST KEY' : '';
  return `${label[a.outcome] ?? a.outcome}${amount}${mode}`;
}

export type FulfilmentStep = { key: 'paid' | 'in_progress' | 'delivered'; label: string; state: 'done' | 'current' | 'todo' };

/**
 * The delivery half of an order's trail. 'paid' (bank transfer or instant wallet payment) and 'pending' (the older
 * direct-purchase path's default status) are the same starting point now that admin_deliver_order/
 * admin_set_order_status accept either (2026-09-23: closed the gap where a merely-"paid" order had no fulfilment
 * step at all). `tracked: false` tells the screen to say so instead of inventing a status for anything else.
 */
export function fulfilmentOf(status: string): { tracked: boolean; steps: FulfilmentStep[] } {
  const steps = (current: 0 | 1 | 2): FulfilmentStep[] => [
    { key: 'paid', label: 'Paid', state: 'done' },
    { key: 'in_progress', label: 'Being fulfilled', state: current === 0 ? 'current' : 'done' },
    { key: 'delivered', label: 'Delivered', state: current === 2 ? 'done' : 'todo' },
  ];
  switch (status) {
    case 'paid':
    case 'pending':
      return { tracked: true, steps: steps(0) };
    case 'processing':
      return { tracked: true, steps: steps(1) };
    case 'completed':
      return { tracked: true, steps: steps(2) };
    default:
      return { tracked: false, steps: [] };
  }
}

/**
 * What an admin typed into the order search. A full order id, the short "#1A2B3C4D" form (or any 4+ hex characters of the
 * start of an id), and a payment reference (a Telebirr / CBE transaction number) are all understood. `null` = too short or not
 * something an order could be found by. A short hex string could be either an id or a reference, so both are searched.
 */
export type OrderQuery = { uuid: string | null; prefix: string | null; reference: string | null };

export function classifyOrderQuery(text: string): OrderQuery | null {
  const cleaned = String(text ?? '').trim().replace(/^#/, '').replace(/\s+/g, '');
  if (cleaned.length < 4 || cleaned.length > 64) return null;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cleaned) ? cleaned.toLowerCase() : null;
  const hex = cleaned.replace(/-/g, '');
  const prefix = /^[0-9a-f]{4,32}$/i.test(hex) && /^[0-9a-f-]+$/i.test(cleaned) ? hex.toLowerCase() : null;
  const reference = /^[A-Za-z0-9_-]{4,64}$/.test(cleaned) ? cleaned.toUpperCase() : null;
  if (!uuid && !prefix && !reference) return null;
  return { uuid, prefix, reference };
}

/** Does this order id start with the typed hex prefix (dashes ignored)? */
export const idStartsWith = (id: string, prefix: string) => id.replace(/-/g, '').toLowerCase().startsWith(prefix.replace(/-/g, '').toLowerCase());
