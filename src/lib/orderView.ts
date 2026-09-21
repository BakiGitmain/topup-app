/** How an order's ID check reads on screen. Pure functions with no imports. */

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
 * The delivery half of an order's trail. THE SLOT for fulfilment: today only orders that went through the older direct-purchase
 * path (pending / processing / completed) carry a delivery status; an order that is merely "paid" has none yet because
 * fulfilment for paid orders is not built. `tracked: false` tells the screen to say so instead of inventing a status. When
 * fulfilment exists, return real steps here and neither the receipt nor the admin view needs redesigning.
 */
export function fulfilmentOf(status: string): { tracked: boolean; steps: FulfilmentStep[] } {
  const steps = (current: 0 | 1 | 2): FulfilmentStep[] => [
    { key: 'paid', label: 'Paid', state: 'done' },
    { key: 'in_progress', label: 'Being fulfilled', state: current === 0 ? 'current' : 'done' },
    { key: 'delivered', label: 'Delivered', state: current === 2 ? 'done' : 'todo' },
  ];
  switch (status) {
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
