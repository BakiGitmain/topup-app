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
