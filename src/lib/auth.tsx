import type { Session, User } from '@supabase/supabase-js';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import { supabase } from './supabase';

export type Role = 'user' | 'admin';

export type Profile = {
  id: string;
  display_name: string;
  email: string | null;
  avatar_url: string | null;
  role: Role;
  language: 'en' | 'am';
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
  signOut: () => Promise<void>;
  refreshAccount: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

/** Always resolves: a failed read leaves the fields null instead of hanging. */
async function loadAccount(userId: string): Promise<Account> {
  const [profileRes, walletRes] = await Promise.all([
    supabase
      .from('profiles')
      .select('id, display_name, email, avatar_url, role, language')
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

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [sessionChecked, setSessionChecked] = useState(false);
  const [account, setAccount] = useState<Account | null>(null);

  const userId = session?.user.id ?? null;

  useEffect(() => {
    let active = true;

    supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      setSession(data.session);
      setSessionChecked(true);
    });

    const { data: listener } = supabase.auth.onAuthStateChange(
      (event, nextSession) => {
        setSession(nextSession);
        if (event === 'SIGNED_OUT') setAccount(null);
      }
    );

    return () => {
      active = false;
      listener.subscription.unsubscribe();
    };
  }, []);

  // Keyed on the user id, so token refreshes don't re-fetch the account.
  useEffect(() => {
    if (!userId) return;
    let active = true;
    loadAccount(userId).then((next) => {
      if (active) setAccount(next);
    });
    return () => {
      active = false;
    };
  }, [userId]);

  // An account that belongs to a previous user must never leak into the next.
  const current = account && account.userId === userId ? account : null;
  const initializing = !sessionChecked || (userId !== null && current === null);

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

  const signOut = useCallback(async () => {
    const { error } = await supabase.auth.signOut();
    if (error) throw error;
    setAccount(null);
  }, []);

  const refreshAccount = useCallback(async () => {
    if (!userId) return;
    setAccount(await loadAccount(userId));
  }, [userId]);

  const value = useMemo<AuthContextValue>(
    () => ({
      session,
      user: session?.user ?? null,
      profile: current?.profile ?? null,
      balance: current?.balance ?? null,
      isAdmin: current?.profile?.role === 'admin',
      initializing,
      signIn,
      signUp,
      signOut,
      refreshAccount,
    }),
    [session, current, initializing, signIn, signUp, signOut, refreshAccount]
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
