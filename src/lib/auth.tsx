import type { Session, User } from '@supabase/supabase-js';
import { router } from 'expo-router';
import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Platform } from 'react-native';

import { supabase } from './supabase';

// Dismisses any auth-session popup left open from a previous run (mainly a web/dev-reload concern) -- the
// official Supabase + Expo pattern, run once when this module loads.
WebBrowser.maybeCompleteAuthSession();

export type Role = 'user' | 'admin';

export type Profile = {
  id: string;
  display_name: string;
  email: string | null;
  avatar_url: string | null;
  role: Role;
  language: 'en' | 'am';
  /** True only for an account with no real chosen name yet (a Google sign-in: nothing in this app's signup form
   * runs, so there is nothing to read a display_name from). Gates the "choose a username" step -- see index.tsx. */
  needs_username: boolean;
  /** A content creator (set by an admin): can host tournaments. */
  is_content_creator: boolean;
};

type Account = {
  userId: string;
  profile: Profile | null;
  balance: number | null;
};

type AuthContextValue = {
  session: Session | null;
  user: User | null;
  profile: Profile | null;
  /** Wallet balance in birr. Null until loaded, or if it couldn't be read. */
  balance: number | null;
  /** UI convenience only. Real enforcement is row level security in Supabase. */
  isAdmin: boolean;
  /** Can host tournaments. UI convenience only: tournament_create checks it again. */
  isContentCreator: boolean;
  /**
   * True until the session is known and, when signed in, the account
   * (profile + wallet) has loaded. Route decisions wait on this so an admin is
   * never briefly treated as a customer.
   */
  initializing: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (
    displayName: string,
    email: string,
    password: string
  ) => Promise<{ needsEmailConfirmation: boolean }>;
  /** One button for both: Supabase's OAuth flow signs in an existing account or creates a new one from the same
   * Google identity, transparently -- there is no separate "new account" branch to gate here. Throws 'cancelled'
   * if the customer backs out of the Google sheet without finishing (not a real error, callers should stay quiet). */
  signInWithGoogle: () => Promise<void>;
  /** Finishes the "choose a username" step (see Profile.needs_username). */
  completeUsername: (displayName: string) => Promise<void>;
  signOut: () => Promise<void>;
  refreshAccount: () => Promise<void>;
  /** Web only: set when Google/Supabase's own callback redirects back with ?error= instead of ?code= (consent
   * denied, an unverified-app block, a bad provider secret server-side, anything) -- the real reason, read
   * straight off the URL, not silently dropped. A screen reads this once (see sign-in.tsx) and clears it. */
  oauthError: string | null;
  clearOAuthError: () => void;
};

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

/** Always resolves: a failed read leaves the fields null instead of hanging. */
async function loadAccount(userId: string): Promise<Account> {
  const [profileRes, walletRes] = await Promise.all([
    supabase
      .from('profiles')
      .select('id, display_name, email, avatar_url, role, language, needs_username, is_content_creator')
      .eq('id', userId)
      .maybeSingle(),
    supabase.from('wallets').select('balance').eq('user_id', userId).maybeSingle(),
  ]);

  if (__DEV__) {
    if (profileRes.error) {
      console.warn('[auth] could not load profile:', profileRes.error.message);
    } else if (!profileRes.data) {
      console.warn('[auth] no profiles row for user', userId);
    }
    if (walletRes.error) {
      console.warn('[auth] could not load wallet:', walletRes.error.message);
    }
  }

  return {
    userId,
    profile: profileRes.error ? null : ((profileRes.data as Profile | null) ?? null),
    balance:
      walletRes.error || !walletRes.data ? null : Number(walletRes.data.balance),
  };
}

/** True only on web, only when the URL still carries the ?code= Supabase's OAuth callback leaves behind. Read
 * synchronously into useState's initializer (not an effect) so it is correct from the very first render --
 * `initializing` must never have a tick where it doesn't yet know an exchange is about to start. */
function hasPendingWebCode(): boolean {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return false;
  return new URL(window.location.href).searchParams.has('code');
}

/** Same idea, for the OAuth failure shape: ?error=...&error_description=... with no ?code=. */
function hasPendingWebOAuthError(): boolean {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return false;
  const params = new URL(window.location.href).searchParams;
  return params.has('error') || params.has('error_description');
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [sessionChecked, setSessionChecked] = useState(false);
  const [account, setAccount] = useState<Account | null>(null);
  // FIXED: a real race, confirmed live -- getSession() resolves fast from local storage (no session yet, since
  // the code hasn't been exchanged), which used to make `initializing` false while this exchange was still in
  // flight. index.tsx would then see "not initializing, no session" and redirect to /splash before the real
  // session ever arrived -- the exact loop this was built to diagnose. This flag keeps `initializing` true for
  // the whole exchange, not just for the fast local check.
  const [exchangingCode, setExchangingCode] = useState(() => hasPendingWebCode() || hasPendingWebOAuthError());
  const [oauthError, setOAuthError] = useState<string | null>(null);

  const userId = session?.user.id ?? null;
  // The signed-in user RIGHT NOW, updated the instant an auth event arrives (before React re-renders). A profile load
  // that finishes after the user changed -- e.g. a refresh started for account B that lands after a switch to A --
  // must never overwrite the new user's account: nothing would ever reload it, and the app would wait forever.
  const userIdRef = useRef<string | null>(null);
  useEffect(() => {
    userIdRef.current = userId;
  }, [userId]);
  const applyAccount = useCallback((next: Account) => {
    if (next.userId === userIdRef.current) setAccount(next);
  }, []);

  useEffect(() => {
    let active = true;

    supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      setSession(data.session);
      setSessionChecked(true);
    });

    const { data: listener } = supabase.auth.onAuthStateChange(
      (event, nextSession) => {
        userIdRef.current = nextSession?.user.id ?? null;
        setSession(nextSession);
        if (event === 'SIGNED_OUT') setAccount(null);
      }
    );

    return () => {
      active = false;
      listener.subscription.unsubscribe();
    };
  }, []);

  // Web only: picks up the ?code= (or ?error=) Supabase's OAuth callback leaves in the URL after the full-page
  // redirect signInWithGoogle() sends web to (see its own comment -- a popup is unreliable here, confirmed live).
  // Native never reaches this: its callback is caught directly inside signInWithGoogle() via openAuthSessionAsync.
  // supabase.ts sets detectSessionInUrl: false project-wide (deliberately, for native's sake), so nothing else
  // does this automatically.
  //
  // FIXED: a real, silent failure mode, found by direct code inspection after "still lands on /splash, and
  // auth.identities stays empty even after actively picking a real account" ruled out everything before this
  // point. If Supabase's OWN callback fails for ANY reason after Google redirects to it (consent denied, the
  // account blocked by an unverified-app check, a bad provider secret server-side, anything at all), it sends
  // the browser back here with ?error=...&error_description=... and NO ?code=. The old version of this effect
  // only ever checked for `code` -- an error came back exactly as silently as no attempt at all, and the
  // customer (and every diagnosis so far) had zero visibility into what Supabase actually said. Now surfaced.
  useEffect(() => {
    if (!hasPendingWebCode() && !hasPendingWebOAuthError()) return;
    // Every branch below sets state; done inside an async task (even the error branch, which needs no real
    // await) so this effect's own body stays a pure "kick it off" -- matching the rule every setState-after-an-
    // effect in this file already follows.
    (async () => {
      const url = new URL(window.location.href);
      const code = url.searchParams.get('code');
      const oauthErrorDescription = url.searchParams.get('error_description') || url.searchParams.get('error');

      // Cleared either way before anything else happens: a PKCE code is single-use (a refresh must never resend
      // it), and a stale error must never keep re-showing on every reload of this URL either.
      url.searchParams.delete('code');
      url.searchParams.delete('error');
      url.searchParams.delete('error_description');
      window.history.replaceState({}, '', url.toString());

      if (!code) {
        console.error('[auth] Google sign-in failed at the provider/Supabase callback:', oauthErrorDescription);
        setOAuthError(oauthErrorDescription);
        setExchangingCode(false);
        router.replace('/sign-in');
        return;
      }

      const { data, error } = await supabase.auth.exchangeCodeForSession(code);
      if (error) {
        console.error('[auth] code exchange failed:', error.message);
        setOAuthError(error.message);
        router.replace('/sign-in');
      } else {
        setSession(data.session);
        // FIXED: a real bug, confirmed by reading this file -- nothing here used to navigate on success at
        // all. It relied entirely on index.tsx's own gate still being mounted to react to the session update,
        // which only holds if the OAuth redirect happens to land the browser back on "/". Explicit and
        // unconditional instead: always fall through index.tsx's one real routing decision (session ->
        // needs_username -> admin/customer), regardless of which route this effect's tab happened to be
        // sitting on when the exchange finished. splash.tsx and every other screen stay exactly as they are --
        // no route needs its own "I just became signed in" guard, because this always sends them through the
        // one place that already has that logic.
        router.replace('/');
      }
      // Only now is it safe to let a routing decision happen -- whether the exchange succeeded or failed.
      setExchangingCode(false);
    })();
  }, []);

  // Keyed on the user id, so token refreshes don't re-fetch the account.
  useEffect(() => {
    if (!userId) return;
    let active = true;
    loadAccount(userId).then((next) => {
      if (active) applyAccount(next);
    });
    return () => {
      active = false;
    };
  }, [userId, applyAccount]);

  // An account that belongs to a previous user must never leak into the next.
  const current = account && account.userId === userId ? account : null;
  const initializing = !sessionChecked || exchangingCode || (userId !== null && current === null);

  const signIn = useCallback(async (email: string, password: string) => {
    const { data, error } = await supabase.auth.signInWithPassword({
      email: email.trim().toLowerCase(),
      password,
    });
    if (error) throw error;
    // Don't wait for the auth event: the caller navigates right after this.
    setSession(data.session);
  }, []);

  const signUp = useCallback(
    async (displayName: string, email: string, password: string) => {
      const { data, error } = await supabase.auth.signUp({
        email: email.trim().toLowerCase(),
        password,
        options: {
          // The database trigger reads display_name from here. Never the role.
          data: { display_name: displayName.trim() },
        },
      });
      if (error) throw error;
      // No session means the project requires email confirmation first.
      setSession(data.session);
      return { needsEmailConfirmation: !data.session };
    },
    []
  );

  const signInWithGoogle = useCallback(async () => {
    // Linking.createURL reads app.json's own scheme ("topupapp") -- exp:// in Expo Go during development, the
    // real custom scheme in a standalone/dev-client build, the page's own origin on web.
    const redirectTo = Linking.createURL('/');

    if (Platform.OS === 'web') {
      // CONFIRMED LIVE (headless Chrome, window.open instrumented directly): a popup here is fragile in a way
      // that matters, not just in theory. `await supabase.auth.signInWithOAuth(...)` resolves almost instantly
      // (it only builds a URL, no real network wait) -- but that `await` still yields once, and by the time
      // window.open() runs afterward, the browser no longer treats it as inside the click's own trusted user
      // gesture. window.open() then returns null (silently blocked), before any request to Supabase or Google
      // is ever sent -- reproduced exactly this way, not assumed. A full-page redirect has no such timing
      // requirement, so web uses that instead; AuthProvider's own mount effect below picks the code back up
      // once Supabase redirects the whole page back here.
      const { error } = await supabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo } });
      if (error) throw error;
      // The browser is navigating away right now (signInWithOAuth's own default web behavior without
      // skipBrowserRedirect) -- there is nothing left to await; the promise below never resolves in practice.
      return;
    }

    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo, skipBrowserRedirect: true },
    });
    if (error) throw error;
    if (!data.url) throw new Error('no_auth_url');

    // Native only: openAuthSessionAsync uses a real system browser-session component (ASWebAuthenticationSession
    // / Custom Tabs), not a JS popup, so the async-timing issue above does not apply here.
    const result = await WebBrowser.openAuthSessionAsync(data.url, redirectTo);
    if (result.type !== 'success' || !result.url) {
      throw new Error('cancelled');
    }

    // The default (PKCE) flow: Supabase's callback redirects back here with ?code=..., not tokens in the URL.
    const { queryParams } = Linking.parse(result.url);
    const code = typeof queryParams?.code === 'string' ? queryParams.code : null;
    if (!code) {
      const description = typeof queryParams?.error_description === 'string' ? queryParams.error_description : 'no_code';
      throw new Error(description);
    }

    const { data: sessionData, error: exchangeError } = await supabase.auth.exchangeCodeForSession(code);
    if (exchangeError) throw exchangeError;
    // Same as signIn/signUp: the caller navigates right after this, index.tsx's own gate (needs_username,
    // isAdmin) picks the right screen once the account has loaded -- no branch here for "new vs returning".
    setSession(sessionData.session);
  }, []);

  const completeUsername = useCallback(
    async (displayName: string) => {
      const { error } = await supabase.rpc('complete_username', { p_display_name: displayName.trim() });
      if (error) throw error;
      if (userId) applyAccount(await loadAccount(userId));
    },
    [userId, applyAccount]
  );

  const signOut = useCallback(async () => {
    const { error } = await supabase.auth.signOut();
    if (error) throw error;
    setAccount(null);
  }, []);

  const refreshAccount = useCallback(async () => {
    if (!userId) return;
    applyAccount(await loadAccount(userId));
  }, [userId, applyAccount]);

  const clearOAuthError = useCallback(() => setOAuthError(null), []);

  const value = useMemo<AuthContextValue>(
    () => ({
      session,
      user: session?.user ?? null,
      profile: current?.profile ?? null,
      balance: current?.balance ?? null,
      isAdmin: current?.profile?.role === 'admin',
      isContentCreator: current?.profile?.is_content_creator === true,
      initializing,
      signIn,
      signUp,
      signInWithGoogle,
      completeUsername,
      signOut,
      refreshAccount,
      oauthError,
      clearOAuthError,
    }),
    [session, current, initializing, signIn, signUp, signInWithGoogle, completeUsername, signOut, refreshAccount, oauthError, clearOAuthError]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used inside <AuthProvider>');
  }
  return ctx;
}
