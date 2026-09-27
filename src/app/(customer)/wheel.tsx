import { Redirect } from 'expo-router';
import { useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { FeatherIcon } from '../../components/art/FeatherIcon';
import { StateMessage } from '../../components/market/StateMessage';
import { Button } from '../../components/ui/Button';
import { BottomSheet } from '../../components/ui/BottomSheet';
import { ErrorBanner } from '../../components/ui/ErrorBanner';
import { ScreenHeader } from '../../components/ui/ScreenHeader';
import { Column } from '../../components/ui/TabScroll';
import { BuySpinRow } from '../../components/wheel/BuySpinRow';
import { ConfettiBurst } from '../../components/wheel/ConfettiBurst';
import { PrizeWheel, type PrizeWheelHandle } from '../../components/wheel/PrizeWheel';
import { SpinButton } from '../../components/wheel/SpinButton';
import { useAuth } from '../../lib/auth';
import { formatBirr } from '../../lib/catalog';
import { useT } from '../../lib/i18n';
import { colors, fonts, spacing, wheel as W } from '../../lib/theme';
import { useToast } from '../../lib/toast';
import { useAsync, useRefreshOnFocus } from '../../lib/useAsync';
import {
  buySpinPackage,
  fetchActiveSpinPackages,
  fetchActiveWheelPrizes,
  fetchSpinCredits,
  spinWheel,
  wheelErrorText,
  type SpinResult,
} from '../../lib/wheel';

/** Buy spins with Portal Coins, then spin: the prize is chosen server-side, before the wheel ever moves -- see
 * spinWheel()'s own doc comment. */
export default function WheelScreen() {
  const { user, session, initializing } = useAuth();
  const t = useT();
  const toast = useToast();
  const insets = useSafeAreaInsets();
  const userId = user?.id;
  const wheelRef = useRef<PrizeWheelHandle>(null);

  const prizes = useAsync(fetchActiveWheelPrizes, 0, !initializing && !!userId);
  const credits = useAsync(() => (userId ? fetchSpinCredits(userId) : Promise.resolve(0)), userId ?? '', !initializing && !!userId);
  const packages = useAsync(fetchActiveSpinPackages, 0, !initializing && !!userId);

  const [spinning, setSpinning] = useState(false);
  const [buyingId, setBuyingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SpinResult | null>(null);
  // 0 = no burst yet. Bumped right when the wheel actually settles on the prize (see spin()'s onDone), so the
  // confetti is timed to the landing moment, never to the request finishing.
  const [confettiKey, setConfettiKey] = useState(0);

  useRefreshOnFocus(() => {
    credits.reload();
  });

  if (!initializing && !session) return <Redirect href="/sign-in" />;

  const slices = (prizes.data ?? []).map((p) => ({ id: p.id, label: p.label, weight: p.weight, discountBirr: p.discountBirr }));
  const canSpin = !spinning && (credits.data ?? 0) > 0 && slices.length > 0;

  async function spin() {
    if (!canSpin || spinning) return;
    setSpinning(true);
    setError(null);
    try {
      const won = await spinWheel();
      // The wheel only PLAYS the already-decided result; it does not choose it. onDone fires after the wheel has
      // settled AND the winning slice's own highlight has finished (see PrizeWheel) -- the confetti and the result
      // modal both land at that same, single "here's what you won" moment, not the instant the network call returns.
      wheelRef.current?.spinTo({ prizeId: won.prizeId, index: won.index }, () => {
        setConfettiKey((k) => k + 1);
        setResult(won);
        setSpinning(false);
      });
      await credits.reload();
    } catch (err) {
      setError(wheelErrorText(err));
      setSpinning(false);
    }
  }

  async function buy(packageId: string) {
    if (buyingId) return;
    setBuyingId(packageId);
    setError(null);
    try {
      const bought = await buySpinPackage(packageId);
      await credits.reload();
      toast(t('wheel.boughtSpins', { n: String(bought.spinsBought) }));
    } catch (err) {
      setError(wheelErrorText(err));
    } finally {
      setBuyingId(null);
    }
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + spacing.xxl }} showsVerticalScrollIndicator={false}>
        <Column>
          <ScreenHeader title={t('wheel.title')} />
          <Text style={styles.lead}>{t('wheel.lead')}</Text>

          {prizes.status === 'loading' && !prizes.data && <ActivityIndicator style={styles.loading} color={colors.limeDeep} />}
          {prizes.status === 'error' && !prizes.data && (
            <StateMessage
              tone="danger"
              icon={<FeatherIcon name="alert-triangle" size={30} color={colors.danger} />}
              title={t('wheel.title')}
              body={t('common.loadError')}
              actionLabel={t('common.retry')}
              onAction={prizes.reload}
            />
          )}
          {prizes.status === 'ready' && slices.length === 0 && (
            <StateMessage
              icon={<FeatherIcon name="gift" size={30} color={colors.limeInk} />}
              title={t('wheel.emptyTitle')}
              body={t('wheel.emptyBody')}
              actionLabel={t('common.retry')}
              onAction={prizes.reload}
            />
          )}

          {slices.length > 0 && (
            <>
              {/* Straight on the page, no card: the wheel's own halo and shadow set it apart. The vertical room is for
                  that halo (it reaches past the disc), so it never runs into the text above or the button below. */}
              <View style={styles.wheelWrap}>
                <PrizeWheel ref={wheelRef} slices={slices} size={280} hubLabel={t('wheel.spin')} />
                <ConfettiBurst burstKey={confettiKey} />
              </View>

              <Text style={styles.creditsText}>{t('wheel.creditsLeft', { n: String(credits.data ?? 0) })}</Text>

              <View style={styles.spinButton}>
                <SpinButton label={spinning ? t('wheel.spinning') : t('wheel.spin')} onPress={spin} loading={spinning} disabled={!canSpin} />
              </View>
              {!spinning && (credits.data ?? 0) === 0 && <Text style={styles.hint}>{t('wheel.needCredits')}</Text>}

              {error && <ErrorBanner message={error} />}
            </>
          )}

          <Text style={styles.section}>{t('wheel.buySpins')}</Text>
          {packages.status === 'loading' && !packages.data && <ActivityIndicator style={styles.loading} color={colors.limeDeep} />}
          {packages.status === 'error' && !packages.data && (
            <>
              <ErrorBanner message={t('common.loadError')} />
              <Button label={t('common.retry')} variant="outline" onPress={packages.reload} style={styles.retryButton} />
            </>
          )}
          {packages.status === 'ready' && (packages.data ?? []).length === 0 && <Text style={styles.hint}>{t('wheel.noPackages')}</Text>}
          <View style={styles.packageList}>
            {(packages.data ?? []).map((pkg) => (
              <BuySpinRow
                key={pkg.id}
                spins={pkg.spinsCount}
                label={t('wheel.spinsCount', { n: String(pkg.spinsCount) })}
                priceLabel={t('wheel.buyFor', { n: String(pkg.portalCoinCost) })}
                onPress={() => buy(pkg.id)}
                loading={buyingId === pkg.id}
                disabled={!!buyingId}
              />
            ))}
          </View>
        </Column>
      </ScrollView>

      <BottomSheet visible={result !== null} onClose={() => setResult(null)} title={t('wheel.wonTitle')}>
        {result && (
          <View style={styles.resultBody}>
            <FeatherIcon name="gift" size={36} color={colors.limeDark} />
            <Text style={styles.resultLabel}>{result.label}</Text>
            <Text style={styles.resultAmount}>{t('wheel.wonAmount', { amount: formatBirr(result.discountBirr) })}</Text>
            <Text style={styles.resultHint}>{t('wheel.wonHint')}</Text>
            <Button label={t('wheel.wonButton')} onPress={() => setResult(null)} style={styles.resultButton} />
          </View>
        )}
      </BottomSheet>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  loading: { marginTop: spacing.xl },
  lead: { marginBottom: spacing.md, fontFamily: fonts.medium, fontSize: 14, lineHeight: 20, color: colors.textMuted },
  // The halo reaches ~63pt past the 280pt disc on every side; this padding is that room.
  wheelWrap: { alignItems: 'center', paddingTop: spacing.xxl + 12, paddingBottom: spacing.xxl },
  creditsText: { textAlign: 'center', fontFamily: fonts.bold, fontSize: 14.5, color: W.ink, marginBottom: spacing.md - 4 },
  spinButton: { marginBottom: spacing.sm },
  hint: { textAlign: 'center', fontFamily: fonts.medium, fontSize: 13, color: colors.textMuted },
  retryButton: { marginBottom: spacing.md },
  section: { marginTop: spacing.xl, marginBottom: spacing.sm + 4, fontFamily: fonts.extrabold, fontSize: 18, color: W.ink, letterSpacing: -0.4 },
  packageList: { gap: spacing.sm + 2 },
  resultBody: { alignItems: 'center', gap: spacing.xs, paddingBottom: spacing.lg },
  resultLabel: { fontFamily: fonts.bold, fontSize: 16, color: colors.text, textAlign: 'center' },
  resultAmount: { fontFamily: fonts.extrabold, fontSize: 30, color: colors.limeDark, letterSpacing: -0.5 },
  resultHint: { fontFamily: fonts.regular, fontSize: 13, color: colors.textMuted, textAlign: 'center', marginBottom: spacing.sm },
  resultButton: { minWidth: 160 },
});
