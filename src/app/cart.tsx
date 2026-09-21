import { Redirect, router } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { FeatherIcon } from '../components/art/FeatherIcon';
import { CartLineRow } from '../components/cart/CartLineRow';
import { StateMessage } from '../components/market/StateMessage';
import { Button } from '../components/ui/Button';
import { ErrorBanner } from '../components/ui/ErrorBanner';
import { ScreenHeader } from '../components/ui/ScreenHeader';
import { Column } from '../components/ui/TabScroll';
import { useAuth } from '../lib/auth';
import { cartErrorText, useCart } from '../lib/cart';
import { cartTotal, checkoutGate } from '../lib/cartLogic';
import { formatBirr } from '../lib/catalog';
import { createCartOrder, savePendingOrderId } from '../lib/checkout';
import { checkoutPath } from '../lib/walletLogic';
import { parseCheckoutError, splitFailures } from '../lib/checkoutErrors';
import { useT } from '../lib/i18n';
import { colors, fonts, radius, spacing } from '../lib/theme';
import type { StringKey } from '../lib/strings';
import { useToast } from '../lib/toast';

const PROBLEM_KEYS: Record<string, StringKey> = {
  fill_fields: 'cart.problem.fill_fields',
  checking: 'cart.problem.checking',
  invalid_id: 'cart.problem.invalid_id',
  check_failed: 'cart.problem.check_failed',
  check_expired: 'cart.problem.check_expired',
  confirm_id: 'cart.problem.confirm_id',
  wrong_region: 'cart.problem.wrong_region',
  region_unknown: 'cart.problem.region_unknown',
  unavailable: 'cart.problem.unavailable',
  package_unavailable: 'cart.problem.package_unavailable',
  choose_package: 'cart.problem.choose_package',
};

export default function CartScreen() {
  const { user, session, balance, refreshAccount, initializing } = useAuth();
  const cart = useCart();
  const t = useT();
  const toast = useToast();
  const insets = useSafeAreaInsets();

  // What each line says blocks it (its own ID check). A line that hasn't reported yet counts as "checking".
  const [blockers, setBlockers] = useState<Record<string, string | null>>({});
  const onBlocker = useCallback((lineId: string, blocker: string | null) => setBlockers((current) => (current[lineId] === blocker ? current : { ...current, [lineId]: blocker })), []);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!initializing && !session) return <Redirect href="/sign-in" />;

  const gate = checkoutGate(
    cart.lines.map((l) => ({
      id: l.id,
      name: `${l.productName} ${l.label}`.trim(),
      available: l.available,
      blocker: l.available ? (blockers[l.id] === undefined ? 'checking' : blockers[l.id]) : null,
    }))
  );
  const total = cartTotal(cart.lines);
  // A hint only: the database decides at checkout (it pays from the wallet only if the balance covers the WHOLE total).
  const path = checkoutPath(balance, total);
  const loading = cart.status === 'loading' && cart.lines.length === 0;

  async function run(action: () => Promise<void>) {
    try {
      await action();
    } catch (err) {
      setError(cartErrorText(err));
    }
  }

  async function checkout() {
    if (!gate.canCheckout || busy || !user) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const created = await createCartOrder();
      if (created.paid) {
        // The wallet covered it: already paid, nothing to resume and no bank-transfer screen to go through.
        await Promise.all([refreshAccount(), cart.reload()]);
        router.replace({ pathname: '/pay/[id]', params: { id: created.orderId } });
        return;
      }
      // The recovery point: remembered BEFORE any payment screen shows, so a crash from here on resumes THIS order.
      await savePendingOrderId(user.id, created.orderId);
      await cart.reload();
      router.replace({ pathname: '/pay/[id]', params: { id: created.orderId } });
    } catch (err) {
      const parsed = parseCheckoutError(err);
      if (parsed.kind === 'pending_order_exists') {
        await savePendingOrderId(user.id, parsed.orderId);
        toast(t('cart.pending'));
        router.replace({ pathname: '/pay/[id]', params: { id: parsed.orderId } });
      } else if (parsed.kind === 'cart_unavailable') {
        // Nothing was created. Drop what is no longer for sale; keep (and name) what needs its ID fixed.
        const { drop, fix } = splitFailures(parsed.failures);
        if (drop.length > 0) await cart.remove(drop.map((f) => f.itemId)).catch(() => {});
        setNotice(
          [
            drop.length > 0 ? t('cart.dropped', { items: drop.map((f) => `${f.productName} ${f.label}`.trim()).join(', ') }) : null,
            fix.length > 0 ? t('cart.fixIds', { items: fix.map((f) => `${f.productName} ${f.label}`.trim()).join(', ') }) : null,
          ]
            .filter(Boolean)
            .join('\n')
        );
        await cart.reload();
      } else if (parsed.kind === 'cart_empty') {
        await cart.reload();
      } else {
        setError(t('cart.checkoutFailed'));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + spacing.xxl }} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
        <Column>
          <ScreenHeader title={t('cart.title')} />

          {loading && <ActivityIndicator style={styles.loading} color={colors.limeDeep} />}

          {cart.status === 'error' && cart.lines.length === 0 && (
            <StateMessage
              tone="danger"
              icon={<FeatherIcon name="alert-triangle" size={30} color={colors.danger} />}
              title={t('cart.title')}
              body={t('cart.loadError')}
              actionLabel={t('common.retry')}
              onAction={cart.reload}
            />
          )}

          {cart.status === 'ready' && cart.lines.length === 0 && (
            <StateMessage
              icon={<FeatherIcon name="shopping-bag" size={30} color={colors.limeInk} />}
              title={t('cart.empty')}
              body={t('cart.emptyBody')}
              actionLabel={t('cart.browse')}
              onAction={() => router.replace('/shop')}
            />
          )}

          {notice && <ErrorBanner message={notice} />}
          {error && <ErrorBanner message={error} />}

          {cart.lines.map((line) => (
            <CartLineRow
              key={line.id}
              line={line}
              onBlocker={onBlocker}
              onQty={(id, q) => run(() => cart.setQty(id, q))}
              onTick={(id, checked) => run(() => cart.setChecked(id, checked))}
              onRemove={(id) => run(() => cart.remove([id]))}
            />
          ))}

          {cart.lines.length > 0 && (
            <View style={styles.summary}>
              <View style={styles.totalRow}>
                <Text style={styles.totalLabel}>{t('cart.total')}</Text>
                <Text style={styles.totalValue}>{formatBirr(total)}</Text>
              </View>

              {balance !== null && (
                <Text style={[styles.payHint, path === 'wallet' && styles.payHintWallet]} accessibilityLiveRegion="polite">
                  {t(path === 'wallet' ? 'cart.payWallet' : 'cart.payBank', { balance: formatBirr(balance) })}
                </Text>
              )}

              {gate.problems.length > 0 && (
                <View style={styles.problems} accessibilityLiveRegion="polite">
                  <Text style={styles.problemsTitle}>{t('cart.fixFirst')}</Text>
                  {gate.problems.map((p) => (
                    <Text key={p.lineId} style={styles.problemLine}>
                      {`•  ${p.name}: ${t(PROBLEM_KEYS[p.problem] ?? 'cart.problem.unavailable')}`}
                    </Text>
                  ))}
                </View>
              )}

              <Button label={path === 'wallet' ? t('cart.checkoutWallet', { amount: formatBirr(total) }) : t('cart.checkout')} onPress={checkout} loading={busy} disabled={!gate.canCheckout} />
            </View>
          )}
        </Column>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  loading: { marginTop: spacing.xxl },
  summary: { marginTop: spacing.md, padding: spacing.md, borderRadius: radius.lg - 4, backgroundColor: colors.bgTint, gap: spacing.md },
  payHint: { fontFamily: fonts.medium, fontSize: 13, lineHeight: 19, color: colors.textMuted },
  payHintWallet: { color: colors.limeInk },
  totalRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  totalLabel: { fontFamily: fonts.semibold, fontSize: 15, color: colors.textMuted },
  totalValue: { fontFamily: fonts.extrabold, fontSize: 24, color: colors.text, letterSpacing: -0.5 },
  problems: { gap: 4 },
  problemsTitle: { fontFamily: fonts.bold, fontSize: 13.5, color: colors.danger },
  problemLine: { fontFamily: fonts.medium, fontSize: 13.5, lineHeight: 19, color: colors.danger },
});
