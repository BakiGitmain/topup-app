import type { BuyerField } from './idValidation';
import { supabase } from './supabase';

export type VaultItem = {
  id: string;
  code: string;
  is_used: boolean;
  created_at: string;
  productName: string;
  optionLabel: string;
  /** What was actually paid, in birr -- shown as a small caption next to the denomination, never the headline figure. */
  amount: number;
};

type VaultRow = {
  id: string;
  code: string;
  is_used: boolean;
  created_at: string;
  orders: { product_name: string; option_label: string; amount: number | string } | null;
};

/** Redeemable codes only. Diamonds/UC never appear here: no code exists for them. */
export async function fetchVault(userId: string): Promise<VaultItem[]> {
  const { data, error } = await supabase
    .from('vault_codes')
    .select('id, code, is_used, created_at, orders ( product_name, option_label, amount )')
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
    amount: Number(row.orders?.amount ?? 0),
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

// ------------------------------------------------------------------ gifts and redeem codes (my_vault_gifts / my_redeem_codes)

export type GiftStatus = 'pending' | 'claimed' | 'expired';

/** A gift received: everything its claim card needs. */
export type VaultGift = {
  id: string;
  status: GiftStatus;
  createdAt: string;
  expiresAt: string;
  claimedAt: string | null;
  fromCode: boolean;
  senderName: string | null;
  senderAvatar: string | null;
  productId: string;
  productName: string;
  imageUrl: string | null;
  tint: string | null;
  category: string;
  optionLabel: string;
  regionId: string | null;
  regionLabel: string | null;
  buyerFields: BuyerField[];
  idValidation: 'supplier' | 'none';
  regionLocked: boolean;
  accountRegionCodes: string[];
  idSectionTitle: string | null;
  idSectionHint: string | null;
  /** The recipient's delivery order, once claimed, and where it stands. */
  deliveryOrderId: string | null;
  deliveryStatus: string | null;
};

export async function fetchVaultGifts(): Promise<VaultGift[]> {
  const { data, error } = await supabase.rpc('my_vault_gifts');
  if (error) throw error;
  return ((data ?? []) as Record<string, unknown>[]).map((g) => ({
    id: String(g.id),
    status: (g.status === 'claimed' || g.status === 'expired' ? g.status : 'pending') as GiftStatus,
    createdAt: String(g.created_at),
    expiresAt: String(g.expires_at),
    claimedAt: (g.claimed_at as string | null) ?? null,
    fromCode: g.from_code === true,
    senderName: (g.sender_name as string | null) ?? null,
    senderAvatar: (g.sender_avatar as string | null) ?? null,
    productId: String(g.product_id),
    productName: String(g.product_name ?? ''),
    imageUrl: (g.image_url as string | null) ?? null,
    tint: (g.tint as string | null) ?? null,
    category: String(g.category ?? ''),
    optionLabel: String(g.option_label ?? ''),
    regionId: (g.region_id as string | null) ?? null,
    regionLabel: (g.region_label as string | null) ?? null,
    buyerFields: ((Array.isArray(g.buyer_fields) ? g.buyer_fields : []) as BuyerField[]).map((f) => ({ ...f, type: f.type === 'select' ? 'select' : 'text' })),
    idValidation: g.id_validation === 'supplier' ? 'supplier' : 'none',
    regionLocked: g.region_locked === true,
    accountRegionCodes: (Array.isArray(g.account_region_codes) ? g.account_region_codes : []) as string[],
    idSectionTitle: (g.id_section_title as string | null) ?? null,
    idSectionHint: (g.id_section_hint as string | null) ?? null,
    deliveryOrderId: (g.delivery_order_id as string | null) ?? null,
    deliveryStatus: (g.delivery_status as string | null) ?? null,
  }));
}

export type RedeemCodeStatus = 'active' | 'redeemed' | 'expired';

/** A redeem code the signed-in user bought: the second place (after the reveal screen) to copy it. */
export type VaultRedeemCode = {
  id: string;
  code: string;
  status: RedeemCodeStatus;
  createdAt: string;
  expiresAt: string;
  redeemedAt: string | null;
  productName: string;
  imageUrl: string | null;
  tint: string | null;
  optionLabel: string;
};

export async function fetchMyRedeemCodes(): Promise<VaultRedeemCode[]> {
  const { data, error } = await supabase.rpc('my_redeem_codes');
  if (error) throw error;
  return ((data ?? []) as Record<string, unknown>[]).map((c) => ({
    id: String(c.id),
    code: String(c.code),
    status: (c.status === 'redeemed' || c.status === 'expired' ? c.status : 'active') as RedeemCodeStatus,
    createdAt: String(c.created_at),
    expiresAt: String(c.expires_at),
    redeemedAt: (c.redeemed_at as string | null) ?? null,
    productName: String(c.product_name ?? ''),
    imageUrl: (c.image_url as string | null) ?? null,
    tint: (c.tint as string | null) ?? null,
    optionLabel: String(c.option_label ?? ''),
  }));
}
