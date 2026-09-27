import { Redirect, router, useLocalSearchParams } from 'expo-router';
import { useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { StateMessage } from '../../components/market/StateMessage';
import { FeatherIcon } from '../../components/art/FeatherIcon';
import { GiftDeliveryCard } from '../../components/order/GiftDeliveryCard';
import { ReceiptCard } from '../../components/order/ReceiptCard';
import { Button } from '../../components/ui/Button';
import { ErrorBanner } from '../../components/ui/ErrorBanner';
import { ScreenHeader } from '../../components/ui/ScreenHeader';
import { Column } from '../../components/ui/TabScroll';
import { useAuth } from '../../lib/auth';
import { formatBirr } from '../../lib/catalog';
import { fetchPayOrder } from '../../lib/checkout';
import { useT } from '../../lib/i18n';
import { giftSideOf, receiptAvailable } from '../../lib/orderView';
import { fetchOrder, type Order } from '../../lib/orders';
import { fetchPortalCoinEarned } from '../../lib/portalCoin';
import { shareReceiptImage } from '../../lib/receiptShare';
import { colors, fonts, radius, spacing } from '../../lib/theme';
import { useAsync } from '../../lib/useAsync';

/**
 * The order as a receipt, with a "Download receipt" button that shares it as a picture. A gift the customer received
 * (their delivery order) is shown as a gift instead: no price, no receipt (see lib/orderView giftSideOf).
 */
export default function OrderDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { user, session, initializing } = useAuth();
  const t = useT();
  const insets = useSafeAreaInsets();
  const userId = user?.id;
  const receiptRef = useRef<View>(null);
  const [sharing, setSharing] = useState(false);
  const [shareError, setShareError] = useState<string | null>(null);

  // Wait for the signed-in user: with no user yet this used to resolve to "nothing" and never reload.
  const order = useAsync(
    () => (userId ? fetchOrder(userId, id) : Promise.resolve(null)),
    id ?? '',
    !initializing && !!userId && !!id
  );
  // The lines of a cart order (each with its own game ID). Older single-item orders have none, and the receipt shows their one line.
  const lines = useAsync(
    () => (userId ? fetchPayOrder(userId, id).then((o) => o?.items ?? null) : Promise.resolve(null)),
    id ?? '',
    !initializing && !!userId && !!id
  );

  const completed = order.data?.status === 'completed';
  const coinsEarned = useAsync(() => (completed ? fetchPortalCoinEarned(id) : Promise.resolve(null)), id ?? '', completed);

  if (!initializing && !session) return <Redirect href="/sign-in" />;

  const data = order.data;
  // The receipt is the buyer's: a gift the customer RECEIVED is shown as a gift, with no price and no download.
  const giftSide = data ? giftSideOf(data) : null;
  const canDownload = data !== null && giftSide !== 'delivery' && receiptAvailable(data.status);

  async function download() {
    if (sharing) return;
    setSharing(true);
    setShareError(null);
    try {
      const result = await shareReceiptImage(receiptRef, t('receipt.shareTitle'));
      if (result === 'unavailable') setShareError(t('receipt.unavailable'));
    } catch {
      setShareError(t('receipt.failed'));
    } finally {
      setSharing(false);
    }
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + spacing.xl }} showsVerticalScrollIndicator={false}>
        <Column>
          <ScreenHeader title={t(giftSide === 'delivery' ? 'order.gift.title' : 'receipt.title')} />

          {order.status === 'loading' && !data && <ActivityIndicator style={styles.loading} color={colors.limeDeep} />}

          {order.status !== 'loading' && !data && (
            <StateMessage
              icon={<FeatherIcon name="file-text" size={30} color={colors.limeInk} />}
              title={t('orders.detail')}
              body={t('common.loadError')}
              actionLabel={t('common.retry')}
              onAction={order.reload}
            />
          )}

          {data && (
            <>
              {/* What the status means, in words. Kept OUT of the receipt picture: it is guidance, not part of the record. */}
              <View style={styles.noteCard}>
                <Text style={styles.note}>{noteFor(data, t)}</Text>
              </View>

              {giftSide === 'delivery' ? (
                <GiftDeliveryCard order={data} t={t} />
              ) : (
                <ReceiptCard ref={receiptRef} order={data} items={lines.data} t={t} />
              )}

              {coinsEarned.data !== null && coinsEarned.data > 0 && (
                <View style={styles.coinBadge}>
                  <FeatherIcon name="star" size={14} color={colors.limeDark} />
                  <Text style={styles.coinText}>{t('portalCoin.earned', { n: String(coinsEarned.data) })}</Text>
                </View>
              )}

              {canDownload ? (
                <Button label={t('receipt.download')} onPress={download} loading={sharing} style={styles.cta} />
              ) : giftSide !== 'delivery' ? (
                <Text style={styles.notYet}>{t('receipt.notYet')}</Text>
              ) : null}
              {shareError && <ErrorBanner message={shareError} />}

              {data.status === 'pending_payment' && (
                <Button label={t('pay.title')} variant="outline" onPress={() => router.push({ pathname: '/pay/[id]', params: { id: data.id } })} style={styles.cta} />
              )}

              {data.fulfillment === 'code' && data.status === 'completed' && (
                <Button label={t('order.viewVault')} variant="outline" onPress={() => router.navigate('/vault')} style={styles.cta} />
              )}
            </>
          )}
        </Column>
      </ScrollView>
    </SafeAreaView>
  );
}

function noteFor(order: Order, t: ReturnType<typeof useT>) {
  const amount = formatBirr(order.amount);
  // The buyer's paid gift order never moves past 'paid' (it only backs the gift): say what happens next instead.
  if (order.status === 'paid' && order.gift_kind) return t(order.gift_kind === 'gift' ? 'order.gift.buyerGift' : 'order.gift.buyerCode');
  switch (order.status) {
    case 'pending':
      return t('order.note.pending');
    case 'processing':
      return t('order.note.processing');
    case 'completed':
      return order.fulfillment === 'code' ? t('order.note.completedCode') : t('order.note.completedTopup');
    case 'failed':
      return t('order.note.failed', { amount });
    case 'refunded':
      return t('order.note.refunded', { amount });
    case 'pending_payment':
      return t('order.note.pending_payment');
    case 'paid':
      return t('order.note.paid');
    case 'payment_mismatch':
      return t('order.note.payment_mismatch');
    case 'cancelled':
      return t('order.note.cancelled');
  }
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  loading: { marginTop: spacing.xxl },
  noteCard: { padding: spacing.md, borderRadius: radius.lg - 4, backgroundColor: colors.bgTint, marginBottom: spacing.md },
  note: { fontFamily: fonts.medium, fontSize: 14.5, lineHeight: 21, color: colors.text },
  cta: { marginTop: spacing.md },
  coinBadge: { flexDirection: 'row', alignSelf: 'center', alignItems: 'center', gap: 6, marginTop: spacing.sm, paddingHorizontal: spacing.sm + 2, paddingVertical: 6, borderRadius: radius.pill, backgroundColor: colors.limeSoft },
  coinText: { fontFamily: fonts.bold, fontSize: 13, color: colors.limeDark },
  notYet: { marginTop: spacing.md, textAlign: 'center', fontFamily: fonts.medium, fontSize: 13.5, lineHeight: 20, color: colors.textMuted },
});
