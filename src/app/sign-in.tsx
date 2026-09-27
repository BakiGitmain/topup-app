import { useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet } from 'react-native';

import { LoginIllustration } from '../components/art/Illustrations';
import { goHomeForActiveAccount } from '../components/profile/AccountSwitcher';
import { AuthFooter } from '../components/ui/AuthFooter';
import { AuthLayout } from '../components/ui/AuthLayout';
import { Button } from '../components/ui/Button';
import { ErrorBanner } from '../components/ui/ErrorBanner';
import { PasswordField } from '../components/ui/PasswordField';
import { SocialAuth } from '../components/ui/SocialAuth';
import { TextField } from '../components/ui/TextField';
import { useAuth } from '../lib/auth';
import { useT } from '../lib/i18n';
import { spacing } from '../lib/theme';

export default function SignInScreen() {
  const { signIn, signInWithGoogle, oauthError, clearOAuthError } = useAuth();
  const t = useT();
  // "Add account" (and "Sign in again" for a saved account) reuse this screen. Signing in simply replaces the
  // active session; the account that was active is already saved by AccountsProvider, so nothing is lost.
  const params = useLocalSearchParams<{ add?: string; email?: string }>();

  const [email, setEmail] = useState(() => (typeof params.email === 'string' ? params.email : ''));
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [googleBusy, setGoogleBusy] = useState(false);
  // Web: AuthProvider redirects here with the real reason when Google/Supabase's own callback fails (consent
  // denied, an unverified-app block, a bad provider secret -- whatever it actually was, not a generic banner).
  // Seeded straight from context via a lazy initializer, so it's on screen from the very first render (no
  // flash-then-vanish from an effect racing the paint). Cleared from context separately, after mount, so a
  // later, unrelated visit to this screen never reshows the same stale error.
  const [error, setError] = useState<string | null>(() => oauthError);
  useEffect(() => {
    if (oauthError) clearOAuthError();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const canSubmit =
    email.trim().length > 0 && password.length > 0 && !submitting && !googleBusy;

  async function handleSignIn() {
    if (!canSubmit) return;
    setError(null);
    setSubmitting(true);
    try {
      await signIn(email, password);
      // The index route sends admins and customers to their own home.
      goHomeForActiveAccount();
    } catch (err) {
      const message = err instanceof Error ? err.message : t('auth.signInFailed');
      const lower = message.toLowerCase();
      setError(
        lower.includes('invalid login')
          ? t('auth.wrongCreds')
          : lower.includes('email not confirmed')
            ? t('auth.confirmFirst')
            : message
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function handleGoogle() {
    if (googleBusy || submitting) return;
    setError(null);
    setGoogleBusy(true);
    try {
      await signInWithGoogle();
      // Same destination as email sign-in: index.tsx's own gate sends a first-time Google account to
      // choose-username, or straight into the app otherwise -- no separate branch needed here.
      goHomeForActiveAccount();
    } catch (err) {
      // A deliberate cancel (closed the Google sheet without finishing) is not a failure worth showing.
      if (!(err instanceof Error && err.message === 'cancelled')) setError(t('auth.googleFailed'));
    } finally {
      setGoogleBusy(false);
    }
  }

  return (
    <AuthLayout
      title={t('auth.welcomeBack')}
      subtitle={t('auth.loginSub')}
      illustration={<LoginIllustration width={230} />}
    >
      {error ? <ErrorBanner message={error} /> : null}

      <TextField
        label={t('auth.email')}
        value={email}
        onChangeText={setEmail}
        placeholder={t('auth.emailPlaceholder')}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="email-address"
        textContentType="emailAddress"
        editable={!submitting}
        returnKeyType="next"
      />

      <PasswordField
        label={t('auth.password')}
        value={password}
        onChangeText={setPassword}
        placeholder={t('auth.passwordPlaceholder')}
        textContentType="password"
        editable={!submitting}
        returnKeyType="go"
        onSubmitEditing={handleSignIn}
      />

      <Button
        label={t('auth.login')}
        onPress={handleSignIn}
        loading={submitting}
        disabled={!canSubmit}
        style={styles.submit}
      />

      <SocialAuth dividerLabel={t('auth.orLogin')} onPress={handleGoogle} loading={googleBusy} />

      <AuthFooter
        prompt={t('auth.noAccount')}
        linkLabel={t('auth.signUp')}
        href="/sign-up"
      />
    </AuthLayout>
  );
}

const styles = StyleSheet.create({
  submit: { marginTop: spacing.sm },
});
