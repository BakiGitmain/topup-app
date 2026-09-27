// The real database half of attemptFulfillment's deps (getOrder/recordSuccess), shared by every caller: fulfill-order
// (the customer/client-triggered path) and verify-payment (in-process, right after a bank transfer is confirmed --
// see that file's own comment for why in-process, not another HTTP hop). Not unit-tested directly (a thin Supabase
// query wrapper, same as every other index.ts-only database glue in this project); attemptFulfillment itself,
// which this feeds, is fully tested in fulfillment.test.mjs with fake deps.
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';

import type { FulfillableOrder } from './fulfillment.ts';

type LinkRow = { supplier: string | null; offer_ref: string | null; supplier_cost_usd: number | string | null };

function toFields(delivery: unknown): Record<string, string> {
  const fields = (delivery as { fields?: unknown } | null)?.fields;
  if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) return {};
  return Object.fromEntries(Object.entries(fields as Record<string, unknown>).map(([k, v]) => [k, String(v)]));
}

/** Only a single-item order is auto-fulfilled: the older direct-purchase shape (orders.option_id set) or a cart
 * order with exactly one order_items row. See fulfillment.ts's file header for why a multi-item cart is marked
 * multiItem (skipped, falls to the manual admin queue) instead of guessing which item's code goes where. */
export function createOrderLookup(admin: SupabaseClient) {
  async function supplierLink(optionId: string): Promise<LinkRow> {
    const { data, error } = await admin
      .from('product_option_supplier')
      .select('supplier, offer_ref, supplier_cost_usd')
      .eq('option_id', optionId)
      .maybeSingle();
    if (error) throw error;
    return (data as LinkRow | null) ?? { supplier: null, offer_ref: null, supplier_cost_usd: null };
  }

  /** The buyer's order behind a gift or redeem code (see FulfillableOrder.giftBacked). */
  async function isGiftBacked(orderId: string): Promise<boolean> {
    const [gifts, codes] = await Promise.all([
      admin.from('gifts').select('id', { count: 'exact', head: true }).eq('order_id', orderId),
      admin.from('redeem_codes').select('id', { count: 'exact', head: true }).eq('order_id', orderId),
    ]);
    if (gifts.error) throw gifts.error;
    if (codes.error) throw codes.error;
    return (gifts.count ?? 0) + (codes.count ?? 0) > 0;
  }

  return async function getOrder(orderId: string): Promise<FulfillableOrder | null> {
    const { data: order, error } = await admin.from('orders').select('status, fulfillment, delivery, option_id, gift_kind').eq('id', orderId).maybeSingle();
    if (error) throw error;
    if (!order) return null;
    // A gift order is marked from the moment it is created (orders.gift_kind), before it is even paid; the row check
    // also catches an order that backs a gift/code some other way.
    if (order.gift_kind || (await isGiftBacked(orderId))) {
      return { status: order.status as string, fulfillment: order.fulfillment as 'topup' | 'code', supplier: null, offerRef: null, costUsd: null, fields: {}, multiItem: false, giftBacked: true };
    }

    if (order.option_id) {
      const link = await supplierLink(order.option_id as string);
      return {
        status: order.status as string,
        fulfillment: order.fulfillment as 'topup' | 'code',
        supplier: link.supplier,
        offerRef: link.offer_ref,
        costUsd: link.supplier_cost_usd === null ? null : String(link.supplier_cost_usd),
        fields: toFields(order.delivery),
        multiItem: false,
      };
    }

    const { data: items, error: itemsError } = await admin.from('order_items').select('option_id, delivery').eq('order_id', orderId);
    if (itemsError) throw itemsError;
    if (!items || items.length === 0) return null;
    if (items.length > 1) {
      return { status: order.status as string, fulfillment: order.fulfillment as 'topup' | 'code', supplier: null, offerRef: null, costUsd: null, fields: {}, multiItem: true };
    }

    const item = items[0] as { option_id: string; delivery: unknown };
    const link = await supplierLink(item.option_id);
    return {
      status: order.status as string,
      fulfillment: order.fulfillment as 'topup' | 'code',
      supplier: link.supplier,
      offerRef: link.offer_ref,
      costUsd: link.supplier_cost_usd === null ? null : String(link.supplier_cost_usd),
      fields: toFields(item.delivery),
      multiItem: false,
    };
  };
}

export function createSuccessRecorder(admin: SupabaseClient) {
  return async function recordSuccess(orderId: string, code: string | null): Promise<void> {
    const { error } = await admin.rpc('system_fulfill_order', { p_order_id: orderId, p_code: code });
    if (error) throw error;
  };
}
