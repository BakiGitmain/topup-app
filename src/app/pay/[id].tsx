import { Redirect, router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { FeatherIcon } from '../../components/art/FeatherIcon';
import { StateMessage } from '../../components/market/StateMessage';
import { Outcome } from '../../components/pay/Outcome';
import { PaymentInstructions } from '../../components/pay/PaymentInstructions';
import { Button } from '../../components/ui/Button';
import { ScreenHeader } from '../../components/ui/ScreenHeader';
import { Column } from '../../components/ui/TabScroll';
import { useAuth } from '../../lib/auth';
import { useCart } from '../../lib/cart';
import { cancelOrder, clearPendingOrderId, fetchPayOrder, fetchPaymentAccounts, verifyPayment } from '../../lib/checkout';
import { confirmDestructive } from '../../lib/confirm';
import { useT } from '../../lib/i18n';
import { amountToSend, cleanReference, nextStep, type ProviderId } from '../../lib/paymentView';
import type { StringKey } from '../../lib/strings';
import { colors, fonts, radius, spacing } from '../../lib/theme';
import { useToast } from '../../lib/toast';
import { useAsync } from '../../lib/useAsync';
import { payOrderWithWallet } from '../../lib/wallet';
import { checkoutPath } from '../../lib/walletLogic';

const POLL_MS = 2000;
const POLL_TRIES = 8;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export default function PayScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { user, session, balance, refreshAccount, initializing } = useAuth();
  const cart = useCart();
  const t = useT();
  const toast = useToast();
  const insets = useSafeAreaInsets();
  const userId = user?.id;

  const order = useAsync(() => (userId ? fetchPayOrder(userId, id) : Promise.resolve(null)), id ?? '', !initializing && !!userId && !!id);
  const accounts = useAsync(fetchPaymentAccounts);

  const [provider, setProvider] = useState<ProviderId>('telebirr');
  const [reference, setReference] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [paying, setPaying] = useState(false);

  const data = order.data;
  const settled = data !== null && data.status !== 'pending_payment';

  // An order that is no longer awaiting payment is nothing to resume: forget the stored id.
  useEffect(() => {
    if (userId && settled) clearPendingOrderId(userId);
  }, [userId, settled]);

  // A wallet payment changes the balance, so re-read it once the order shows as paid.
  const paidNow = data?.status === 'paid';
  useEffect(() => {
    if (paidNow) refreshAccount();
  }, [paidNow, refreshAccount]);

  if (!initializing && !session) return <Redirect href="/sign-in" />;

  const cleaned = cleanReference(reference);
  // Unpaid but the wallet now covers it (the customer topped up since checkout): offer the wallet, whole amount only.
  const walletCovers = data !== null && !settled && checkoutPath(balance, data.amount) === 'wallet';

  /** Read the order until it settles (another request was checking it). */
  async function waitForResult() {
    for (let i = 0; i < POLL_TRIES; i++) {
      await sleep(POLL_MS);
      const fresh = userId ? await fetchPayOrder(userId, id).catch(() => null) : null;
      if (fresh && fresh.status !== 'pending_payment') return fresh;
    }
    return null;
  }

  async function submit() {
    if (busy) return;
    if (cleaned === null) return setMessage(t('pay.refRequired'));
    setBusy(true);
    setMessage(null);
    try {
      const step = nextStep(await verifyPayment(id, provider, cleaned));
      switch (step.action) {
        case 'paid':
        case 'mismatch':
        case 'closed':
          if (userId) await clearPendingOrderId(userId);
          await order.reload();
          if (step.action === 'closed') setMessage(t('pay.closed'));
          break;
        case 'fix_reference':
          setMessage(t(step.messageKey as StringKey));
          break;
        case 'reference_used':
          setMessage(t('pay.referenceUsed'));
          break;
        case 'wait': {
          setMessage(t('pay.wait'));
          const settledOrder = await waitForResult();
          if (settledOrder) await order.reload();
          else setMessage(t('pay.tryLater'));
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

  async function payFromWallet() {
    if (paying || busy) return;
    setPaying(true);
    setMessage(null);
    try {
      await payOrderWithWallet(id);
      if (userId) await clearPendingOrderId(userId);
      await refreshAccount();
      await order.reload();
    } catch {
      // Not enough balance any more, a bank check is running, or the order was settled meanwhile: show the truth.
      setMessage(t('pay.walletFailed'));
      await Promise.all([order.reload(), refreshAccount()]);
    } finally {
      setPaying(false);
    }
  }

  async function cancel() {
    const ok = await confirmDestructive(t('pay.cancelTitle'), t('pay.cancelBody'), t('pay.cancel'));
    if (!ok) return;
    setCancelling(true);
    try {
      await cancelOrder(id);
      if (userId) await clearPendingOrderId(userId);
      await cart.reload();
      toast(t('pay.cancelled'));
      router.replace('/cart');
    } catch {
      setMessage(t('pay.cancelFailed'));
    } finally {
      setCancelling(false);
    }
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + spacing.xxl }} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
        <Column>
          <ScreenHeader title={t('pay.title')} />

          {order.status === 'loading' && !data && <ActivityIndicator style={styles.loading} color={colors.limeDeep} />}

          {order.status !== 'loading' && !data && (
            <StateMessage
              tone="danger"
              icon={<FeatherIcon name="alert-triangle" size={30} color={colors.danger} />}
              title={t('pay.title')}
              body={t('pay.loadError')}
              actionLabel={t('common.retry')}
              onAction={order.reload}
            />
          )}

          {data?.status === 'paid' && (
            <Outcome
              icon="check-circle"
              tone="ok"
              title={t('pay.paidTitle')}
              body={t(data.provider === 'wallet' ? 'pay.paidWalletBody' : 'pay.paidBody', { amount: amountToSend(data.amount) })}
              action={t('pay.viewOrders')}
              onAction={() => router.replace('/orders')}
            />
          )}

          {data?.status === 'payment_mismatch' && (
            <Outcome
              icon="alert-triangle"
              tone="warn"
              title={t('pay.mismatchTitle')}
              body={t('pay.mismatchBody', { amount: amountToSend(data.amount) })}
              action={t('pay.viewOrders')}
              onAction={() => router.replace('/orders')}
            />
          )}

          {data && settled && data.status !== 'paid' && data.status !== 'payment_mismatch' && (
            <Outcome icon="clock" tone="warn" title={t('pay.title')} body={t('pay.closed')} action={t('pay.viewOrders')} onAction={() => router.replace('/orders')} />
          )}

          {data && !settled && (
            <>
              <View style={styles.amountCard}>
                <Text style={styles.amountLabel}>{t('pay.amount')}</Text>
                <Text style={styles.amount} accessibilityLabel={`${t('pay.amount')} ${amountToSend(data.amount)}`}>
                  {amountToSend(data.amount)}
                </Text>
              </View>

              <Text style={styles.section}>{t('pay.items')}</Text>
              <View style={styles.items}>
                {data.items.map((item) => (
                  <View key={item.id} style={styles.item}>
                    <View style={styles.itemText}>
                      <Text style={styles.itemName} numberOfLines={2}>
                        {item.productName} · {item.optionLabel}
                        {item.quantity > 1 ? `  ×${item.quantity}` : ''}
                      </Text>
                      {item.ids.map(([key, value]) => (
                        <Text key={key} style={styles.itemId} numberOfLines={1}>
                          {value}
                          {item.playerName ? `  ·  ${item.playerName}` : ''}
                        </Text>
                      ))}
                    </View>
                    <Text style={styles.itemPrice}>{amountToSend(item.lineTotal)}</Text>
                  </View>
                ))}
              </View>

              {walletCovers && (
                <View style={styles.walletBox}>
                  <Text style={styles.walletTitle}>{t('pay.walletOr')}</Text>
                  <Button label={t('pay.wallet', { amount: amountToSend(data.amount) })} onPress={payFromWallet} loading={paying} disabled={busy} />
                </View>
              )}

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

              <Button label={t('pay.cancel')} variant="outline" onPress={cancel} loading={cancelling} disabled={busy || paying} style={styles.cancel} />
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
  amountCard: { padding: spacing.lg, borderRadius: radius.lg, backgroundColor: colors.bgTint, alignItems: 'center', marginBottom: spacing.md },
  amountLabel: { fontFamily: fonts.semibold, fontSize: 14, color: colors.textMuted },
  amount: { marginTop: 2, fontFamily: fonts.extrabold, fontSize: 38, color: colors.text, letterSpacing: -1 },
  section: { marginTop: spacing.md, marginBottom: spacing.sm, fontFamily: fonts.bold, fontSize: 16, color: colors.text },
  items: { borderRadius: radius.lg - 4, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, paddingHorizontal: spacing.md },
  item: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm, paddingVertical: spacing.sm + 2, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  itemText: { flex: 1 },
  itemName: { fontFamily: fonts.semibold, fontSize: 14, color: colors.text },
  itemId: { marginTop: 2, fontFamily: fonts.regular, fontSize: 12.5, color: colors.textMuted },
  itemPrice: { fontFamily: fonts.bold, fontSize: 14, color: colors.limeInk },
  walletBox: { marginTop: spacing.md, padding: spacing.md, borderRadius: radius.lg - 4, backgroundColor: colors.limeSoft },
  walletTitle: { marginBottom: spacing.sm, fontFamily: fonts.bold, fontSize: 14.5, color: colors.limeDark },
  cancel: { marginTop: spacing.sm },
});
