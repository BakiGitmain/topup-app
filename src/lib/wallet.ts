import { parseVerifyAnswer, type ProviderId, type VerifyAnswer } from './paymentView';
import { supabase } from './supabase';
import { parseWalletFailure, type DepositStatus, type WalletErrorCode, type WithdrawalStatus } from './walletLogic';

// Balance changes are made ONLY by database functions (deposit verification, withdrawal requests, checkout, admin). The app
// reads the balance and the ledger and asks those functions to act; it never writes either, and the Telegram side is
// entirely server-side (the app never knows the bot exists).

export type TransactionKind = 'deposit' | 'purchase' | 'refund' | 'adjustment' | 'withdrawal';

export type Transaction = {
  id: string;
  kind: TransactionKind;
  /** Signed: positive is money in, negative is money out. */
  amount: number;
  /** What the balance was right after this line. */
  balanceAfter: number;
  note: string | null;
  created_at: string;
};

type TransactionRow = {
  id: string;
  kind: TransactionKind;
  amount: number | string;
  balance_after: number | string;
  note: string | null;
  created_at: string;
};

export async function fetchTransactions(userId: string, limit = 30): Promise<Transaction[]> {
  const { data, error } = await supabase
    .from('wallet_transactions')
    .select('id, kind, amount, balance_after, note, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return ((data ?? []) as TransactionRow[]).map((row) => ({
    id: row.id,
    kind: row.kind,
    amount: Number(row.amount),
    balanceAfter: Number(row.balance_after),
    note: row.note,
    created_at: row.created_at,
  }));
}

// ------------------------------------------------------------------ calling the Edge Functions

type Invoked = { ok: true; data: unknown } | { ok: false; code: WalletErrorCode; depositId?: string };

/** Calls an Edge Function and reads a refusal from its JSON body. Never throws. */
async function invoke(name: string, body: Record<string, unknown>): Promise<Invoked> {
  try {
    const { data, error } = await supabase.functions.invoke(name, { body });
    if (!error) return { ok: true, data };
    const response = (error as { context?: { json?: () => Promise<unknown> } }).context;
    const parsed = await response?.json?.().catch(() => null);
    return { ok: false, ...parseWalletFailure(parsed) };
  } catch {
    return { ok: false, code: 'unavailable' };
  }
}

export type DepositAccount = { provider: ProviderId; accountName: string; accountNumber: string };
export type CreatedDeposit = { depositId: string; amount: number };
export type WalletResult<T> = { ok: true; value: T } | { ok: false; code: WalletErrorCode; depositId?: string };

/** Asks for a deposit. The function tells the admin on Telegram; the money isn't touched until a payment is verified. */
export async function requestDeposit(amount: number): Promise<WalletResult<CreatedDeposit>> {
  const r = await invoke('wallet-request', { action: 'deposit', amount });
  if (!r.ok) return r;
  const d = r.data as { deposit_id?: unknown; amount?: unknown } | null;
  if (!d || typeof d.deposit_id !== 'string') return { ok: false, code: 'unavailable' };
  return { ok: true, value: { depositId: d.deposit_id, amount: Number(d.amount) } };
}

/** Asks to withdraw. The amount is held (deducted) at once; an admin sends the money and marks it paid. */
export async function requestWithdrawal(input: { amount: number; provider: ProviderId; account: string }): Promise<WalletResult<{ withdrawalId: string; balance: number }>> {
  const r = await invoke('wallet-request', { action: 'withdraw', ...input });
  if (!r.ok) return r;
  const d = r.data as { withdrawal_id?: unknown; balance?: unknown } | null;
  if (!d || typeof d.withdrawal_id !== 'string') return { ok: false, code: 'unavailable' };
  return { ok: true, value: { withdrawalId: d.withdrawal_id, balance: Number(d.balance) } };
}

/** Checks the payment reference for a deposit (server-side, with ShegerPay). Never throws; unexpected is "unavailable", never "paid". */
export async function verifyDeposit(depositId: string, provider: ProviderId, reference: string): Promise<VerifyAnswer> {
  try {
    const { data, error } = await supabase.functions.invoke('verify-deposit', { body: { deposit_id: depositId, provider, reference } });
    if (error) {
      const status = (error as { context?: { status?: number } }).context?.status;
      return status === 404 ? { result: 'not_found' } : { result: 'unavailable' };
    }
    return parseVerifyAnswer(data);
  } catch {
    return { result: 'unavailable' };
  }
}

export async function cancelDeposit(depositId: string): Promise<void> {
  const { error } = await supabase.rpc('cancel_deposit_request', { p_id: depositId });
  if (error) throw error;
}

/** Pays one of the customer's own unpaid orders from the wallet. Throws the database's refusal (insufficient_balance...). */
export async function payOrderWithWallet(orderId: string): Promise<{ balance: number }> {
  const { data, error } = await supabase.rpc('pay_order_with_wallet', { p_order: orderId });
  if (error) throw error;
  return { balance: Number((data as { balance?: unknown } | null)?.balance ?? 0) };
}

// ------------------------------------------------------------------ deposits and withdrawals the customer can see

export type DepositRequest = {
  id: string;
  amount: number;
  status: DepositStatus;
  provider: ProviderId | null;
  createdAt: string;
};

type DepositRow = { id: string; amount: number | string; status: DepositStatus; payment_provider: ProviderId | null; created_at: string };
const toDeposit = (r: DepositRow): DepositRequest => ({ id: r.id, amount: Number(r.amount), status: r.status, provider: r.payment_provider, createdAt: r.created_at });

export async function fetchDeposit(userId: string, id: string): Promise<DepositRequest | null> {
  const { data, error } = await supabase.from('deposit_requests').select('id, amount, status, payment_provider, created_at').eq('user_id', userId).eq('id', id).maybeSingle();
  if (error) throw error;
  return data ? toDeposit(data as DepositRow) : null;
}

/** The deposit still waiting for a payment, if any (there is at most one per customer). */
export async function fetchOpenDeposit(userId: string): Promise<DepositRequest | null> {
  const { data, error } = await supabase
    .from('deposit_requests')
    .select('id, amount, status, payment_provider, created_at')
    .eq('user_id', userId)
    .in('status', ['pending_reference', 'pending_verification'])
    .maybeSingle();
  if (error) throw error;
  return data ? toDeposit(data as DepositRow) : null;
}

export type Withdrawal = {
  id: string;
  amount: number;
  provider: ProviderId;
  account: string;
  status: WithdrawalStatus;
  adminNote: string | null;
  createdAt: string;
  /** Only filled for admins reading the queue. */
  customer: { name: string; email: string | null } | null;
};

type WithdrawalRow = {
  id: string;
  amount: number | string;
  payout_provider: ProviderId;
  payout_account: string;
  status: WithdrawalStatus;
  admin_note: string | null;
  created_at: string;
  profiles?: { display_name: string | null; email: string | null } | null;
};

const toWithdrawal = (r: WithdrawalRow): Withdrawal => ({
  id: r.id,
  amount: Number(r.amount),
  provider: r.payout_provider,
  account: r.payout_account,
  status: r.status,
  adminNote: r.admin_note,
  createdAt: r.created_at,
  customer: r.profiles ? { name: r.profiles.display_name?.trim() || 'Customer', email: r.profiles.email } : null,
});

const WITHDRAWAL_COLUMNS = 'id, amount, payout_provider, payout_account, status, admin_note, created_at';

export async function fetchMyWithdrawals(userId: string, limit = 20): Promise<Withdrawal[]> {
  const { data, error } = await supabase.from('withdrawal_requests').select(WITHDRAWAL_COLUMNS).eq('user_id', userId).order('created_at', { ascending: false }).limit(limit);
  if (error) throw error;
  return ((data ?? []) as WithdrawalRow[]).map(toWithdrawal);
}

// ------------------------------------------------------------------ admin

/** Withdrawals waiting for the admin, oldest first, with who asked. Row security limits this to admins. */
export async function fetchPendingWithdrawals(): Promise<Withdrawal[]> {
  const { data, error } = await supabase
    .from('withdrawal_requests')
    .select(`${WITHDRAWAL_COLUMNS}, profiles:user_id (display_name, email)`)
    .eq('status', 'pending')
    .order('created_at', { ascending: true });
  if (error) throw error;
  return ((data ?? []) as unknown as WithdrawalRow[]).map(toWithdrawal);
}

/** Recently settled ones, for the admin's history. */
export async function fetchResolvedWithdrawals(limit = 20): Promise<Withdrawal[]> {
  const { data, error } = await supabase
    .from('withdrawal_requests')
    .select(`${WITHDRAWAL_COLUMNS}, profiles:user_id (display_name, email)`)
    .neq('status', 'pending')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return ((data ?? []) as unknown as WithdrawalRow[]).map(toWithdrawal);
}

export async function fetchPendingWithdrawalCount(): Promise<number> {
  const { count, error } = await supabase.from('withdrawal_requests').select('id', { count: 'exact', head: true }).eq('status', 'pending');
  if (error) throw error;
  return count ?? 0;
}

/** Approve = "I sent the money" (marks it paid). Decline = refund the held amount; a note is required. Throws the refusal. */
export async function resolveWithdrawal(id: string, approve: boolean, note: string): Promise<void> {
  const { error } = await supabase.rpc('admin_resolve_withdrawal', { p_id: id, p_approve: approve, p_note: note.trim() === '' ? null : note.trim() });
  if (error) throw error;
}

/** Words for a refusal from admin_resolve_withdrawal. */
export function resolveErrorText(error: unknown): string {
  const message = String((error as { message?: unknown } | null)?.message ?? '');
  if (message.includes('already_resolved')) return 'Someone already handled this one. Pull to refresh.';
  if (message.includes('note_required')) return 'Write a short reason: the customer will see it.';
  if (message.includes('forbidden')) return 'Only an admin can do this.';
  return "Couldn't update it. Check your connection and try again.";
}
