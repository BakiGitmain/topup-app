import { supabase } from './supabase';

// The prize wheel: read-only fetches of what the customer can see (active prizes, active packages, their own spin
// credits and unredeemed wins), plus the two actions (buy, spin). The database is the only writer of every balance
// and every prize -- this file never invents a result, it only reports what the server already decided.

export type WheelPrize = { id: string; label: string; discountBirr: number; weight: number };

/** Active prizes, in the SAME order spin_wheel() uses server-side (created_at, id) -- the wheel screen must draw
 * slices in this order, or the index a spin returns would point at the wrong one visually. */
export async function fetchActiveWheelPrizes(): Promise<WheelPrize[]> {
  const { data, error } = await supabase.from('wheel_prizes').select('id, label, discount_birr, weight').eq('active', true).order('created_at', { ascending: true }).order('id', { ascending: true });
  if (error) throw error;
  return ((data ?? []) as { id: string; label: string; discount_birr: number | string; weight: number }[]).map((r) => ({
    id: r.id,
    label: r.label,
    discountBirr: Number(r.discount_birr),
    weight: r.weight,
  }));
}

export type SpinPackage = { id: string; spinsCount: number; portalCoinCost: number };

export async function fetchActiveSpinPackages(): Promise<SpinPackage[]> {
  const { data, error } = await supabase.from('wheel_spin_packages').select('id, spins_count, portal_coin_cost').eq('active', true).order('sort_order', { ascending: true });
  if (error) throw error;
  return ((data ?? []) as { id: string; spins_count: number; portal_coin_cost: number }[]).map((r) => ({
    id: r.id,
    spinsCount: r.spins_count,
    portalCoinCost: r.portal_coin_cost,
  }));
}

export async function fetchSpinCredits(userId: string): Promise<number> {
  const { data, error } = await supabase.from('wheel_spin_credits').select('credits').eq('user_id', userId).maybeSingle();
  if (error) throw error;
  return data?.credits ?? 0;
}

export type WonPrize = { id: string; label: string; discountBirr: number; wonAt: string };

/** The customer's own unredeemed prizes, oldest first (see the migration header for why oldest, not smallest). */
export async function fetchUnredeemedPrizes(userId: string): Promise<WonPrize[]> {
  const { data, error } = await supabase
    .from('wheel_prizes_won')
    .select('id, label, discount_birr, won_at')
    .eq('customer_id', userId)
    .is('redeemed_at', null)
    .order('won_at', { ascending: true });
  if (error) throw error;
  return ((data ?? []) as { id: string; label: string; discount_birr: number | string; won_at: string }[]).map((r) => ({
    id: r.id,
    label: r.label,
    discountBirr: Number(r.discount_birr),
    wonAt: r.won_at,
  }));
}

export type BuyPackageResult = { spinsBought: number; spinCredits: number; coinBalance: number };

export async function buySpinPackage(packageId: string): Promise<BuyPackageResult> {
  const { data, error } = await supabase.rpc('buy_spin_package', { p_package_id: packageId });
  if (error) throw error;
  const d = data as { spins_bought?: unknown; spin_credits?: unknown; coin_balance?: unknown } | null;
  return { spinsBought: Number(d?.spins_bought ?? 0), spinCredits: Number(d?.spin_credits ?? 0), coinBalance: Number(d?.coin_balance ?? 0) };
}

export type SpinResult = {
  wonId: string;
  prizeId: string;
  label: string;
  discountBirr: number;
  /** 0-based position among the active prizes the client rendered, in the same (created_at, id) order. */
  index: number;
  totalPrizes: number;
  spinCredits: number;
};

/** The prize is ALREADY DECIDED by the time this resolves -- spin_wheel() picks it server-side before returning.
 * The caller only animates to `index`; it never influences the outcome. */
export async function spinWheel(): Promise<SpinResult> {
  const { data, error } = await supabase.rpc('spin_wheel');
  if (error) throw error;
  const d = data as {
    won_id?: unknown; prize_id?: unknown; label?: unknown; discount_birr?: unknown; index?: unknown; total_prizes?: unknown; spin_credits?: unknown;
  } | null;
  if (!d || typeof d.won_id !== 'string' || typeof d.prize_id !== 'string' || typeof d.index !== 'number') throw new Error('spin_failed');
  return {
    wonId: d.won_id,
    prizeId: d.prize_id,
    label: String(d.label ?? ''),
    discountBirr: Number(d.discount_birr ?? 0),
    index: d.index,
    totalPrizes: Number(d.total_prizes ?? 0),
    spinCredits: Number(d.spin_credits ?? 0),
  };
}

export function wheelErrorText(error: unknown): string {
  const message = String((error as { message?: unknown } | null)?.message ?? '');
  if (message.includes('insufficient_portal_coins')) return "You don't have enough Portal Coins for that package.";
  if (message.includes('insufficient_spin_credits')) return "You don't have any spins left. Buy more to keep playing.";
  if (message.includes('package_not_found')) return "That package isn't available any more.";
  if (message.includes('no_active_prizes')) return 'The wheel has no prizes right now. Try again later.';
  if (message.includes('not_authenticated')) return 'Please sign in again.';
  return "Couldn't do that right now. Check your connection and try again.";
}
