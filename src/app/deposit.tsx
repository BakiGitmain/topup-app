import { Redirect, router } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { Outcome } from '../components/pay/Outcome';
import { PaymentInstructions } from '../components/pay/PaymentInstructions';
import { Button } from '../components/ui/Button';
import { ErrorBanner } from '../components/ui/ErrorBanner';
import { ScreenHeader } from '../components/ui/ScreenHeader';
import { Column } from '../components/ui/TabScroll';
import { TextField } from '../components/ui/TextField';
import { useAuth } from '../lib/auth';
import { fetchPaymentAccounts } from '../lib/checkout';
import { confirmDestructive } from '../lib/confirm';
import { useT } from '../lib/i18n';
import { amountToSend, cleanReference, nextStep, type ProviderId } from '../lib/paymentView';
import type { StringKey } from '../lib/strings';
import { colors, fonts, radius, spacing } from '../lib/theme';
import { useAsync } from '../lib/useAsync';
import { cancelDeposit, fetchDeposit, fetchOpenDeposit, requestDeposit, verifyDeposit } from '../lib/wallet';
import { DEPOSIT_MAX, DEPOSIT_MIN, depositAmountProblem, isOpenDeposit, parseAmount } from '../lib/walletLogic';

const QUICK = [100, 500, 1000, 2000];
const POLL_MS = 2000;
const POLL_TRIES = 8;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Deposit: choose an amount, send exactly that by Telebirr or CBE, enter the reference. The server checks it with
 * ShegerPay and credits the balance only if the transfer is for exactly that amount. Closing the app in the middle is
 * safe: the open request is read back from the database the next time this screen opens.
 */
export default function DepositScreen() {
  const { user, session, refreshAccount, initializing } = useAuth();
  const t = useT();
  const insets = useSafeAreaInsets();
  const userId = user?.id;

  // The customer's open (unpaid) deposit, if any. The database is the source of truth, so a relaunch resumes it.
  const open = useAsync(() => (userId ? fetchOpenDeposit(userId) : Promise.resolve(null)), userId ?? '', !initializing && !!userId);
  const accounts = useAsync(fetchPaymentAccounts);

  const [depositId, setDepositId] = useState<string | null>(null);
  const [finished, setFinished] = useState<{ status: 'paid' | 'mismatch'; amount: number } | null>(null);
  const [amountText, setAmountText] = useState('');
  const [creating, setCreating] = useState(false);
  const [provider, setProvider] = useState<ProviderId>('telebirr');
  const [reference, setReference] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);

  // The deposit being worked on: the one just created, else the open one read from the database.
  const activeId = depositId ?? open.data?.id ?? null;
  const details = useAsync(
    () => (userId && activeId ? fetchDeposit(userId, activeId) : Promise.resolve(null)),
    activeId ?? 'none',
    !initializing && !!userId && !!activeId
  );
  const deposit = details.data ?? (open.data && open.data.id === activeId ? open.data : null);

  if (!initializing && !session) return <Redirect href="/sign-in" />;

  const amount = parseAmount(amountText);
  const amountProblem = amountText.trim() === '' ? null : depositAmountProblem(amount);
  const cleaned = cleanReference(reference);

  async function create() {
    if (creating) return;
    const problem = depositAmountProblem(amount);
    if (problem || amount === null) return setMessage(t(`deposit.problem.${problem ?? 'required'}` as StringKey, { min: amountToSend(DEPOSIT_MIN), max: amountToSend(DEPOSIT_MAX) }));
    setCreating(true);
    setMessage(null);
    try {
      const result = await requestDeposit(amount);
      if (result.ok) {
        setDepositId(result.value.depositId);
      } else if (result.code === 'deposit_open' && result.depositId) {
        setDepositId(result.depositId); // resume the one already open instead of making a second
      } else {
        setMessage(t(`wallet.err.${result.code}` as StringKey));
      }
    } finally {
      setCreating(false);
    }
  }

  async function waitForResult(id: string) {
    for (let i = 0; i < POLL_TRIES; i++) {
      await sleep(POLL_MS);
      const fresh = userId ? await fetchDeposit(userId, id).catch(() => null) : null;
      if (fresh && !isOpenDeposit(fresh.status)) return fresh;
    }
    return null;
  }

  async function submit() {
    if (busy || !deposit) return;
    if (cleaned === null) return setMessage(t('pay.refRequired'));
    setBusy(true);
    setMessage(null);
    try {
      const answer = await verifyDeposit(deposit.id, provider, cleaned);
      const step = nextStep(answer);
      switch (step.action) {
        case 'paid':
          setFinished({ status: 'paid', amount: deposit.amount });
          await refreshAccount();
          break;
        case 'mismatch':
          setFinished({ status: 'mismatch', amount: deposit.amount });
          break;
        case 'closed':
          // Settled some other way (or the claim was lost): show what the database now says.
          await details.reload();
          setMessage(t('pay.closed'));
          break;
        case 'fix_reference':
          setMessage(t(step.messageKey as StringKey));
          break;
        case 'reference_used':
          setMessage(t('pay.referenceUsed'));
          break;
        case 'wait': {
          setMessage(t('pay.wait'));
          const settled = await waitForResult(deposit.id);
          if (settled) {
            setFinished({ status: settled.status === 'paid' ? 'paid' : 'mismatch', amount: settled.amount });
            await refreshAccount();
            setMessage(null);
          } else {
            setMessage(t('pay.tryLater'));
          }
          break;
        }
        case 'try_later':
          setMessage(t('pay.tryLater'));
          break;
      }
    } finally {
      setBusy(false);
    }
  }

  async function changeAmount() {
    if (!deposit) return;
    const ok = await confirmDestructive(t('deposit.cancelTitle'), t('deposit.cancelBody'), t('deposit.cancel'));
    if (!ok) return;
    setCancelling(true);
    try {
      await cancelDeposit(deposit.id);
      setDepositId(null);
      setReference('');
      setMessage(null);
      await open.reload();
    } catch {
      setMessage(t('deposit.cancelFailed'));
    } finally {
      setCancelling(false);
    }
  }

  // What to show: the outcome (also for a deposit that was already settled elsewhere), the payment form for an open one, or
  // the amount picker.
  const settledDeposit = deposit && !isOpenDeposit(deposit.status) ? deposit : null;
  const outcome = finished ?? (settledDeposit && (settledDeposit.status === 'paid' || settledDeposit.status === 'mismatch') ? { status: settledDeposit.status, amount: settledDeposit.amount } : null);
  const loading = (open.status === 'loading' && !open.data) || (!!activeId && details.status === 'loading' && !deposit);

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + spacing.xxl }} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
        <Column>
          <ScreenHeader title={t('deposit.title')} />

          {loading && <ActivityIndicator style={styles.loading} color={colors.limeDeep} />}

          {!loading && outcome?.status === 'paid' && (
            <Outcome icon="check-circle" tone="ok" title={t('deposit.paidTitle')} body={t('deposit.paidBody', { amount: amountToSend(outcome.amount) })} action={t('deposit.done')} onAction={() => router.replace('/wallet')} />
          )}

          {!loading && outcome?.status === 'mismatch' && (
            <Outcome icon="alert-triangle" tone="warn" title={t('deposit.mismatchTitle')} body={t('deposit.mismatchBody', { amount: amountToSend(outcome.amount) })} action={t('deposit.done')} onAction={() => router.replace('/wallet')} />
          )}

          {!loading && !outcome && !deposit && (
            <>
              <Text style={styles.lead}>{t('deposit.lead')}</Text>
              <TextField
                label={t('deposit.amount')}
                value={amountText}
                onChangeText={(v) => {
                  setAmountText(v);
                  setMessage(null);
                }}
                keyboardType="decimal-pad"
                inputMode="decimal"
                maxLength={12}
                returnKeyType="done"
                onSubmitEditing={create}
                error={amountProblem ? t(`deposit.problem.${amountProblem}` as StringKey, { min: amountToSend(DEPOSIT_MIN), max: amountToSend(DEPOSIT_MAX) }) : null}
              />
              <View style={styles.quick} accessibilityRole="radiogroup" accessibilityLabel={t('deposit.quick')}>
                {QUICK.map((q) => (
                  <Pressable key={q} onPress={() => setAmountText(String(q))} accessibilityRole="button" style={({ pressed }) => [styles.chip, pressed && { opacity: 0.8 }, amount === q && styles.chipOn]}>
                    <Text style={[styles.chipText, amount === q && styles.chipTextOn]}>{amountToSend(q)}</Text>
                  </Pressable>
                ))}
              </View>
              {message && <ErrorBanner message={message} />}
              <Button label={t('deposit.start')} onPress={create} loading={creating} disabled={amount === null || depositAmountProblem(amount) !== null} />
            </>
          )}

          {!loading && !outcome && deposit && isOpenDeposit(deposit.status) && (
            <>
              <View style={styles.amountCard}>
                <Text style={styles.amountLabel}>{t('deposit.sendExactly')}</Text>
                <Text style={styles.amount} accessibilityLabel={`${t('deposit.sendExactly')} ${amountToSend(deposit.amount)}`}>
                  {amountToSend(deposit.amount)}
                </Text>
                <Text style={styles.amountNote}>{t('deposit.exactNote')}</Text>
              </View>

              <PaymentInstructions
                accounts={accounts.data}
                accountsLoading={accounts.status === 'loading'}
                provider={provider}
                onProvider={(p) => {
                  setProvider(p);
                  setMessage(null);
                }}
                reference={reference}
                onReference={(v) => {
                  setReference(v);
                  setMessage(null);
                }}
                busy={busy}
                message={message}
                onSubmit={submit}
              />

              <Button label={t('deposit.cancel')} variant="outline" onPress={changeAmount} loading={cancelling} disabled={busy} style={styles.cancel} />
            </>
          )}
        </Column>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  loading: { marginTop: spacing.xxl },
  lead: { marginBottom: spacing.md, fontFamily: fonts.medium, fontSize: 15, lineHeight: 22, color: colors.textMuted },
  quick: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.md },
  chip: { minHeight: 44, paddingHorizontal: spacing.md, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  chipOn: { backgroundColor: colors.limeSoft, borderColor: colors.limeDeep },
  chipText: { fontFamily: fonts.semibold, fontSize: 14, color: colors.text },
  chipTextOn: { color: colors.limeDark },
  amountCard: { padding: spacing.lg, borderRadius: radius.lg, backgroundColor: colors.bgTint, alignItems: 'center', marginBottom: spacing.md },
  amountLabel: { fontFamily: fonts.semibold, fontSize: 14, color: colors.textMuted },
  amount: { marginTop: 2, fontFamily: fonts.extrabold, fontSize: 38, color: colors.text, letterSpacing: -1 },
  amountNote: { marginTop: spacing.xs, maxWidth: 300, textAlign: 'center', fontFamily: fonts.regular, fontSize: 12.5, lineHeight: 18, color: colors.textMuted },
  cancel: { marginTop: spacing.sm },
});
