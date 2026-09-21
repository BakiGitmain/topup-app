import { router } from 'expo-router';
import { useState } from 'react';
import { StyleSheet } from 'react-native';

import { LoginIllustration } from '../components/art/Illustrations';
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
  const { signIn } = useAuth();
  const t = useT();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit =
    email.trim().length > 0 && password.length > 0 && !submitting;

  async function handleSignIn() {
    if (!canSubmit) return;
    setError(null);
    setSubmitting(true);
    try {
      await signIn(email, password);
      // The index route sends admins and customers to their own home.
      router.replace('/');
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

  function notReady() {
    setError(t('auth.notReady'));
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

      <SocialAuth dividerLabel={t('auth.orLogin')} onPress={notReady} />

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
