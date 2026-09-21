import { router } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, Text } from 'react-native';

import { AuthFooter } from '../components/ui/AuthFooter';
import { AuthLayout } from '../components/ui/AuthLayout';
import { Button } from '../components/ui/Button';
import { ErrorBanner } from '../components/ui/ErrorBanner';
import { PasswordField } from '../components/ui/PasswordField';
import { SocialAuth } from '../components/ui/SocialAuth';
import { TextField } from '../components/ui/TextField';
import { useAuth } from '../lib/auth';
import { useT } from '../lib/i18n';
import { colors, fonts, spacing } from '../lib/theme';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function SignUpScreen() {
  const { signUp } = useAuth();
  const t = useT();

  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [confirmEmail, setConfirmEmail] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState({
    displayName: false,
    email: false,
    password: false,
  });

  const nameError =
    displayName.trim().length > 0 && displayName.trim().length < 2
      ? t('auth.nameShort')
      : null;
  const emailError =
    email.length > 0 && !EMAIL_RE.test(email.trim())
      ? t('auth.badEmail')
      : null;
  const passwordError =
    password.length > 0 && password.length < 8
      ? t('auth.passwordShort')
      : null;

  const canSubmit =
    displayName.trim().length >= 2 &&
    EMAIL_RE.test(email.trim()) &&
    password.length >= 8 &&
    !submitting;

  async function handleSignUp() {
    if (!canSubmit) return;
    setError(null);
    setSubmitting(true);
    try {
      const { needsEmailConfirmation } = await signUp(
        displayName,
        email,
        password
      );
      if (needsEmailConfirmation) setConfirmEmail(true);
      else router.replace('/');
    } catch (err) {
      const message = err instanceof Error ? err.message : t('auth.signUpFailed');
      setError(
        message.toLowerCase().includes('already registered')
          ? t('auth.alreadyRegistered')
          : message
      );
    } finally {
      setSubmitting(false);
    }
  }

  function notReady() {
    setError(t('auth.notReady'));
  }

  if (confirmEmail) {
    return (
      <AuthLayout
        title={t('auth.checkEmail')}
        subtitle={t('auth.sentLink', { email: email.trim().toLowerCase() })}
      >
        <Text style={styles.confirmText}>
          {t('auth.openLink')}
        </Text>
        <Button
          label={t('auth.goLogin')}
          onPress={() => router.replace('/sign-in')}
          style={styles.submit}
        />
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title={t('auth.createAccount')} subtitle={t('auth.createSub')}>
      {error ? <ErrorBanner message={error} /> : null}

      <TextField
        label={t('auth.name')}
        value={displayName}
        onChangeText={setDisplayName}
        onBlur={() => setTouched((t) => ({ ...t, displayName: true }))}
        error={touched.displayName ? nameError : null}
        placeholder={t('auth.namePlaceholder')}
        autoCapitalize="words"
        autoCorrect={false}
        maxLength={40}
        editable={!submitting}
      />

      <TextField
        label={t('auth.email')}
        value={email}
        onChangeText={setEmail}
        onBlur={() => setTouched((t) => ({ ...t, email: true }))}
        error={touched.email ? emailError : null}
        placeholder={t('auth.emailPlaceholder')}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="email-address"
        textContentType="emailAddress"
        editable={!submitting}
      />

      <PasswordField
        label={t('auth.password')}
        value={password}
        onChangeText={setPassword}
        onBlur={() => setTouched((t) => ({ ...t, password: true }))}
        error={touched.password ? passwordError : null}
        placeholder={t('auth.passwordNew')}
        textContentType="newPassword"
        editable={!submitting}
        returnKeyType="go"
        onSubmitEditing={handleSignUp}
      />

      <Button
        label={t('auth.signUp')}
        onPress={handleSignUp}
        loading={submitting}
        disabled={!canSubmit}
        style={styles.submit}
      />

      <SocialAuth dividerLabel={t('auth.orSignUp')} onPress={notReady} />

      <AuthFooter
        prompt={t('auth.haveAccount')}
        linkLabel={t('auth.login')}
        href="/sign-in"
      />
    </AuthLayout>
  );
}

const styles = StyleSheet.create({
  submit: { marginTop: spacing.sm },
  confirmText: {
    fontFamily: fonts.regular,
    fontSize: 15,
    lineHeight: 22,
    color: colors.textMuted,
    textAlign: 'center',
  },
});
