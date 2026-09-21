import { Redirect, router } from 'expo-router';
import { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { Outcome } from '../components/pay/Outcome';
import { Button } from '../components/ui/Button';
import { ErrorBanner } from '../components/ui/ErrorBanner';
import { PasteButton } from '../components/ui/PasteButton';
import { ProviderPicker } from '../components/pay/ProviderPicker';
import { ScreenHeader } from '../components/ui/ScreenHeader';
import { Column } from '../components/ui/TabScroll';
import { TextField } from '../components/ui/TextField';
import { useAuth } from '../lib/auth';
import { confirmDestructive } from '../lib/confirm';
import { useT } from '../lib/i18n';
import { amountToSend, type ProviderId } from '../lib/paymentView';
import type { StringKey } from '../lib/strings';
import { colors, fonts, radius, spacing } from '../lib/theme';
import { requestWithdrawal } from '../lib/wallet';
import { normalizePayoutAccount, parseAmount, payoutAccountProblem, WITHDRAW_MIN, withdrawAmountProblem } from '../lib/walletLogic';

/**
 * Withdraw: the amount is taken out of the balance the moment the request is made (so it can't be spent twice), and an admin
 * sends it to the account given here and marks it paid. If it can't be sent, it goes back to the balance with a reason.
 */
export default function WithdrawScreen() {
  const { session, balance, refreshAccount, initializing } = useAuth();
  const t = useT();
  const insets = useSafeAreaInsets();

  const [amountText, setAmountText] = useState('');
  const [provider, setProvider] = useState<ProviderId>('telebirr');
  const [account, setAccount] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [done, setDone] = useState<{ amount: number; provider: ProviderId; account: string } | null>(null);
  const [touched, setTouched] = useState(false);

  if (!initializing && !session) return <Redirect href="/sign-in" />;

  const amount = parseAmount(amountText);
  const amountProblem = withdrawAmountProblem(amount, balance);
  const accountProblem = payoutAccountProblem(provider, account);
  const canSubmit = amountProblem === null && accountProblem === null && amount !== null;
  const providerName = (p: ProviderId) => t(p === 'telebirr' ? 'pay.telebirr' : 'pay.cbe');

  async function submit() {
    if (busy) return;
    setTouched(true);
    if (!canSubmit || amount === null) return;
    const normalized = normalizePayoutAccount(provider, account);
    const ok = await confirmDestructive(
      t('withdraw.confirmTitle'),
      t('withdraw.confirmBody', { amount: amountToSend(amount), provider: providerName(provider), account: normalized }),
      t('withdraw.confirm'),
      'primary'
    );
    if (!ok) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await requestWithdrawal({ amount, provider, account: normalized });
      if (result.ok) {
        await refreshAccount();
        setDone({ amount, provider, account: normalized });
      } else {
        setMessage(t(`wallet.err.${result.code}` as StringKey));
        if (result.code === 'insufficient_balance') await refreshAccount();
      }
    } finally {
      setBusy(false);
    }
  }

  const amountError = touched || amountText.trim() !== '' ? (amountProblem === null ? null : t(`withdraw.problem.${amountProblem}` as StringKey, { min: amountToSend(WITHDRAW_MIN), balance: balance === null ? '—' : amountToSend(balance) })) : null;
  const accountError = touched && accountProblem ? t(`withdraw.account.${accountProblem}` as StringKey) : null;

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + spacing.xxl }} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
        <Column>
          <ScreenHeader title={t('withdraw.title')} />

          {done ? (
            <Outcome
              icon="clock"
              tone="ok"
              title={t('withdraw.doneTitle')}
              body={t('withdraw.doneBody', { amount: amountToSend(done.amount), provider: providerName(done.provider), account: done.account })}
              action={t('deposit.done')}
              onAction={() => router.replace('/wallet')}
            />
          ) : (
            <>
              <View style={styles.balanceCard}>
                <Text style={styles.balanceLabel}>{t('wallet.balance')}</Text>
                <Text style={styles.balance}>{balance === null ? '—' : amountToSend(balance)}</Text>
              </View>

              <TextField
                label={t('withdraw.amount')}
                value={amountText}
                onChangeText={(v) => {
                  setAmountText(v);
                  setMessage(null);
                }}
                keyboardType="decimal-pad"
                inputMode="decimal"
                maxLength={12}
                error={amountError}
              />

              <Text style={styles.section}>{t('withdraw.to')}</Text>
              <ProviderPicker
                label={t('withdraw.to')}
                value={provider}
                onChange={(p) => {
                  setProvider(p);
                  setMessage(null);
                }}
              />

              <View style={styles.gap} />
              <TextField
                label={t(provider === 'telebirr' ? 'withdraw.account.telebirr' : 'withdraw.account.cbe')}
                value={account}
                onChangeText={(v) => {
                  setAccount(v);
                  setMessage(null);
                }}
                keyboardType="phone-pad"
                autoCorrect={false}
                maxLength={30}
                error={accountError}
                right={<PasteButton onPaste={setAccount} />}
              />
              <Text style={styles.hint}>{t(provider === 'telebirr' ? 'withdraw.accountHint.telebirr' : 'withdraw.accountHint.cbe')}</Text>

              <Text style={styles.note}>{t('withdraw.note')}</Text>

              {message && <ErrorBanner message={message} />}
              <Button label={t('withdraw.submit')} onPress={submit} loading={busy} disabled={!canSubmit} />
            </>
          )}
        </Column>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  balanceCard: { padding: spacing.md, borderRadius: radius.lg - 4, backgroundColor: colors.bgTint, marginBottom: spacing.md, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  balanceLabel: { fontFamily: fonts.medium, fontSize: 14, color: colors.textMuted },
  balance: { fontFamily: fonts.extrabold, fontSize: 22, color: colors.limeDark, letterSpacing: -0.4 },
  section: { marginTop: spacing.md, marginBottom: spacing.sm, fontFamily: fonts.bold, fontSize: 16, color: colors.text },
  gap: { height: spacing.md },
  hint: { marginTop: -spacing.sm, marginBottom: spacing.md, fontFamily: fonts.regular, fontSize: 12.5, lineHeight: 18, color: colors.textMuted },
  note: { marginBottom: spacing.md, padding: spacing.md, borderRadius: radius.lg - 4, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, fontFamily: fonts.regular, fontSize: 13.5, lineHeight: 20, color: colors.textMuted },
});
