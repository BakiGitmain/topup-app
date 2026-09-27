import { Redirect, router } from 'expo-router';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Avatar } from '../../components/market/Avatar';
import { Button } from '../../components/ui/Button';
import { ScreenHeader } from '../../components/ui/ScreenHeader';
import { Column } from '../../components/ui/TabScroll';
import { TextField } from '../../components/ui/TextField';
import { useAuth } from '../../lib/auth';
import { findRecipient, type Recipient, type RecipientLookup } from '../../lib/gift';
import { giftParams, looksLikeEmail } from '../../lib/giftMode';
import { useT } from '../../lib/i18n';
import type { StringKey } from '../../lib/strings';
import { colors, fonts, radius, spacing } from '../../lib/theme';

const LOOKUP_ERROR: Record<Exclude<RecipientLookup['kind'], 'found'>, StringKey> = {
  not_found: 'gift.email.notFound',
  self: 'gift.email.self',
  too_many: 'gift.email.tooMany',
  error: 'gift.email.error',
};

/**
 * Send to a friend, step 1: their email -> their account, confirmed by name and picture before anything else. The
 * catalog opens only for a confirmed account; an unknown email or the buyer's own stops right here, before any
 * product or payment.
 */
export default function GiftSendScreen() {
  const { session, initializing } = useAuth();
  const t = useT();
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<StringKey | null>(null);
  const [found, setFound] = useState<Recipient | null>(null);

  if (!initializing && !session) return <Redirect href="/sign-in" />;

  async function lookUp() {
    if (busy) return;
    setFound(null);
    if (!looksLikeEmail(email)) {
      setProblem('gift.email.invalid');
      return;
    }
    setBusy(true);
    setProblem(null);
    const result = await findRecipient(email.trim());
    setBusy(false);
    if (result.kind === 'found') setFound(result.recipient);
    else setProblem(LOOKUP_ERROR[result.kind]);
  }

  function changeEmail(value: string) {
    setEmail(value);
    // A different email is a different person: the confirmed card never outlives the text it was found for.
    setFound(null);
    setProblem(null);
  }

  function choosePack() {
    if (!found) return;
    router.push({ pathname: '/gift/shop', params: giftParams({ kind: 'gift', to: found.id, toName: found.name }) });
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <Column>
            <ScreenHeader title={t('gift.send.title')} />
            <Text style={styles.lead}>{t('gift.send.body')}</Text>

            <TextField
              label={t('gift.email.label')}
              value={email}
              onChangeText={changeEmail}
              placeholder={t('gift.email.placeholder')}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              textContentType="emailAddress"
              autoComplete="off"
              returnKeyType="search"
              onSubmitEditing={lookUp}
              error={problem ? t(problem) : undefined}
            />
            {!found && <Button label={t('gift.email.find')} onPress={lookUp} loading={busy} disabled={!email.trim()} style={styles.find} />}

            {found && (
              <View style={styles.confirm} accessible accessibilityLabel={`${t('gift.confirm.title')} ${found.name}`}>
                <Text style={styles.confirmTitle}>{t('gift.confirm.title')}</Text>
                <View style={styles.person}>
                  <Avatar name={found.name} uri={found.avatarUrl} size={56} />
                  <View style={styles.personText}>
                    <Text style={styles.personName} numberOfLines={1}>
                      {found.name}
                    </Text>
                    <Text style={styles.personEmail} numberOfLines={1}>
                      {email.trim().toLowerCase()}
                    </Text>
                  </View>
                </View>
              </View>
            )}
            {found && (
              <>
                <Button label={t('gift.confirm.choose', { name: found.name })} onPress={choosePack} style={styles.find} />
                <Button label={t('gift.confirm.change')} variant="outline" onPress={() => changeEmail('')} style={styles.change} />
              </>
            )}
          </Column>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  flex: { flex: 1 },
  scroll: { paddingBottom: spacing.xl },
  lead: { marginTop: spacing.xs, marginBottom: spacing.lg, fontFamily: fonts.regular, fontSize: 14.5, lineHeight: 21, color: colors.textMuted },
  find: { marginTop: spacing.md },
  change: { marginTop: spacing.xs },
  confirm: { marginTop: spacing.lg, padding: spacing.md, borderRadius: radius.lg, backgroundColor: colors.limeSoft },
  confirmTitle: { fontFamily: fonts.medium, fontSize: 13, color: colors.limeDark },
  person: { marginTop: spacing.sm, flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  personText: { flex: 1, minWidth: 0 },
  personName: { fontFamily: fonts.bold, fontSize: 18, color: colors.text },
  personEmail: { marginTop: 2, fontFamily: fonts.regular, fontSize: 13.5, color: colors.textMuted },
});
