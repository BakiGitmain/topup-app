/** Maps the database's purchase errors onto something the screen can act on. Pure, no imports. */

export type PurchaseError =
  | 'insufficient'
  | 'unavailable'
  | 'accountId'
  /** No validation record for these exact fields: check the ID again. */
  | 'idNotValidated'
  | 'idExpired'
  | 'idCheckRequired'
  /** The account's region is not one this package serves. */
  | 'regionMismatch'
  /** The supplier reported no region, or nothing can verify it: a locked package can't be sold. */
  | 'regionUnverified'
  | 'generic';

type ErrorLike = { message?: unknown; details?: unknown } | null | undefined;

const text = (v: unknown) => (typeof v === 'string' ? v : '');

export function purchaseErrorKind(error: unknown): PurchaseError {
  const message = text((error as ErrorLike)?.message);
  if (message.includes('insufficient_balance')) return 'insufficient';
  if (message.includes('option_unavailable')) return 'unavailable';
  if (message.includes('id_validation_expired')) return 'idExpired';
  if (message.includes('id_not_validated')) return 'idNotValidated';
  if (message.includes('id_check_required')) return 'idCheckRequired';
  if (message.includes('region_mismatch')) return 'regionMismatch';
  if (message.includes('region_unverified') || message.includes('region_unverifiable')) return 'regionUnverified';
  if (message.includes('account_id') || message.includes('buyer_field')) return 'accountId';
  return 'generic';
}

/** The account region the database named in a region_mismatch error ("ME"), if any. */
export function mismatchRegion(error: unknown): string | null {
  const details = text((error as ErrorLike)?.details).trim();
  return /^[A-Z0-9_-]{1,16}$/.test(details) ? details : null;
}
