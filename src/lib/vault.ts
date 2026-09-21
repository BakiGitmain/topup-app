import { supabase } from './supabase';

export type VaultItem = {
  id: string;
  code: string;
  is_used: boolean;
  created_at: string;
  productName: string;
  optionLabel: string;
};

type VaultRow = {
  id: string;
  code: string;
  is_used: boolean;
  created_at: string;
  orders: { product_name: string; option_label: string } | null;
};

/** Redeemable codes only. Diamonds/UC never appear here: no code exists for them. */
export async function fetchVault(userId: string): Promise<VaultItem[]> {
  const { data, error } = await supabase
    .from('vault_codes')
    .select('id, code, is_used, created_at, orders ( product_name, option_label )')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
  if (error) throw error;

  return ((data ?? []) as unknown as VaultRow[]).map((row) => ({
    id: row.id,
    code: row.code,
    is_used: row.is_used,
    created_at: row.created_at,
    productName: row.orders?.product_name ?? '',
    optionLabel: row.orders?.option_label ?? '',
  }));
}

/** The only change a customer can make to a code. There is no delete. */
export async function setCodeUsed(id: string, used: boolean): Promise<void> {
  const { error } = await supabase.from('vault_codes').update({ is_used: used }).eq('id', id);
  if (error) throw error;
}

const EPOCH = '1970-01-01T00:00:00.000Z';

/** Codes delivered after `since`: the "new code" dot on the Vault tab. */
export async function fetchNewCodeCount(userId: string, since: string | null): Promise<number> {
  const { count, error } = await supabase
    .from('vault_codes')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .gt('created_at', since ?? EPOCH);
  if (error) throw error;
  return count ?? 0;
}

/**
 * Timestamp of the newest code. "Seen" is remembered as this database time
 * (not the phone's clock), so a wrong device clock can't hide a new code.
 */
export async function fetchLatestCodeTime(userId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from('vault_codes')
    .select('created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) throw error;
  return ((data ?? [])[0] as { created_at: string } | undefined)?.created_at ?? null;
}
