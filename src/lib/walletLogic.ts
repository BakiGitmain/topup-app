/**
 * Wallet decisions the screens make: amounts, payout accounts, which way checkout will go, and what the
 * wallet-request function's refusals mean. Pure, no runtime imports (Node tests it directly).
 *
 * None of this is authoritative. The database enforces every rule again (amount limits, balance, account formats); this
 * only lets a screen say "no" early, in words, before a round trip.
 */

/** Keep in step with the SQL in 20260928100000_wallet_requests.sql. */
export const DEPOSIT_MIN = 10;
export const DEPOSIT_MAX = 100_000;
export const WITHDRAW_MIN = 10;

/** "1,250.5" -> 1250.5. Null for anything that isn't a positive amount with at most 2 decimals. */
export function parseAmount(text: string): number | null {
  const cleaned = String(text ?? '').replace(/,/g, '').trim();
  if (!/^[0-9]+(\.[0-9]{1,2})?$/.test(cleaned)) return null;
  const value = Number(cleaned);
  return Number.isFinite(value) && value > 0 ? value : null;
}

export type AmountProblem = 'required' | 'min' | 'max' | 'balance';

export function depositAmountProblem(amount: number | null): AmountProblem | null {
  if (amount === null) return 'required';
  if (amount < DEPOSIT_MIN) return 'min';
  if (amount > DEPOSIT_MAX) return 'max';
  return null;
}

export function withdrawAmountProblem(amount: number | null, balance: number | null): AmountProblem | null {
  if (amount === null) return 'required';
  if (amount < WITHDRAW_MIN) return 'min';
  if (balance === null || cents(amount) > cents(balance)) return 'balance';
  return null;
}

const cents = (n: number) => Math.round(n * 100);

export type PayoutProvider = 'telebirr' | 'cbe';

/**
 * The same clean-up the database does (normalize_payout_account): Telebirr "+251 911 22 33 44", "911223344" and
 * "0911-22-33-44" all become "0911223344"; a CBE number just loses spaces and dashes. Does not judge validity.
 */
export function normalizePayoutAccount(provider: PayoutProvider, raw: string): string {
  let v = String(raw ?? '').replace(/[\s-]/g, '');
  if (provider === 'telebirr') {
    if (/^\+?251[79][0-9]{8}$/.test(v)) v = `0${v.replace(/^\+?251/, '')}`;
    else if (/^[79][0-9]{8}$/.test(v)) v = `0${v}`;
  }
  return v;
}

/** Telebirr: 10 digits starting 09 or 07. CBE: 13 digits. */
export function payoutAccountProblem(provider: PayoutProvider, raw: string): 'required' | 'invalid' | null {
  const v = normalizePayoutAccount(provider, raw);
  if (v === '') return 'required';
  const ok = provider === 'telebirr' ? /^0[79][0-9]{8}$/.test(v) : /^[0-9]{13}$/.test(v);
  return ok ? null : 'invalid';
}

/**
 * Which way checkout will go for this cart: the wallet if the balance covers the whole total, otherwise a bank transfer.
 * All or nothing, never part of each. The database makes the real decision; this is the hint shown on the cart.
 */
export function checkoutPath(balance: number | null, total: number): 'wallet' | 'bank' {
  return balance !== null && total > 0 && cents(balance) >= cents(total) ? 'wallet' : 'bank';
}

/** A ledger line as money in (true) or out (false). */
export const isCredit = (amount: number) => amount > 0;

/** What a failed wallet-request / verify call told us. Anything unexpected is "unavailable". */
export type WalletErrorCode =
  | 'invalid_amount' | 'invalid_provider' | 'invalid_account' | 'insufficient_balance'
  | 'deposit_open' | 'too_many_pending' | 'unauthorized' | 'unavailable';

const CODES: readonly WalletErrorCode[] = [
  'invalid_amount', 'invalid_provider', 'invalid_account', 'insufficient_balance',
  'deposit_open', 'too_many_pending', 'unauthorized', 'unavailable',
];

export function parseWalletFailure(body: unknown): { code: WalletErrorCode; depositId?: string } {
  if (body === null || typeof body !== 'object') return { code: 'unavailable' };
  const d = body as Record<string, unknown>;
  const code = CODES.find((c) => c === d.error) ?? 'unavailable';
  const depositId = typeof d.deposit_id === 'string' && /^[0-9a-f-]{36}$/i.test(d.deposit_id) ? d.deposit_id.toLowerCase() : undefined;
  return code === 'deposit_open' && depositId ? { code, depositId } : { code };
}

/** The customer's-own deposit statuses, and whether the screen is still waiting on the customer. */
export type DepositStatus = 'pending_reference' | 'pending_verification' | 'paid' | 'failed' | 'mismatch';
export const DEPOSIT_STATUSES: readonly DepositStatus[] = ['pending_reference', 'pending_verification', 'paid', 'failed', 'mismatch'];
export const isOpenDeposit = (status: string) => status === 'pending_reference' || status === 'pending_verification';

export type WithdrawalStatus = 'pending' | 'approved' | 'declined' | 'paid';
