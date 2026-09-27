import { supabase } from './supabase';

/**
 * Fires right after a wallet payment succeeds (checkout_cart/pay_order_with_wallet), so a code-fulfillment order can
 * land in the customer's Vault before they even leave the screen. Fire-and-forget on purpose: the payment already
 * succeeded and must never be undone or blocked by this -- if fulfillment fails or the request itself fails, the
 * order simply stays exactly where it already was (paid/pending), waiting for the existing manual admin queue,
 * unchanged. Never throws, never awaited by its caller for anything but logging a swallowed error in dev.
 */
export function triggerFulfillment(orderId: string): void {
  supabase.functions.invoke('fulfill-order', { body: { order_id: orderId } }).catch(() => {
    // Best-effort only: the manual admin queue is the real safety net, not this call succeeding.
  });
}
