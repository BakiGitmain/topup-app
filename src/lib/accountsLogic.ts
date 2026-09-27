/** Saved-accounts rules for the account switcher. Pure, no imports (Node tests it directly). */

/** Same as Telegram: a small number, so the switcher stays one short card. */
export const MAX_ACCOUNTS = 3;

/** What the device remembers about an account. Never a password; the refresh token is stored separately, in
 * secure storage, under tokenKey(id). */
export type SavedAccount = {
  id: string;
  displayName: string | null;
  email: string | null;
  avatarUrl: string | null;
  isAdmin: boolean;
  lastUsedAt: number;
  /** Its saved session stopped working (expired or revoked): it stays listed so the person can sign back in. */
  needsSignIn?: boolean;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const ACCOUNTS_INDEX_KEY = 'portal.accounts.v1';

/** Secure-store keys may only hold letters, digits, '.', '-' and '_': a user id is a UUID, which fits. Anything else
 * is refused rather than turned into some other key. */
export function tokenKey(id: string): string {
  if (!UUID.test(id)) throw new Error('bad_account_id');
  return `portal.rt.${id}`;
}

/** Reads the stored list defensively: anything malformed is dropped, never trusted. */
export function parseSavedAccounts(raw: string | null | undefined): SavedAccount[] {
  if (!raw) return [];
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const seen = new Set<string>();
  const out: SavedAccount[] = [];
  for (const a of data) {
    if (!a || typeof a !== 'object') continue;
    const r = a as Record<string, unknown>;
    if (typeof r.id !== 'string' || !UUID.test(r.id) || seen.has(r.id)) continue;
    seen.add(r.id);
    out.push({
      id: r.id,
      displayName: typeof r.displayName === 'string' ? r.displayName : null,
      email: typeof r.email === 'string' ? r.email : null,
      avatarUrl: typeof r.avatarUrl === 'string' ? r.avatarUrl : null,
      isAdmin: r.isAdmin === true,
      lastUsedAt: typeof r.lastUsedAt === 'number' ? r.lastUsedAt : 0,
      needsSignIn: r.needsSignIn === true ? true : undefined,
    });
  }
  return out.slice(0, MAX_ACCOUNTS);
}

/**
 * Adds or refreshes an account. An account already on the list is updated in place (never duplicated). If adding a
 * new one would pass MAX_ACCOUNTS -- only possible through a sign-in that didn't go through "Add account", which
 * checks the limit first -- the least recently used account that ISN'T the new one is dropped, so a real sign-in is
 * never refused. Returns the new list and the ids that were dropped (their tokens must be deleted too).
 */
export function upsertAccount(list: readonly SavedAccount[], account: SavedAccount): { list: SavedAccount[]; dropped: string[] } {
  const existing = list.findIndex((a) => a.id === account.id);
  if (existing >= 0) {
    const next = [...list];
    next[existing] = { ...account, needsSignIn: undefined };
    return { list: next, dropped: [] };
  }
  let next = [...list, { ...account, needsSignIn: undefined }];
  const dropped: string[] = [];
  while (next.length > MAX_ACCOUNTS) {
    const victim = next
      .filter((a) => a.id !== account.id)
      .sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0];
    dropped.push(victim.id);
    next = next.filter((a) => a.id !== victim.id);
  }
  return { list: next, dropped };
}

export function removeAccount(list: readonly SavedAccount[], id: string): SavedAccount[] {
  return list.filter((a) => a.id !== id);
}

export function markNeedsSignIn(list: readonly SavedAccount[], id: string): SavedAccount[] {
  return list.map((a) => (a.id === id ? { ...a, needsSignIn: true } : a));
}

/** "Add account" is allowed while there's room for one more. */
export function canAddAccount(list: readonly SavedAccount[]): boolean {
  return list.length < MAX_ACCOUNTS;
}

export type RefreshFailure = 'expired' | 'network' | 'failed';

/**
 * Why swapping in a saved refresh token didn't work. 'expired' (the token was revoked, rotated away, or the
 * account is gone: the auth server answers 400/401/403/404 for all of these) means the person has to sign in again;
 * 'network' (no response at all) and 'failed' (anything else, e.g. a 5xx) are worth simply retrying.
 */
export function classifyRefreshFailure(status: number | null): RefreshFailure {
  if (status === null || status === 0) return 'network';
  if (status === 400 || status === 401 || status === 403 || status === 404) return 'expired';
  return 'failed';
}
