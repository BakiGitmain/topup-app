import { Redirect, router } from 'expo-router';
import { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { FeatherIcon } from '../../components/art/FeatherIcon';
import { GoogleIcon } from '../../components/art/Icons';
import { CARD_RADIUS, SettingsRow } from '../../components/profile/SettingsMenu';
import { Button } from '../../components/ui/Button';
import { ErrorBanner } from '../../components/ui/ErrorBanner';
import { PasswordField } from '../../components/ui/PasswordField';
import { ScreenHeader } from '../../components/ui/ScreenHeader';
import { Column } from '../../components/ui/TabScroll';
import { addPassword, changePassword, fetchHasPassword, type AddPasswordResult, type ChangePasswordResult } from '../../lib/account';
import { signInMethods } from '../../lib/accountLogic';
import { useAuth } from '../../lib/auth';
import { useT } from '../../lib/i18n';
import type { StringKey } from '../../lib/strings';
import { colors, fonts, radius, spacing } from '../../lib/theme';
import { useToast } from '../../lib/toast';
import { useAsync } from '../../lib/useAsync';

const ADD_ERRORS: Record<Exclude<AddPasswordResult, 'ok'>, StringKey> = {
  too_short: 'auth.passwordShort',
  mismatch: 'account.mismatch',
  network: 'account.network',
  failed: 'account.passwordFailed',
};
const CHANGE_ERRORS: Record<Exclude<ChangePasswordResult, 'ok'>, StringKey> = {
  wrong_password: 'account.wrongPassword',
  too_short: 'auth.passwordShort',
  same: 'account.samePassword',
  network: 'account.network',
  failed: 'account.passwordFailed',
};

function SectionLabel({ children }: { children: string }) {
  return (
    <Text style={styles.sectionLabel} accessibilityRole="header">
      {children}
    </Text>
  );
}

function ConnectedPill({ label }: { label: string }) {
  return (
    <View style={styles.pill}>
      <FeatherIcon name="check" size={12} color={colors.limeInk} strokeWidth={3} />
      <Text style={styles.pillText}>{label}</Text>
    </View>
  );
}

/**
 * How this account signs in, and its password: "Change password" when it has one, "Add a password" when it doesn't
 * (a Google-only account). Whether a password exists comes from the server, not the identities (see
 * fetchHasPassword); the email is the only identifier this app signs in with, so it's shown read only.
 */
export default function AccountScreen() {
  const { user, session, initializing } = useAuth();
  const t = useT();
  const toast = useToast();
  const insets = useSafeAreaInsets();
  const hasPasswordCheck = useAsync(fetchHasPassword, user?.id ?? '', !initializing && !!user);
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!initializing && !session) return <Redirect href="/sign-in" />;

  const methods = signInMethods(user?.identities, user?.app_metadata?.providers as string[] | undefined);
  const checking = hasPasswordCheck.status === 'loading' && hasPasswordCheck.data === null;
  // The server is the truth. If it can't be reached, the identities are right for every account except a Google one
  // that added a password later -- good enough to still let the person act.
  const hasPassword = hasPasswordCheck.data ?? methods.includes('email');

  function resetForm() {
    setCurrent('');
    setNext('');
    setConfirm('');
    setError(null);
  }

  function togglePassword() {
    resetForm();
    setOpen((o) => !o);
  }

  async function submit() {
    if (!user?.email || busy) return;
    setError(null);
    setBusy(true);
    try {
      if (hasPassword) {
        const result = await changePassword(user.email, current, next);
        if (result !== 'ok') return setError(t(CHANGE_ERRORS[result]));
        toast(t('account.passwordChanged'));
      } else {
        const result = await addPassword(next, confirm);
        if (result !== 'ok') return setError(t(ADD_ERRORS[result]));
        toast(t('account.passwordAdded'));
        await hasPasswordCheck.reload();
      }
      resetForm();
      setOpen(false);
    } finally {
      setBusy(false);
    }
  }

  const canSubmit = hasPassword ? !!current && !!next : !!next && !!confirm;

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + spacing.xxl }} keyboardShouldPersistTaps="handled">
        <Column>
          <ScreenHeader title={t('settings.account')} onBack={() => (router.canGoBack() ? router.back() : router.replace('/profile'))} />

          <SectionLabel>{t('account.sectionSignIn')}</SectionLabel>
          <View style={styles.group}>
            <SettingsRow icon="mail" label={t('auth.email')} value={user?.email ?? '—'} />
            {methods.includes('google') && (
              <SettingsRow iconNode={<GoogleIcon size={18} />} label={t('account.google')} right={<ConnectedPill label={t('account.connected')} />} />
            )}
            {!checking && hasPassword && (
              <SettingsRow icon="key" label={t('account.emailPassword')} right={<ConnectedPill label={t('account.connected')} />} />
            )}
          </View>

          <SectionLabel>{t('account.sectionSecurity')}</SectionLabel>
          <View style={styles.group}>
            <SettingsRow
              icon="lock"
              label={hasPassword ? t('account.changePassword') : t('account.addPassword')}
              value={checking ? '…' : hasPassword ? t('account.passwordSet') : t('account.passwordNotSet')}
              onPress={checking ? undefined : togglePassword}
              chevronDown={open}
            />

            {open && !checking && (
              <View style={styles.form}>
                {!hasPassword && <Text style={styles.formBody}>{t('account.addPasswordBody')}</Text>}
                {error ? <ErrorBanner message={error} /> : null}
                {hasPassword && (
                  <PasswordField
                    label={t('account.currentPassword')}
                    value={current}
                    onChangeText={setCurrent}
                    textContentType="password"
                    autoComplete="current-password"
                    editable={!busy}
                  />
                )}
                <PasswordField
                  label={t('account.newPassword')}
                  value={next}
                  onChangeText={setNext}
                  placeholder={t('auth.passwordNew')}
                  textContentType="newPassword"
                  autoComplete="new-password"
                  editable={!busy}
                  returnKeyType={hasPassword ? 'go' : 'next'}
                  onSubmitEditing={hasPassword ? submit : undefined}
                />
                {!hasPassword && (
                  <PasswordField
                    label={t('account.confirmPassword')}
                    value={confirm}
                    onChangeText={setConfirm}
                    textContentType="newPassword"
                    autoComplete="new-password"
                    editable={!busy}
                    returnKeyType="go"
                    onSubmitEditing={submit}
                  />
                )}
                <Button
                  label={hasPassword ? t('account.changePassword') : t('account.addPassword')}
                  onPress={submit}
                  loading={busy}
                  disabled={!canSubmit}
                />
              </View>
            )}
          </View>
        </Column>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  sectionLabel: {
    marginTop: spacing.lg,
    marginBottom: spacing.sm,
    marginLeft: 2,
    fontFamily: fonts.semibold,
    fontSize: 12.5,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    color: colors.textMuted,
  },
  group: { gap: spacing.sm },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    height: 26,
    borderRadius: radius.pill,
    backgroundColor: colors.limeSoft,
  },
  pillText: { fontFamily: fonts.bold, fontSize: 11.5, color: colors.limeInk },
  form: { padding: spacing.md, borderRadius: CARD_RADIUS, backgroundColor: colors.surface },
  formBody: { marginBottom: spacing.md, fontFamily: fonts.regular, fontSize: 14, lineHeight: 20, color: colors.textMuted },
});
