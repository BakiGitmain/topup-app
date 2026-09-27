import AsyncStorage from '@react-native-async-storage/async-storage';

import { triggerFulfillment } from './fulfillment';
import { isProviderId, parseVerifyAnswer, type ProviderId, type VerifyAnswer } from './paymentView';
import { parseStoredOrderId, pendingOrderKey, pickResumeOrder } from './resume';
import { supabase } from './supabase';

export type CreatedOrder = {
  orderId: string;
  amount: number;
  items: number;
  /** True when the wallet covered the whole total and the order is already PAID (no bank transfer needed). */
  paid: boolean;
  /** The wallet balance after checkout. */
  balance: number;
  /** Birr taken off by a redeemed discount code, if one was entered. 0 if none. */
  discount: number;
};

/**
 * Re-checks the WHOLE cart against the live catalog and, only if every line is fine, creates the order and empties the
 * cart, in one database step. All or nothing. If the wallet balance covers the whole total the order is paid from it in
 * that same step (paid: true); otherwise it is left unpaid for the Telebirr/CBE flow (paid: false). Throws the database's
 * refusal: read it with parseCheckoutError (which lines are gone, which IDs need fixing, which unpaid order to resume,
 * or what was wrong with the discount code). A code and a wheel prize never both apply -- the caller passes at
 * most one; passing both is a client bug and the database rejects it (multiple_discounts_not_allowed).
 */
export async function createCartOrder(code?: string | null, wheelPrizeWonId?: string | null): Promise<CreatedOrder> {
  const { data, error } = await supabase.rpc('checkout_cart', {
    p_code: code?.trim() || null,
    p_wheel_prize_won_id: wheelPrizeWonId || null,
  });
  if (error) throw error;
  const d = data as { order_id?: unknown; amount?: unknown; items?: unknown; paid?: unknown; balance?: unknown; discount?: unknown } | null;
  if (!d || typeof d.order_id !== 'string') throw new Error('checkout_failed');
  if (d.paid === true) triggerFulfillment(d.order_id);
  return {
    orderId: d.order_id,
    amount: Number(d.amount),
    items: Number(d.items),
    paid: d.paid === true,
    balance: Number(d.balance ?? 0),
    discount: Number(d.discount ?? 0),
  };
}

/** Closes the customer's own unpaid order; its lines go back in the cart. */
export async function cancelOrder(orderId: string): Promise<void> {
  const { error } = await supabase.rpc('cancel_pending_order', { p_order: orderId });
  if (error) throw error;
}

export type PayItem = {
  id: string;
  productName: string;
  optionLabel: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  /** Which account this line is for: "Player ID: 3327205705". */
  ids: [string, string][];
  playerName: string | null;
};

export type PayOrder = {
  id: string;
  status: string;
  /** 'wallet', 'telebirr', 'cbe', or null while unpaid. */
  provider: string | null;
  amount: number;
  createdAt: string;
  items: PayItem[];
  /** 'code' = something lands in the Vault; 'topup' = nothing does (credited straight to a game account). Decides
   * where the "Payment confirmed" screen sends the customer next -- see pay/[id].tsx. */
  fulfillment: 'code' | 'topup';
  /** Birr taken off by a discount code entered at checkout. 0 if none was used. */
  discount: number;
  /** A gift or redeem-code order (Profile > Gift): once paid, it leads to the gift's done screen, not the Vault. */
  giftKind: 'gift' | 'redeem_code' | null;
};

type ItemRow = {
  id: string;
  product_name: string;
  option_label: string;
  quantity: number;
  unit_price: number | string;
  line_total: number | string;
  delivery: { fields?: Record<string, unknown>; account_id?: string } | null;
  validated_player_name: string | null;
};

export async function fetchPayOrder(userId: string, orderId: string): Promise<PayOrder | null> {
  const { data: order, error } = await supabase
    .from('orders')
    .select('id, status, amount, created_at, payment_provider, fulfillment, discount_amount, gift_kind, product_name, option_label')
    .eq('user_id', userId)
    .eq('id', orderId)
    .maybeSingle();
  if (error) throw error;
  if (!order) return null;

  const { data: items, error: itemsError } = await supabase
    .from('order_items')
    .select('id, product_name, option_label, quantity, unit_price, line_total, delivery, validated_player_name')
    .eq('order_id', orderId)
    .order('created_at', { ascending: true });
  if (itemsError) throw itemsError;

  return {
    id: order.id as string,
    status: order.status as string,
    provider: (order.payment_provider as string | null) ?? null,
    amount: Number(order.amount),
    createdAt: order.created_at as string,
    fulfillment: order.fulfillment === 'code' ? 'code' : 'topup',
    discount: Number(order.discount_amount ?? 0),
    giftKind: order.gift_kind === 'gift' || order.gift_kind === 'redeem_code' ? order.gift_kind : null,
    // A gift order is one pack with no order lines (nothing to go back into the cart): shown as its single line.
    items: (items ?? []).length === 0 && order.gift_kind
      ? [{ id: order.id as string, productName: order.product_name as string, optionLabel: order.option_label as string, quantity: 1, unitPrice: Number(order.amount), lineTotal: Number(order.amount), ids: [], playerName: null }]
      : ((items ?? []) as unknown as ItemRow[]).map((i) => ({
      id: i.id,
      productName: i.product_name,
      optionLabel: i.option_label,
      quantity: i.quantity,
      unitPrice: Number(i.unit_price),
      lineTotal: Number(i.line_total),
      ids: Object.entries(i.delivery?.fields ?? {}).map(([k, v]) => [k, String(v)] as [string, string]),
      playerName: i.validated_player_name,
    })),
  };
}

export type PaymentAccount = { provider: ProviderId; accountName: string; accountNumber: string };

/** Where the customer sends the money. Set by an admin; empty until then. */
export async function fetchPaymentAccounts(): Promise<PaymentAccount[]> {
  const { data, error } = await supabase.from('payment_accounts').select('provider, account_name, account_number').eq('is_active', true);
  if (error) throw error;
  return ((data ?? []) as { provider: string; account_name: string; account_number: string }[])
    .filter((r): r is typeof r & { provider: ProviderId } => isProviderId(r.provider))
    .map((r) => ({ provider: r.provider, accountName: r.account_name, accountNumber: r.account_number }));
}

/**
 * Asks the verify-payment Edge Function to check the payment reference. The function, not the app, talks to
 * ShegerPay. Never throws: anything unexpected is "unavailable" (try again), never "paid".
 */
export async function verifyPayment(orderId: string, provider: ProviderId, reference: string): Promise<VerifyAnswer> {
  try {
    const { data, error } = await supabase.functions.invoke('verify-payment', { body: { order_id: orderId, provider, reference } });
    if (error) {
      const status = (error as { context?: { status?: number } }).context?.status;
      return status === 404 ? { result: 'not_found' } : { result: 'unavailable' };
    }
    return parseVerifyAnswer(data);
  } catch {
    return { result: 'unavailable' };
  }
}

// ---------------------------------------------------------------- the recovery point

/**
 * Called the moment checkout returns the order id, BEFORE any payment screen shows. If the app dies or the connection
 * drops after this, the next launch finds the order and goes straight back to "enter your payment reference".
 */
export async function savePendingOrderId(userId: string, orderId: string): Promise<void> {
  try {
    await AsyncStorage.setItem(pendingOrderKey(userId), orderId);
  } catch {
    // The database still has the order (one unpaid order per customer), so recovery still works.
  }
}

export async function clearPendingOrderId(userId: string): Promise<void> {
  try {
    await AsyncStorage.removeItem(pendingOrderKey(userId));
  } catch {
    // Harmless: a stale id is ignored and cleared at the next launch.
  }
}

/** The unpaid order to go back to, or null. The database decides; the stored id is only a hint. */
export async function findOrderToResume(userId: string): Promise<string | null> {
  let stored: string | null = null;
  try {
    stored = parseStoredOrderId(await AsyncStorage.getItem(pendingOrderKey(userId)));
  } catch {
    stored = null;
  }
  const { data, error } = await supabase.from('orders').select('id').eq('user_id', userId).eq('status', 'pending_payment');
  if (error) return stored; // offline: trust the device; the pay screen re-checks the order when it opens
  const pick = pickResumeOrder(stored, (data ?? []) as { id: string }[]);
  if (pick.clearStored) await clearPendingOrderId(userId);
  return pick.orderId;
}
