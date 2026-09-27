import { supabase } from './supabase';

/**
 * Every reason claim_gift can refuse (see the gifts migration), each shown as its own message -- never a generic one.
 * 'unknown' only for something outside that list (a network failure, say).
 */
export const CLAIM_ERRORS = [
  'gift_already_claimed',
  'gift_expired',
  'gift_not_yours',
  'gift_not_found',
  'pack_unavailable',
  'player_id_required',
  'id_fields_invalid',
  'id_not_validated',
  'id_validation_expired',
  'region_unverifiable',
  'region_unverified',
  'region_mismatch',
  'not_authenticated',
] as const;
export type ClaimError = (typeof CLAIM_ERRORS)[number] | 'unknown';

/** The refusal named in a claim_gift error. */
export function claimErrorOf(error: unknown): ClaimError {
  const message = String((error as { message?: unknown } | null)?.message ?? '');
  return CLAIM_ERRORS.find((code) => message.includes(code)) ?? 'unknown';
}

export type ClaimResult = {
  deliveryOrderId: string;
  /** 'delivered' = the supplier step completed now. 'queued' = claimed and saved; delivery didn't finish right away,
   * so it waits in the normal delivery queue (retried by our team), exactly like a normal order whose delivery stalls. */
  delivery: 'delivered' | 'queued';
};

/**
 * Claims a gift (claim_gift: single winner, all checks, creates the recipient's delivery order in the same step),
 * then runs the ordinary delivery step on that order -- the same fulfill-order call a wallet checkout makes, awaited
 * here so the result can be shown. Throws only the claim's refusal; a delivery that doesn't finish is 'queued', never
 * an error: the gift is already claimed and its order is in the normal queue.
 */
export async function claimGift(giftId: string, fields: Record<string, string>): Promise<ClaimResult> {
  const { error } = await supabase.rpc('claim_gift', { p_gift_id: giftId, p_fields: fields });
  if (error) throw error;
  const { data: order, error: orderError } = await supabase.from('orders').select('id').eq('gift_id', giftId).maybeSingle();
  if (orderError || !order) throw orderError ?? new Error('delivery_order_missing');
  const orderId = String((order as { id: string }).id);
  try {
    const { data } = await supabase.functions.invoke('fulfill-order', { body: { order_id: orderId } });
    return { deliveryOrderId: orderId, delivery: (data as { outcome?: string } | null)?.outcome === 'completed' ? 'delivered' : 'queued' };
  } catch {
    return { deliveryOrderId: orderId, delivery: 'queued' };
  }
}
