import { supabase } from './supabase';

// Portal Coin: a loyalty currency, earned automatically (the database credits it, the app never writes the balance
// or ledger directly). Redemption is paused for now (see the 20261002090000 migration) -- this file only reads
// balance/history, the same read-only-from-the-app discipline as wallet.ts.

export type PortalCoinKind = 'earn_purchase' | 'earn_purchase_discount' | 'redeem';

export type PortalCoinTransaction = {
  id: string;
  kind: PortalCoinKind;
  /** Signed: positive is earned, negative is redeemed. */
  amount: number;
  balanceAfter: number;
  note: string | null;
  created_at: string;
};

type PortalCoinTransactionRow = {
  id: string;
  kind: PortalCoinKind;
  amount: number | string;
  balance_after: number | string;
  note: string | null;
  created_at: string;
};

export async function fetchPortalCoinBalance(userId: string): Promise<number> {
  const { data, error } = await supabase.from('portal_coin_balances').select('balance').eq('user_id', userId).maybeSingle();
  if (error) throw error;
  return Number(data?.balance ?? 0);
}

export async function fetchPortalCoinTransactions(userId: string, limit = 30): Promise<PortalCoinTransaction[]> {
  const { data, error } = await supabase
    .from('portal_coin_transactions')
    .select('id, kind, amount, balance_after, note, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return ((data ?? []) as PortalCoinTransactionRow[]).map((row) => ({
    id: row.id,
    kind: row.kind,
    amount: Number(row.amount),
    balanceAfter: Number(row.balance_after),
    note: row.note,
    created_at: row.created_at,
  }));
}

/** Portal Coins earned specifically FROM one order (1 or 2, per _complete_order), or null if it hasn't earned any
 * yet (not completed, or completed before Portal Coin existed). For the post-purchase "+N Portal Coin" line. */
export async function fetchPortalCoinEarned(orderId: string): Promise<number | null> {
  const { data, error } = await supabase
    .from('portal_coin_transactions')
    .select('amount')
    .eq('order_id', orderId)
    .in('kind', ['earn_purchase', 'earn_purchase_discount'])
    .maybeSingle();
  if (error) throw error;
  return data ? Number(data.amount) : null;
}
