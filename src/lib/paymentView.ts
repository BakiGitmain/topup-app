/** Payment screen decisions: providers, the verify-payment answer, and what to tell the customer. Pure, no imports. */

export const PROVIDER_IDS = ['telebirr', 'cbe'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

/**
 * "ft24 352" -> "FT24352". The same rule as the server (supabase/functions/_shared/shegerpay.ts normalizeReference; a test
 * keeps the two identical). Null unless it is 4-64 letters, digits, "_" or "-" once spaces are gone.
 */
export function cleanReference(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const ref = input.replace(/\s+/g, '').toUpperCase();
  return /^[A-Z0-9_-]{4,64}$/.test(ref) ? ref : null;
}

export const isProviderId = (value: unknown): value is ProviderId => typeof value === 'string' && (PROVIDER_IDS as readonly string[]).includes(value);

export type VerifyAnswer = {
  result:
    | 'paid' | 'already_paid' | 'closed' | 'mismatch' | 'not_verified'
    | 'reference_used' | 'in_progress' | 'unavailable' | 'not_found';
  status?: string;
  reason?: 'not_found' | 'provider_mismatch' | 'pending' | 'invalid_request' | 'unknown';
};

const RESULTS: readonly VerifyAnswer['result'][] = ['paid', 'already_paid', 'closed', 'mismatch', 'not_verified', 'reference_used', 'in_progress', 'unavailable', 'not_found'];
const REASONS: readonly NonNullable<VerifyAnswer['reason']>[] = ['not_found', 'provider_mismatch', 'pending', 'invalid_request', 'unknown'];

/** Anything unexpected is "unavailable" (try again), never "paid". */
export function parseVerifyAnswer(data: unknown): VerifyAnswer {
  if (data === null || typeof data !== 'object') return { result: 'unavailable' };
  const d = data as Record<string, unknown>;
  const result = RESULTS.find((r) => r === d.result);
  if (!result) return { result: 'unavailable' };
  const reason = REASONS.find((r) => r === d.reason);
  return { result, ...(typeof d.status === 'string' ? { status: d.status } : {}), ...(reason ? { reason } : {}) };
}

/** What the screen does next. */
export type Next =
  | { action: 'paid' }
  | { action: 'mismatch' }
  | { action: 'closed'; status: string }
  /** The reference is wrong or not found: stay, let them correct it. */
  | { action: 'fix_reference'; messageKey: string }
  | { action: 'reference_used' }
  /** Another request is already checking: wait a moment, then read the order. */
  | { action: 'wait' }
  | { action: 'try_later' };

export function nextStep(answer: VerifyAnswer): Next {
  switch (answer.result) {
    case 'paid':
    case 'already_paid':
      return { action: 'paid' };
    case 'mismatch':
      return { action: 'mismatch' };
    case 'closed':
      return answer.status === 'paid' ? { action: 'paid' } : answer.status === 'payment_mismatch' ? { action: 'mismatch' } : { action: 'closed', status: answer.status ?? 'unknown' };
    case 'reference_used':
      return { action: 'reference_used' };
    case 'in_progress':
      return { action: 'wait' };
    case 'not_verified':
      return { action: 'fix_reference', messageKey: `pay.notVerified.${answer.reason ?? 'unknown'}` };
    case 'not_found':
    case 'unavailable':
      return { action: 'try_later' };
  }
}

/** The order statuses that mean "nothing more to enter here". */
export const isSettled = (status: string) => status !== 'pending_payment';

/** The payment genuinely succeeded -- 'paid' is only the FIRST success status; fulfilment can move an order on to
 * 'processing' or 'completed' before the customer ever reopens this screen (auto-fulfilment, or an admin
 * delivering it). All three must show a success screen, never the neutral "no longer waiting for payment" state a
 * cancelled/failed/refunded order gets -- those are also `isSettled`, but never a success. */
export const isPaymentSuccess = (status: string) => status === 'paid' || status === 'processing' || status === 'completed';

/** "Br 1,250" for the amount to send: exact, no rounding surprises. */
export function amountToSend(amount: number): string {
  const fixed = Number.isInteger(amount) ? String(amount) : amount.toFixed(2);
  const [whole, cents] = fixed.split('.');
  return `Br ${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${cents ? `.${cents}` : ''}`;
}
