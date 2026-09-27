import { supabase } from './supabase';

// A read-only check of a discount code against the customer's OWN current cart, without redeeming anything. Used
// for the cart screen's live-as-you-type validation (see cart.tsx): typing settles, this runs, and either an
// "Apply" button or the existing inline error shows -- nothing is committed until Checkout.

export type CodePreview =
  | { ok: true; discountAmount: number; total: number; newTotal: number }
  /** portalCoinBonus is only ever set alongside problem === 'code_already_used' -- the code still earns its own
   * bonus on reuse (no discount), so the cart can say so instead of just blocking. */
  | { ok: false; problem: string; portalCoinBonus?: number };

/** Never throws for an expected "no" (bad/expired/already-used/inapplicable/empty cart) -- only for a real problem
 * (not signed in). */
export async function previewDiscountCode(code: string): Promise<CodePreview> {
  const { data, error } = await supabase.rpc('preview_discount_code', { p_code: code });
  if (error) throw error;
  const d = data as { ok?: unknown; discount_amount?: unknown; total?: unknown; new_total?: unknown; problem?: unknown; portal_coin_bonus?: unknown } | null;
  if (d?.ok === true) {
    return { ok: true, discountAmount: Number(d.discount_amount), total: Number(d.total), newTotal: Number(d.new_total) };
  }
  return {
    ok: false,
    problem: typeof d?.problem === 'string' ? d.problem : 'other',
    portalCoinBonus: typeof d?.portal_coin_bonus === 'number' ? d.portal_coin_bonus : undefined,
  };
}
