import { Redirect, router } from 'expo-router';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { WaveHeader } from '../components/art/WaveHeader';
import { Button } from '../components/ui/Button';
import { ErrorBanner } from '../components/ui/ErrorBanner';
import { LanguagePill } from '../components/ui/LanguagePill';
import { TextField } from '../components/ui/TextField';
import { useAuth } from '../lib/auth';
import { useT } from '../lib/i18n';
import { colors, fonts, spacing } from '../lib/theme';

/**
 * The one-time step after a first Google sign-in (see auth.tsx's Profile.needs_username, and index.tsx's own
 * gate): no back button on purpose -- there is already a live session by the time this shows, so "back" has
 * nowhere sensible to go. "Sign out" is the escape hatch instead, so nobody can get stuck here.
 */
export default function ChooseUsernameScreen() {
  const { session, profile, initializing, completeUsername, signOut } = useAuth();
  const t = useT();
  const insets = useSafeAreaInsets();

  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!initializing && !session) return <Redirect href="/splash" />;
  // Already has a name, or got here by mistake (a stale link, say): nothing to do here.
  if (!initializing && profile && !profile.needs_username) return <Redirect href="/" />;

  const canSubmit = name.trim().length >= 2 && !submitting;

  async function submit() {
    if (!canSubmit) return;
    setError(null);
    setSubmitting(true);
    try {
      await completeUsername(name);
      router.replace('/');
    } catch {
      setError(t('username.failed'));
    } finally {
      setSubmitting(false);
    }
  }

  async function useDifferentAccount() {
    await signOut().catch(() => {});
    router.replace('/splash');
  }

  return (
    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView
        style={styles.flex}
        contentContainerStyle={[styles.scroll, { paddingBottom: insets.bottom + spacing.lg }]}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        bounces={false}
      >
        <WaveHeader />
        <View style={[styles.langCorner, { top: insets.top + 10 }]}>
          <LanguagePill />
        </View>

        <View style={styles.body}>
          <Text style={styles.title} accessibilityRole="header">
            {t('username.title')}
          </Text>
          <Text style={styles.subtitle}>{t('username.subtitle')}</Text>

          <View style={styles.form}>
            {error ? <ErrorBanner message={error} /> : null}

            <TextField
              label={t('auth.name')}
              value={name}
              onChangeText={setName}
              placeholder={t('username.placeholder')}
              autoCapitalize="words"
              autoCorrect={false}
              maxLength={40}
              editable={!submitting}
              autoFocus
              returnKeyType="go"
              onSubmitEditing={submit}
            />

            <Button label={t('username.continue')} onPress={submit} loading={submitting} disabled={!canSubmit} style={styles.submit} />

            <Pressable onPress={useDifferentAccount} disabled={submitting} hitSlop={8} style={styles.signOut}>
              <Text style={styles.signOutText}>{t('profile.signOut')}</Text>
            </Pressable>
          </View>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  scroll: { flexGrow: 1 },
  langCorner: { position: 'absolute', right: spacing.lg, zIndex: 10 },
  body: { width: '100%', maxWidth: 440, alignSelf: 'center', paddingHorizontal: spacing.lg, marginTop: -spacing.sm },
  title: { fontFamily: fonts.extrabold, fontSize: 32, color: colors.limeInk, letterSpacing: -0.8, textAlign: 'center' },
  subtitle: { marginTop: 6, fontFamily: fonts.medium, fontSize: 15, color: colors.textMuted, textAlign: 'center' },
  form: { marginTop: spacing.lg },
  submit: { marginTop: spacing.sm },
  signOut: { marginTop: spacing.lg, alignSelf: 'center', minHeight: 44, justifyContent: 'center' },
  signOutText: { fontFamily: fonts.semibold, fontSize: 14, color: colors.textMuted },
});
