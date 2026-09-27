/** Reading what create_cart_order / cancel_pending_order refuse with. Pure functions with no imports. */

export type CartProblem =
  | 'product_off'
  | 'pack_off'
  | 'region_off'
  | 'id_fields_invalid'
  | 'id_not_validated'
  | 'id_validation_expired'
  | 'id_check_required'
  | 'region_unverifiable'
  | 'region_unverified'
  | 'region_mismatch'
  | 'unknown';

export type CartFailure = { itemId: string; optionId: string | null; productName: string; label: string; problem: CartProblem };

export type CheckoutError =
  /** An unpaid order already exists: resume it instead of making another. */
  | { kind: 'pending_order_exists'; orderId: string }
  | { kind: 'cart_empty' }
  /** Some lines can't be bought (or their player ID isn't checked). NOTHING was created. */
  | { kind: 'cart_unavailable'; failures: CartFailure[] }
  | { kind: 'not_signed_in' }
  /** The discount code typed at checkout. NOTHING was created in any of these five cases. */
  | { kind: 'code_not_found' }
  | { kind: 'code_inactive' }
  | { kind: 'code_expired' }
  | { kind: 'code_not_applicable' }
  | { kind: 'code_already_used' }
  /** A wheel prize passed at checkout. NOTHING was created in either case. */
  | { kind: 'wheel_prize_not_found' }
  | { kind: 'wheel_prize_unavailable' }
  /** The client sent both a code and a wheel prize -- a client bug, never a real user action. */
  | { kind: 'multiple_discounts_not_allowed' }
  | { kind: 'other' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PROBLEMS: readonly CartProblem[] = [
  'product_off', 'pack_off', 'region_off', 'id_fields_invalid', 'id_not_validated', 'id_validation_expired',
  'id_check_required', 'region_unverifiable', 'region_unverified', 'region_mismatch',
];

export function parseCheckoutError(error: unknown): CheckoutError {
  const e = error as { message?: unknown; details?: unknown } | null;
  const message = typeof e?.message === 'string' ? e.message : '';
  const details = typeof e?.details === 'string' ? e.details : '';

  if (message.includes('pending_order_exists')) {
    return UUID.test(details.trim()) ? { kind: 'pending_order_exists', orderId: details.trim().toLowerCase() } : { kind: 'other' };
  }
  if (message.includes('cart_empty')) return { kind: 'cart_empty' };
  if (message.includes('not_authenticated')) return { kind: 'not_signed_in' };
  // Checked before 'cart_unavailable' below: these are about the CODE, not any one cart line.
  if (message.includes('code_not_found')) return { kind: 'code_not_found' };
  if (message.includes('code_inactive')) return { kind: 'code_inactive' };
  if (message.includes('code_expired')) return { kind: 'code_expired' };
  if (message.includes('code_not_applicable')) return { kind: 'code_not_applicable' };
  if (message.includes('code_already_used')) return { kind: 'code_already_used' };
  if (message.includes('multiple_discounts_not_allowed')) return { kind: 'multiple_discounts_not_allowed' };
  if (message.includes('wheel_prize_not_found')) return { kind: 'wheel_prize_not_found' };
  if (message.includes('wheel_prize_unavailable')) return { kind: 'wheel_prize_unavailable' };
  if (message.includes('cart_unavailable')) {
    try {
      const list: unknown = JSON.parse(details);
      if (!Array.isArray(list)) return { kind: 'other' };
      const failures = list.flatMap((f): CartFailure[] => {
        const item = f as Record<string, unknown>;
        if (typeof item?.item_id !== 'string') return [];
        const problem = PROBLEMS.find((p) => p === item.problem) ?? 'unknown';
        return [{
          itemId: item.item_id,
          optionId: typeof item.option_id === 'string' ? item.option_id : null,
          productName: typeof item.product_name === 'string' ? item.product_name : '',
          label: typeof item.label === 'string' ? item.label : '',
          problem,
        }];
      });
      return failures.length > 0 ? { kind: 'cart_unavailable', failures } : { kind: 'other' };
    } catch {
      return { kind: 'other' };
    }
  }
  return { kind: 'other' };
}

/**
 * "unavailable": the pack is no longer sold, so the app DROPS the line. "id": the line is fine but its player ID
 * (or the account's region) needs fixing, so the app keeps it and says which one.
 */
export function problemKind(problem: CartProblem): 'unavailable' | 'id' {
  return problem === 'product_off' || problem === 'pack_off' || problem === 'region_off' ? 'unavailable' : 'id';
}

export type Split = { drop: CartFailure[]; fix: CartFailure[] };

export const splitFailures = (failures: readonly CartFailure[]): Split => ({
  drop: failures.filter((f) => problemKind(f.problem) === 'unavailable'),
  fix: failures.filter((f) => problemKind(f.problem) === 'id'),
});
