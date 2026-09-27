import { Redirect, router } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { FeatherIcon } from '../components/art/FeatherIcon';
import { CartLineRow } from '../components/cart/CartLineRow';
import { StateMessage } from '../components/market/StateMessage';
import { BottomSheet } from '../components/ui/BottomSheet';
import { Button } from '../components/ui/Button';
import { ErrorBanner } from '../components/ui/ErrorBanner';
import { ScreenHeader } from '../components/ui/ScreenHeader';
import { Column } from '../components/ui/TabScroll';
import { TextField } from '../components/ui/TextField';
import { useAuth } from '../lib/auth';
import { cartErrorText, useCart } from '../lib/cart';
import { cartTotal, checkoutGate } from '../lib/cartLogic';
import { formatBirr } from '../lib/catalog';
import { createCartOrder, savePendingOrderId } from '../lib/checkout';
import { formatDate } from '../lib/format';
import { checkoutPath } from '../lib/walletLogic';
import { parseCheckoutError, splitFailures } from '../lib/checkoutErrors';
import { previewDiscountCode } from '../lib/discountPreview';
import { useT } from '../lib/i18n';
import { SEARCH_IDLE_MS } from '../lib/searchLogic';
import { colors, fonts, radius, spacing } from '../lib/theme';
import type { StringKey } from '../lib/strings';
import { useAsync } from '../lib/useAsync';
import { useDebouncedSearch } from '../lib/useDebounced';
import { useToast } from '../lib/toast';
import { fetchUnredeemedPrizes } from '../lib/wheel';

const CODE_ERROR_KEYS: Record<string, StringKey> = {
  code_not_found: 'cart.code.notFound',
  code_inactive: 'cart.code.inactive',
  code_expired: 'cart.code.expired',
  code_not_applicable: 'cart.code.notApplicable',
  code_already_used: 'cart.code.alreadyUsed',
};

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
  const [code, setCode] = useState('');
  // Set only by an actual checkout attempt (the server's own, final word); the live preview below has its own
  // derived error so the two never fight over one piece of state.
  const [checkoutCodeError, setCheckoutCodeError] = useState<string | null>(null);
  // The code text that was actually "Applied" -- this, not the raw text box, is what checkout sends. Typing again
  // after applying clears it, so a stale discount can never ride along with edited text.
  const [appliedCode, setAppliedCode] = useState<string | null>(null);
  // A won wheel prize the customer chose to spend here. A code and a wheel prize never both apply -- applying one
  // clears the other (see the migration's flagged decision: whichever was applied last wins).
  const [appliedWheelPrizeId, setAppliedWheelPrizeId] = useState<string | null>(null);
  // Only opened when there is more than one unredeemed prize to choose between.
  const [prizePickerOpen, setPrizePickerOpen] = useState(false);
  // A ref, not just the `busy` state: a fast double-tap can fire a second onPress before React has re-rendered the
  // button as disabled/loading (state updates aren't synchronous), so the SECOND request can reach the server while
  // the first is still in flight. The database then correctly refuses the second one (e.g. a discount code is only
  // good for a customer's first order, and the first request just became that order) -- but the customer only sees
  // that refusal, even though their real checkout, from the first request, already succeeded. A ref is read/written
  // synchronously, so it blocks the second call before it ever starts, regardless of render timing.
  const checkingOutRef = useRef(false);
  const total = cartTotal(cart.lines);

  // Debounced live validation: settles 1.5 s after the last keystroke (same pattern as search elsewhere), so typing
  // a code never sends one request per key. Re-runs if the cart total changes too (a quantity edited while a code
  // is typed), not only when the text itself changes. Kept above the sign-in redirect below (like every other hook
  // here): hooks must run in the same order on every render, redirect or not.
  const debouncedCode = useDebouncedSearch(code.trim(), SEARCH_IDLE_MS);
  const previewInput = debouncedCode.value;
  const preview = useAsync(
    () => (previewInput ? previewDiscountCode(previewInput) : Promise.resolve(null)),
    `${previewInput}|${total}`,
    previewInput.length > 0
  );

  const wheelPrizes = useAsync(() => (user ? fetchUnredeemedPrizes(user.id) : Promise.resolve([])), user?.id ?? '', !initializing && !!user);

  if (!initializing && !session) return <Redirect href="/sign-in" />;

  const gate = checkoutGate(
    cart.lines.map((l) => ({
      id: l.id,
      name: `${l.productName} ${l.label}`.trim(),
      available: l.available,
      blocker: l.available ? (blockers[l.id] === undefined ? 'checking' : blockers[l.id]) : null,
    }))
  );
  const loading = cart.status === 'loading' && cart.lines.length === 0;
  // Only trust the preview once typing has caught up with it -- otherwise it is still describing the PREVIOUS text.
  const previewResult = !debouncedCode.pending && previewInput.length > 0 ? preview.data : null;
  // An already-used code is not a failure -- it still earns its own portal_coin_bonus, just no discount -- so it
  // gets its own informational line instead of the generic blocking error (see liveCodeError below, which skips it).
  const alreadyUsedBonus = previewResult && !previewResult.ok && previewResult.problem === 'code_already_used' ? previewResult.portalCoinBonus : undefined;
  const liveCodeError = previewResult && !previewResult.ok && alreadyUsedBonus === undefined ? t(CODE_ERROR_KEYS[previewResult.problem] ?? 'cart.checkoutFailed') : null;
  const applied = appliedCode !== null && appliedCode === previewInput && previewResult?.ok === true;
  const canApply = !applied && previewResult?.ok === true;
  const codeErrorText = checkoutCodeError ?? liveCodeError;
  // Every unredeemed prize, oldest first (server order). One prize picks itself; two or more get a picker sheet
  // instead of being forced into oldest-first -- see the request this round: the customer chooses which to spend.
  const prizes = wheelPrizes.data ?? [];
  const appliedPrize = appliedWheelPrizeId !== null ? (prizes.find((p) => p.id === appliedWheelPrizeId) ?? null) : null;
  const wheelApplied = appliedPrize !== null;
  // Same capping the database itself applies (min discount, never brings the order to exactly Br 0).
  const wheelDiscount = appliedPrize ? Math.min(appliedPrize.discountBirr, Math.max(total - 1, 0)) : 0;
  // What checkout will actually charge: whichever discount (code or wheel prize) is applied, otherwise the plain total.
  const effectiveTotal = applied && previewResult?.ok ? previewResult.newTotal : wheelApplied ? total - wheelDiscount : total;
  // No "Apply" step exists for a reused code (there is nothing to apply -- no discount), so it rides along to
  // checkout as-is once recognized, same as an applied first-use code. Skipped while a wheel prize is applied, so
  // stale code text left in the field can never trip the server's "never both" guard on its own.
  const codeToSend = appliedCode ?? (!wheelApplied && alreadyUsedBonus !== undefined ? previewInput : null);
  // A hint only: the database decides at checkout (it pays from the wallet only if the balance covers the WHOLE total).
  const path = checkoutPath(balance, effectiveTotal);

  async function run(action: () => Promise<void>) {
    try {
      await action();
    } catch (err) {
      setError(cartErrorText(err));
    }
  }

  function applyPrize(prizeId: string) {
    setAppliedWheelPrizeId(prizeId);
    setAppliedCode(null);
    setCheckoutCodeError(null);
    setPrizePickerOpen(false);
  }

  async function checkout() {
    // cart.mutating: a still-in-flight add/remove/quantity change. create_cart_order() reads cart_items fresh from
    // the server the instant it runs -- checking out while a removal is still on the wire can charge for a line the
    // customer just removed, because the server hasn't seen the delete yet. Block until every mutation has settled.
    if (!gate.canCheckout || cart.mutating || checkingOutRef.current || !user) return;
    checkingOutRef.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    setCheckoutCodeError(null);
    try {
      const created = await createCartOrder(codeToSend, appliedWheelPrizeId);
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
      } else if (parsed.kind in CODE_ERROR_KEYS) {
        // Nothing was created and the cart is untouched: leave it as the customer left it, just point at the code.
        // The applied code turned out stale (a rare race between Apply and Checkout) -- drop it so the UI doesn't
        // keep claiming a discount that the server just refused.
        setAppliedCode(null);
        setCheckoutCodeError(t(CODE_ERROR_KEYS[parsed.kind]));
      } else if (parsed.kind === 'wheel_prize_not_found' || parsed.kind === 'wheel_prize_unavailable') {
        // The applied prize turned out stale (already spent by another in-flight order, say) -- drop it and
        // refresh the list so the pill reflects what is actually still available.
        setAppliedWheelPrizeId(null);
        await wheelPrizes.reload();
        setNotice(t('cart.wheelUnavailable'));
      } else if (parsed.kind === 'multiple_discounts_not_allowed') {
        // Never reachable through normal use (applying one already clears the other) -- a defensive fallback only.
        setAppliedWheelPrizeId(null);
        setAppliedCode(null);
      } else {
        setError(t('cart.checkoutFailed'));
      }
    } finally {
      checkingOutRef.current = false;
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
                {applied && previewResult?.ok ? (
                  <View style={styles.totalDiscounted}>
                    <Text style={styles.totalOld}>{formatBirr(total)}</Text>
                    <Text style={styles.totalNew}>{formatBirr(previewResult.newTotal)}</Text>
                  </View>
                ) : (
                  <Text style={styles.totalValue}>{formatBirr(total)}</Text>
                )}
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

              <TextField
                label={t('cart.codeLabel')}
                placeholder={t('cart.codePlaceholder')}
                value={code}
                onChangeText={(v) => {
                  setCode(v);
                  setCheckoutCodeError(null);
                  setAppliedCode(null);
                }}
                error={applied ? null : codeErrorText}
                autoCapitalize="characters"
                autoCorrect={false}
              />

              {debouncedCode.pending && code.trim().length > 0 && !applied && <Text style={styles.codeHint}>{t('cart.codeChecking')}</Text>}

              {alreadyUsedBonus !== undefined && (
                <Text style={styles.codeApplied}>{t('cart.code.alreadyUsedBonus', { n: String(alreadyUsedBonus) })}</Text>
              )}

              {canApply && previewResult?.ok && (
                <View style={styles.applyRow}>
                  <Text style={styles.codeDiscountAmount}>{`-${formatBirr(previewResult.discountAmount)}`}</Text>
                  <Button
                    label={t('cart.codeApplyPercent', { percent: String(Math.round((previewResult.discountAmount / previewResult.total) * 100)) })}
                    variant="outline"
                    onPress={() => {
                      setAppliedCode(previewInput);
                      setAppliedWheelPrizeId(null);
                    }}
                    style={styles.applyButton}
                  />
                </View>
              )}

              {applied && previewResult?.ok && <Text style={styles.codeApplied}>{t('cart.codeApplied', { amount: formatBirr(previewResult.discountAmount) })}</Text>}

              {prizes.length === 1 && !wheelApplied && (
                <View style={styles.wheelPill}>
                  <Text style={styles.wheelPillText}>
                    {t('cart.wheelPillLabel', { amount: formatBirr(Math.min(prizes[0].discountBirr, Math.max(total - 1, 0))) })}
                  </Text>
                  <Button label={t('cart.wheelUse')} variant="outline" onPress={() => applyPrize(prizes[0].id)} style={styles.applyButton} />
                </View>
              )}
              {prizes.length > 1 && !wheelApplied && (
                <View style={styles.wheelPill}>
                  <Text style={styles.wheelPillText}>{t('cart.wheelPillLabelMulti', { n: String(prizes.length) })}</Text>
                  <Button label={t('cart.wheelChoose')} variant="outline" onPress={() => setPrizePickerOpen(true)} style={styles.applyButton} />
                </View>
              )}
              {wheelApplied && <Text style={styles.codeApplied}>{t('cart.wheelApplied', { amount: formatBirr(wheelDiscount) })}</Text>}

              <Button
                label={path === 'wallet' ? t('cart.checkoutWallet', { amount: formatBirr(effectiveTotal) }) : t('cart.checkout')}
                onPress={checkout}
                loading={busy || cart.mutating}
                disabled={!gate.canCheckout || cart.mutating}
              />
            </View>
          )}
        </Column>
      </ScrollView>

      <BottomSheet visible={prizePickerOpen} onClose={() => setPrizePickerOpen(false)} title={t('cart.wheelPickerTitle')}>
        <View style={styles.prizeList}>
          {prizes.map((p) => {
            const capped = Math.min(p.discountBirr, Math.max(total - 1, 0));
            return (
              <Pressable
                key={p.id}
                onPress={() => applyPrize(p.id)}
                style={styles.prizeRow}
                accessibilityRole="button"
                accessibilityLabel={`${p.label}, -${formatBirr(capped)}`}
              >
                <View style={styles.prizeRowText}>
                  <Text style={styles.prizeRowLabel}>{p.label}</Text>
                  <Text style={styles.prizeRowDate}>{t('cart.wheelWonOn', { date: formatDate(p.wonAt) })}</Text>
                </View>
                <Text style={styles.prizeRowAmount}>{`-${formatBirr(capped)}`}</Text>
              </Pressable>
            );
          })}
        </View>
      </BottomSheet>
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
  totalDiscounted: { flexDirection: 'row', alignItems: 'baseline', gap: spacing.sm },
  totalOld: { fontFamily: fonts.semibold, fontSize: 15, color: colors.textFaint, textDecorationLine: 'line-through' },
  totalNew: { fontFamily: fonts.extrabold, fontSize: 24, color: colors.limeInk, letterSpacing: -0.5 },
  codeHint: { fontFamily: fonts.regular, fontSize: 12.5, color: colors.textMuted },
  applyRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  applyButton: { alignSelf: 'flex-start', paddingHorizontal: spacing.lg },
  codeDiscountAmount: { fontFamily: fonts.semibold, fontSize: 13, color: colors.limeInk },
  codeApplied: { fontFamily: fonts.semibold, fontSize: 13, color: colors.limeInk },
  wheelPill: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  wheelPillText: { fontFamily: fonts.semibold, fontSize: 13, color: colors.text },
  prizeList: { gap: spacing.sm },
  prizeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.lg - 4,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  prizeRowText: { flex: 1 },
  prizeRowLabel: { fontFamily: fonts.bold, fontSize: 15, color: colors.text },
  prizeRowDate: { marginTop: 2, fontFamily: fonts.medium, fontSize: 12.5, color: colors.textMuted },
  prizeRowAmount: { fontFamily: fonts.extrabold, fontSize: 16, color: colors.limeInk },
  problems: { gap: 4 },
  problemsTitle: { fontFamily: fonts.bold, fontSize: 13.5, color: colors.danger },
  problemLine: { fontFamily: fonts.medium, fontSize: 13.5, lineHeight: 19, color: colors.danger },
});
