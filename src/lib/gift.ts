import { triggerFulfillment } from './fulfillment';
import { readRedeemReply, type RedeemReply } from './redeemInput';
import { supabase } from './supabase';

/** What is being bought: a gift for one account, or a redeem code anyone can use. */
export type GiftKind = 'gift' | 'redeem_code';

export type Recipient = { id: string; name: string; avatarUrl: string | null };

export type RecipientLookup =
  | { kind: 'found'; recipient: Recipient }
  | { kind: 'not_found' }
  | { kind: 'self' }
  | { kind: 'too_many' }
  | { kind: 'error' };

/**
 * One exact email -> one account (find_recipient_by_email). Rate-limited on the server; never a partial match or a
 * list. Never throws.
 */
export async function findRecipient(email: string): Promise<RecipientLookup> {
  const { data, error } = await supabase.rpc('find_recipient_by_email', { p_email: email });
  if (error) return { kind: 'error' };
  const d = (data ?? {}) as { ok?: boolean; error?: string; id?: string; name?: string; avatar_url?: string | null };
  if (d.ok && typeof d.id === 'string') return { kind: 'found', recipient: { id: d.id, name: d.name ?? '', avatarUrl: d.avatar_url ?? null } };
  if (d.error === 'self') return { kind: 'self' };
  if (d.error === 'too_many_attempts') return { kind: 'too_many' };
  if (d.error === 'not_found') return { kind: 'not_found' };
  return { kind: 'error' };
}

export type GiftCheckout = {
  orderId: string;
  kind: GiftKind;
  amount: number;
  /** true = the wallet covered it: the order is paid and the gift/code already exists. false = pay on /pay/[id]. */
  paid: boolean;
  balance: number;
  /** A paid redeem-code order's code: handed over once, here. */
  code: string | null;
};

/**
 * Buys one pack as a gift or a redeem code (checkout_gift). No player ID is asked: the recipient gives it at claim
 * time. Throws the database's refusal (see giftCheckoutError).
 */
export async function checkoutGift(optionId: string, kind: GiftKind, recipientId: string | null): Promise<GiftCheckout> {
  const { data, error } = await supabase.rpc('checkout_gift', { p_option_id: optionId, p_kind: kind, p_recipient: recipientId });
  if (error) throw error;
  const d = data as { order_id?: unknown; kind?: unknown; amount?: unknown; paid?: unknown; balance?: unknown; code?: unknown } | null;
  if (!d || typeof d.order_id !== 'string') throw new Error('checkout_failed');
  // The same fire-and-forget call every paid checkout makes; the delivery job skips gift orders (see CLAUDE.md), so
  // this only proves nothing is delivered early.
  if (d.paid === true) triggerFulfillment(d.order_id);
  return {
    orderId: d.order_id,
    kind: d.kind === 'redeem_code' ? 'redeem_code' : 'gift',
    amount: Number(d.amount),
    paid: d.paid === true,
    balance: Number(d.balance ?? 0),
    code: typeof d.code === 'string' ? d.code : null,
  };
}

export type GiftCheckoutError =
  | { kind: 'self' }
  | { kind: 'recipient_not_found' }
  | { kind: 'pack_unavailable' }
  | { kind: 'pending_order'; orderId: string | null }
  | { kind: 'other' };

/** Reads checkout_gift's refusal. */
export function giftCheckoutError(error: unknown): GiftCheckoutError {
  const e = (error ?? {}) as { message?: string; details?: string };
  const message = e.message ?? '';
  if (message.includes('cannot_gift_self')) return { kind: 'self' };
  if (message.includes('recipient_not_found')) return { kind: 'recipient_not_found' };
  if (message.includes('pack_unavailable')) return { kind: 'pack_unavailable' };
  if (message.includes('pending_order_exists')) {
    const id = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(`${e.details ?? ''} ${message}`)?.[0] ?? null;
    return { kind: 'pending_order', orderId: id };
  }
  return { kind: 'other' };
}

export type GiftSummary = {
  orderId: string;
  kind: GiftKind;
  status: string;
  productName: string;
  optionLabel: string;
  amount: number;
  code: string | null;
  recipientName: string | null;
  recipientAvatar: string | null;
};

/** The done screen's data for the buyer's own gift order (gift_order_summary); null if it isn't one. */
export async function fetchGiftSummary(orderId: string): Promise<GiftSummary | null> {
  const { data, error } = await supabase.rpc('gift_order_summary', { p_order: orderId });
  if (error) throw error;
  if (!data) return null;
  const d = data as Record<string, unknown>;
  return {
    orderId: String(d.order_id),
    kind: d.kind === 'redeem_code' ? 'redeem_code' : 'gift',
    status: String(d.status),
    productName: String(d.product_name ?? ''),
    optionLabel: String(d.option_label ?? ''),
    amount: Number(d.amount ?? 0),
    code: typeof d.code === 'string' ? d.code : null,
    recipientName: typeof d.recipient_name === 'string' ? d.recipient_name : null,
    recipientAvatar: typeof d.recipient_avatar === 'string' ? d.recipient_avatar : null,
  };
}

/**
 * Redeems a code for the signed-in user (redeem_code: single winner, rate-limited, never raises). The code is passed
 * as typed; the server normalizes it again. A failed request is 'error' -- never assumed redeemed.
 */
export async function redeemCode(code: string): Promise<RedeemReply> {
  try {
    const { data, error } = await supabase.rpc('redeem_code', { p_code: code });
    if (error) return { kind: 'error' };
    return readRedeemReply(data);
  } catch {
    return { kind: 'error' };
  }
}
