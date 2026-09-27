import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import {
  canAddAccount,
  classifyRefreshFailure,
  markNeedsSignIn,
  removeAccount,
  upsertAccount,
  type RefreshFailure,
  type SavedAccount,
} from './accountsLogic';
import {
  MULTI_ACCOUNT_ENABLED,
  forgetRefreshToken,
  loadRefreshToken,
  loadSavedAccounts,
  storeRefreshToken,
  storeSavedAccounts,
} from './accountStore';
import { useAuth } from './auth';
import { SUPABASE_ANON_KEY, SUPABASE_URL, supabase } from './supabase';

export type SwitchResult = 'ok' | 'same' | 'needs_sign_in' | Exclude<RefreshFailure, 'expired'>;

type AccountsValue = {
  enabled: boolean;
  accounts: SavedAccount[];
  /** The signed-in account. Not stored separately: it IS the Supabase session, which already survives restarts. */
  activeId: string | null;
  canAdd: boolean;
  switchTo: (id: string) => Promise<SwitchResult>;
  /** Removes an account from THIS DEVICE only. Never deletes it, and never signs it out anywhere else. */
  remove: (id: string) => Promise<void>;
};

const AccountsContext = createContext<AccountsValue | undefined>(undefined);

type FreshSession = { access_token: string; refresh_token: string };

/**
 * Trades a saved refresh token for a fresh session with a direct call, deliberately NOT through the Supabase
 * client: when the client's own refresh fails, it deletes whatever session is currently active. Checking first
 * means a dead saved token just asks for a re-sign-in, and the account in use stays signed in.
 */
async function exchangeRefreshToken(refreshToken: string): Promise<{ ok: true; session: FreshSession } | { ok: false; reason: RefreshFailure }> {
  let res: Response;
  try {
    res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
  } catch {
    return { ok: false, reason: 'network' };
  }
  if (!res.ok) return { ok: false, reason: classifyRefreshFailure(res.status) };
  const body = (await res.json().catch(() => null)) as Partial<FreshSession> | null;
  if (!body?.access_token || !body.refresh_token) return { ok: false, reason: 'failed' };
  return { ok: true, session: { access_token: body.access_token, refresh_token: body.refresh_token } };
}

/**
 * Remembers every account signed in on this device (up to MAX_ACCOUNTS) and switches between them.
 *
 * - Whichever account is signed in is always saved, with its CURRENT refresh token (Supabase rotates it on every
 *   refresh, so it's re-saved each time it changes -- an old one would be dead by the time it's needed).
 * - "Add account" is simply signing in again: the new session replaces the old one in the client, and the old one
 *   is already saved here, so nothing is lost.
 * - Any sign-out (the Sign out button, or a session that died) drops that account from the list.
 *
 * Per-user state reset on a switch is NOT done here by clearing things: every per-user store in the app (auth's
 * profile/balance, the cart, the badges, each screen's data) is keyed by the user id and ignores data for another
 * id, and the switcher sends the app back through the index route, which rebuilds the home screen for the new
 * account (admin or customer).
 */
export function AccountsProvider({ children }: { children: ReactNode }) {
  const { session, profile, isAdmin } = useAuth();
  const [accounts, setAccounts] = useState<SavedAccount[]>([]);
  const [loaded, setLoaded] = useState(false);
  const accountsRef = useRef<SavedAccount[]>([]);
  const lastActiveRef = useRef<string | null>(null);
  const activeId = session?.user.id ?? null;
  const refreshToken = session?.refresh_token ?? null;

  const commit = useCallback(async (next: SavedAccount[]) => {
    accountsRef.current = next;
    setAccounts(next);
    await storeSavedAccounts(next);
  }, []);

  useEffect(() => {
    if (!MULTI_ACCOUNT_ENABLED) return;
    let live = true;
    loadSavedAccounts().then((list) => {
      if (!live) return;
      accountsRef.current = list;
      setAccounts(list);
      setLoaded(true);
    });
    return () => {
      live = false;
    };
  }, []);

  // Keep the signed-in account saved, with its latest refresh token.
  useEffect(() => {
    if (!MULTI_ACCOUNT_ENABLED || !loaded || !activeId || !refreshToken) return;
    lastActiveRef.current = activeId;
    const email = session?.user.email ?? null;
    const entry: SavedAccount = {
      id: activeId,
      displayName: profile?.display_name ?? null,
      email,
      avatarUrl: profile?.avatar_url ?? null,
      isAdmin,
      lastUsedAt: Date.now(),
    };
    (async () => {
      await storeRefreshToken(activeId, refreshToken);
      const { list, dropped } = upsertAccount(accountsRef.current, entry);
      await Promise.all(dropped.map(forgetRefreshToken));
      await commit(list);
    })().catch(() => {});
  }, [loaded, activeId, refreshToken, profile?.display_name, profile?.avatar_url, isAdmin, session?.user.email, commit]);

  // A signed-out account can't be switched back to (its session was ended): take it off the list.
  useEffect(() => {
    if (!MULTI_ACCOUNT_ENABLED) return;
    const { data } = supabase.auth.onAuthStateChange((event) => {
      if (event !== 'SIGNED_OUT') return;
      const gone = lastActiveRef.current;
      lastActiveRef.current = null;
      if (!gone) return;
      forgetRefreshToken(gone);
      commit(removeAccount(accountsRef.current, gone)).catch(() => {});
    });
    return () => data.subscription.unsubscribe();
  }, [commit]);

  const switchTo = useCallback(
    async (id: string): Promise<SwitchResult> => {
      if (id === activeId) return 'same';
      const saved = await loadRefreshToken(id);
      if (!saved) {
        await commit(markNeedsSignIn(accountsRef.current, id));
        return 'needs_sign_in';
      }
      const fresh = await exchangeRefreshToken(saved);
      if (!fresh.ok) {
        if (fresh.reason !== 'expired') return fresh.reason;
        await forgetRefreshToken(id);
        await commit(markNeedsSignIn(accountsRef.current, id));
        return 'needs_sign_in';
      }
      // The old token was just used up; keep the new one right away in case the next step fails.
      await storeRefreshToken(id, fresh.session.refresh_token);
      const { error } = await supabase.auth.setSession({ access_token: fresh.session.access_token, refresh_token: fresh.session.refresh_token });
      return error ? 'failed' : 'ok';
    },
    [activeId, commit]
  );

  const remove = useCallback(
    async (id: string) => {
      if (id === activeId) {
        // This device's session only. Scope 'global' would end the account's sessions on every other device too.
        await supabase.auth.signOut({ scope: 'local' });
      }
      await forgetRefreshToken(id);
      await commit(removeAccount(accountsRef.current, id));
    },
    [activeId, commit]
  );

  const value = useMemo<AccountsValue>(
    () => ({ enabled: MULTI_ACCOUNT_ENABLED, accounts, activeId, canAdd: canAddAccount(accounts), switchTo, remove }),
    [accounts, activeId, switchTo, remove]
  );

  return <AccountsContext.Provider value={value}>{children}</AccountsContext.Provider>;
}

export function useAccounts(): AccountsValue {
  const value = useContext(AccountsContext);
  if (!value) throw new Error('useAccounts must be used inside AccountsProvider');
  return value;
}
