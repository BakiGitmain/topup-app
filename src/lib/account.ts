import { checkAddPassword, checkNewPassword } from './accountLogic';
import { supabase } from './supabase';

export type ChangePasswordResult = 'ok' | 'wrong_password' | 'too_short' | 'same' | 'network' | 'failed';
export type AddPasswordResult = 'ok' | 'too_short' | 'mismatch' | 'network' | 'failed';

/** supabase-js reports an unreachable server as AuthRetryableFetchError (status 0); a thrown fetch is the same. */
function isNetworkError(error: { name?: string; status?: number } | null | undefined): boolean {
  return !!error && (error.name === 'AuthRetryableFetchError' || error.status === 0);
}

/**
 * Whether the signed-in account has a password. Not derivable from its identities: a Google account that adds a
 * password keeps identities ["google"] (verified live), so this asks the server (my_account_has_password(), which
 * only ever answers for the caller's own account and never exposes the hash).
 */
export async function fetchHasPassword(): Promise<boolean> {
  const { data, error } = await supabase.rpc('my_account_has_password');
  if (error) throw error;
  return data === true;
}

/**
 * Changes an existing password. The project doesn't require re-authentication for this
 * (auth.email.secure_password_change = false), so the current password is checked here first: someone holding an
 * unlocked phone still can't change the password without knowing it.
 */
export async function changePassword(email: string, current: string, next: string): Promise<ChangePasswordResult> {
  const local = checkNewPassword(current, next);
  if (local !== 'ok') return local;
  try {
    const check = await supabase.auth.signInWithPassword({ email, password: current });
    if (check.error) {
      if (isNetworkError(check.error)) return 'network';
      return check.error.code === 'invalid_credentials' ? 'wrong_password' : 'failed';
    }
    const { error } = await supabase.auth.updateUser({ password: next });
    if (!error) return 'ok';
    if (isNetworkError(error)) return 'network';
    if (error.code === 'same_password') return 'same';
    if (error.code === 'weak_password') return 'too_short';
    return 'failed';
  } catch {
    return 'network';
  }
}

/**
 * Gives a Google-only account its first password, on the session it already has: being signed in through Google
 * is the proof of identity, and there is no old password to ask for. Afterwards the account can ALSO sign in with
 * email + this password (verified live); Google sign-in is unaffected.
 */
export async function addPassword(next: string, confirm: string): Promise<AddPasswordResult> {
  const local = checkAddPassword(next, confirm);
  if (local !== 'ok') return local;
  try {
    const { error } = await supabase.auth.updateUser({ password: next });
    if (!error) return 'ok';
    if (isNetworkError(error)) return 'network';
    if (error.code === 'weak_password') return 'too_short';
    return 'failed';
  } catch {
    return 'network';
  }
}
