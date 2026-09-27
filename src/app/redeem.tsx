import * as Clipboard from 'expo-clipboard';
import { Redirect, router } from 'expo-router';
import { useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { FeatherIcon } from '../components/art/FeatherIcon';
import { GiftCard } from '../components/gift/GiftCard';
import { Button } from '../components/ui/Button';
import { ScreenHeader } from '../components/ui/ScreenHeader';
import { Column } from '../components/ui/TabScroll';
import { TextField } from '../components/ui/TextField';
import { useAuth } from '../lib/auth';
import { redeemCode } from '../lib/gift';
import { useT } from '../lib/i18n';
import { CODE_LENGTH, displayRedeemInput, normalizeRedeemInput, type RedeemReply } from '../lib/redeemInput';
import type { StringKey } from '../lib/strings';
import { colors, fonts, radius, spacing } from '../lib/theme';
import { fetchVaultGifts, type VaultGift } from '../lib/vault';

const PROBLEM: Record<Exclude<RedeemReply['kind'], 'ok'>, StringKey> = {
  invalid: 'redeem.err.invalid',
  already_mine: 'redeem.err.mine',
  too_many: 'redeem.err.tooMany',
  signed_out: 'redeem.err.error',
  error: 'redeem.err.error',
};

/**
 * Profile > Redeem code: a code someone handed over -> a gift in this account's Vault, claimable right here with the
 * same card the Vault shows. The code lives only in this screen's state: never in a route, a log or storage, and it
 * is cleared the moment it has been redeemed. The server is the only judge (single winner, rate limit, one answer
 * for every kind of wrong code); this screen only makes typing easy and reports what it said.
 */
export default function RedeemScreen() {
  const { session, initializing } = useAuth();
  const t = useT();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<StringKey | null>(null);
  const [alreadyMine, setAlreadyMine] = useState(false);
  const [redeemed, setRedeemed] = useState<{ giftId: string; gift: VaultGift | null } | null>(null);
  // A second tap before React re-renders the button as busy must not send a second request (see cart.tsx).
  const inFlight = useRef(false);

  if (!initializing && !session) return <Redirect href="/sign-in" />;

  function change(value: string) {
    setCode(normalizeRedeemInput(value));
    setProblem(null);
    setAlreadyMine(false);
  }

  async function paste() {
    try {
      change(await Clipboard.getStringAsync());
    } catch {
      // Clipboard refused (permissions, web): typing still works.
    }
  }

  async function loadGift(giftId: string) {
    try {
      const gifts = await fetchVaultGifts();
      setRedeemed({ giftId, gift: gifts.find((g) => g.id === giftId) ?? null });
    } catch {
      setRedeemed({ giftId, gift: null });
    }
  }

  async function submit() {
    if (inFlight.current || busy) return;
    if (code.length !== CODE_LENGTH) {
      setProblem('redeem.short');
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setProblem(null);
    setAlreadyMine(false);
    try {
      const reply = await redeemCode(code);
      if (reply.kind === 'ok') {
        setCode(''); // redeemed: the code has done its job and is not kept around
        await loadGift(reply.giftId);
      } else {
        setProblem(PROBLEM[reply.kind]);
        setAlreadyMine(reply.kind === 'already_mine');
      }
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  function another() {
    setRedeemed(null);
    setProblem(null);
    setAlreadyMine(false);
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <Column>
            <ScreenHeader title={t('redeem.title')} />

            {!redeemed && (
              <>
                <Text style={styles.lead}>{t('redeem.body')}</Text>
                <TextField
                  label={t('redeem.label')}
                  value={displayRedeemInput(code)}
                  onChangeText={change}
                  placeholder={t('redeem.placeholder')}
                  autoCapitalize="characters"
                  autoCorrect={false}
                  autoComplete="off"
                  spellCheck={false}
                  importantForAutofill="no"
                  keyboardType={Platform.OS === 'android' ? 'visible-password' : 'default'}
                  returnKeyType="go"
                  onSubmitEditing={submit}
                  style={styles.codeInput}
                  error={problem ? t(problem) : undefined}
                  accessibilityHint={t('redeem.short')}
                  right={
                    <Pressable onPress={paste} accessibilityRole="button" accessibilityLabel={t('redeem.paste')} hitSlop={8} style={({ pressed }) => [styles.paste, pressed && { opacity: 0.6 }]}>
                      <Text style={styles.pasteText}>{t('redeem.paste')}</Text>
                    </Pressable>
                  }
                />
                <Button label={t('redeem.submit')} icon="gift" onPress={submit} loading={busy} disabled={code.length === 0} style={styles.submit} />
                {alreadyMine && <Button label={t('redeem.openVault')} variant="outline" onPress={() => router.push('/vault')} style={styles.secondary} />}
              </>
            )}

            {redeemed && (
              <>
                <View style={styles.done} accessibilityLiveRegion="polite">
                  <View style={styles.doneIcon}>
                    <FeatherIcon name="check" size={20} color={colors.limeDark} />
                  </View>
                  <View style={styles.doneText}>
                    <Text style={styles.doneTitle}>{t('redeem.done.title')}</Text>
                    <Text style={styles.doneBody}>{t('redeem.done.body')}</Text>
                  </View>
                </View>
                {redeemed.gift && <GiftCard gift={redeemed.gift} onChanged={() => loadGift(redeemed.giftId)} />}
                <Button label={t('redeem.openVault')} onPress={() => router.push('/vault')} style={styles.submit} />
                <Button label={t('redeem.another')} variant="outline" onPress={another} style={styles.secondary} />
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
  codeInput: { fontFamily: fonts.bold, fontSize: 20, letterSpacing: 2 },
  paste: { paddingHorizontal: spacing.sm, paddingVertical: 6, borderRadius: radius.md, backgroundColor: colors.limeSoft },
  pasteText: { fontFamily: fonts.medium, fontSize: 13, color: colors.limeDark },
  submit: { marginTop: spacing.md },
  secondary: { marginTop: spacing.xs },
  done: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, marginTop: spacing.sm, marginBottom: spacing.md, padding: spacing.md, borderRadius: radius.lg, backgroundColor: colors.limeSoft },
  doneIcon: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg },
  doneText: { flex: 1, minWidth: 0 },
  doneTitle: { fontFamily: fonts.bold, fontSize: 16, color: colors.text },
  doneBody: { marginTop: 2, fontFamily: fonts.regular, fontSize: 13.5, lineHeight: 19, color: colors.textMuted },
});
