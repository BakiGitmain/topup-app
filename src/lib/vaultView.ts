/**
 * How the Vault arranges its three kinds of entry (delivered gift-card codes, received gifts, the customer's own redeem
 * codes) under its filter. Pure, no runtime imports (Node tests it directly).
 */
export type VaultFilter = 'all' | 'cards' | 'gifts' | 'codes';
export const VAULT_FILTERS: readonly VaultFilter[] = ['all', 'cards', 'gifts', 'codes'];

type Card = { id: string; is_used: boolean; created_at: string };
type Gift = { id: string; status: 'pending' | 'claimed' | 'expired'; createdAt: string };
type Code = { id: string; status: 'active' | 'redeemed' | 'expired'; createdAt: string };

export type VaultEntry<C extends Card, G extends Gift, R extends Code> =
  | { kind: 'card'; item: C }
  | { kind: 'gift'; item: G }
  | { kind: 'code'; item: R };

/**
 * Two lists: what can still be acted on (a gift to claim first, then unused gift-card codes, then unused redeem
 * codes), and what is done (claimed/expired gifts, used codes, redeemed/expired redeem codes), each newest first.
 */
export function vaultSections<C extends Card, G extends Gift, R extends Code>(
  filter: VaultFilter,
  data: { cards: readonly C[]; gifts: readonly G[]; codes: readonly R[] }
): { live: VaultEntry<C, G, R>[]; done: VaultEntry<C, G, R>[] } {
  const want = (kind: 'card' | 'gift' | 'code') => filter === 'all' || filter === { card: 'cards', gift: 'gifts', code: 'codes' }[kind];
  const newest = <T extends { at: string }>(list: T[]) => list.sort((a, b) => b.at.localeCompare(a.at));

  const gifts = want('gift') ? data.gifts : [];
  const cards = want('card') ? data.cards : [];
  const codes = want('code') ? data.codes : [];

  const live: VaultEntry<C, G, R>[] = [
    ...newest(gifts.filter((g) => g.status === 'pending').map((item) => ({ kind: 'gift' as const, item, at: item.createdAt }))),
    ...newest(cards.filter((c) => !c.is_used).map((item) => ({ kind: 'card' as const, item, at: item.created_at }))),
    ...newest(codes.filter((c) => c.status === 'active').map((item) => ({ kind: 'code' as const, item, at: item.createdAt }))),
  ].map(({ at: _at, ...entry }) => entry as VaultEntry<C, G, R>);

  const done = newest([
    ...gifts.filter((g) => g.status !== 'pending').map((item) => ({ kind: 'gift' as const, item, at: item.createdAt })),
    ...cards.filter((c) => c.is_used).map((item) => ({ kind: 'card' as const, item, at: item.created_at })),
    ...codes.filter((c) => c.status !== 'active').map((item) => ({ kind: 'code' as const, item, at: item.createdAt })),
  ]).map(({ at: _at, ...entry }) => entry as VaultEntry<C, G, R>);

  return { live, done };
}

/** How many things under a filter still want attention: the number on its chip (0 = no number). */
export function liveCount(filter: VaultFilter, data: { cards: readonly Card[]; gifts: readonly Gift[]; codes: readonly Code[] }): number {
  return vaultSections(filter, data).live.length;
}

const DAY_MS = 86_400_000;

/** Whole days left until an expiry (0 once it has passed): "claim within N days". */
export function daysLeft(expiresAt: string, now: number = Date.now()): number {
  return Math.max(0, Math.ceil((new Date(expiresAt).getTime() - now) / DAY_MS));
}
