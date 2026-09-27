/** Account settings rules. Pure, no imports (Node tests it directly). */

export type SignInMethod = 'email' | 'google';

/**
 * How this account can sign in, from Supabase's own records (the user's identities, plus app_metadata.providers as
 * a fallback). Only an account with an 'email' identity has a password, so only that one is offered "Change
 * password" -- a Google-only account would otherwise be quietly given a password it never asked for.
 */
export function signInMethods(
  identities: readonly { provider?: string | null }[] | null | undefined,
  providers?: readonly string[] | null
): SignInMethod[] {
  const seen = new Set<string>([...(identities ?? []).map((i) => i.provider ?? ''), ...(providers ?? [])]);
  const out: SignInMethod[] = [];
  if (seen.has('email')) out.push('email');
  if (seen.has('google')) out.push('google');
  return out;
}

/** Same minimum the sign-up form enforces (auth.passwordShort), so a changed password is never weaker than a new one. */
export const MIN_PASSWORD_LENGTH = 8;

export type NewPasswordCheck = 'ok' | 'too_short' | 'same';

export function checkNewPassword(current: string, next: string): NewPasswordCheck {
  if (next.length < MIN_PASSWORD_LENGTH) return 'too_short';
  if (next === current) return 'same';
  return 'ok';
}

export type AddPasswordCheck = 'ok' | 'too_short' | 'mismatch';

/** Adding a first password (a Google-only account): the same minimum as sign-up, typed twice since there is no
 * current password to prove it against. */
export function checkAddPassword(next: string, confirm: string): AddPasswordCheck {
  if (next.length < MIN_PASSWORD_LENGTH) return 'too_short';
  if (next !== confirm) return 'mismatch';
  return 'ok';
}

/** Display names follow the server's own rule in complete_username(): trimmed, 2 to 40 characters. */
export function isValidDisplayName(name: string): boolean {
  const n = name.trim().length;
  return n >= 2 && n <= 40;
}
