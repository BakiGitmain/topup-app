import { StyleSheet, Text, View } from 'react-native';

import type { useT } from '../../lib/i18n';
import type { Order } from '../../lib/orders';
import { colors, fonts, radius, spacing } from '../../lib/theme';
import { FeatherIcon } from '../art/FeatherIcon';
import { StatusBadge } from '../ui/StatusBadge';

/**
 * The recipient's view of a gift they claimed: what it is, where it went, where it stands. Deliberately NOT a
 * receipt -- no price, no payment, no download: the receipt belongs to the buyer (lib/orderView giftSideOf).
 */
export function GiftDeliveryCard({ order, t }: { order: Order; t: ReturnType<typeof useT> }) {
  const account = typeof order.delivery?.account_id === 'string' ? order.delivery.account_id : null;
  return (
    <View style={styles.card} accessibilityLabel={`${t('order.gift.from')}. ${order.product_name} ${order.option_label}. ${t(`status.${order.status}`)}`}>
      <View style={styles.head}>
        <View style={styles.icon}>
          <FeatherIcon name="gift" size={20} color={colors.limeDark} />
        </View>
        <Text style={styles.from}>{t('order.gift.from')}</Text>
        <StatusBadge status={order.status} label={t(`status.${order.status}`)} />
      </View>
      <Text style={styles.name}>{order.product_name}</Text>
      <Text style={styles.pack}>{order.region_label ? `${order.option_label} · ${order.region_label}` : order.option_label}</Text>
      {account ? (
        <View style={styles.line}>
          <Text style={styles.label}>{t('order.gift.deliveredTo')}</Text>
          <Text style={styles.value} numberOfLines={1}>
            {account}
          </Text>
        </View>
      ) : null}
      <Text style={styles.noReceipt}>{t('order.gift.noReceipt')}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { padding: spacing.md, borderRadius: radius.xl, backgroundColor: colors.surface, borderWidth: 1.5, borderColor: colors.limeSoft },
  head: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  icon: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.limeSoft },
  from: { flex: 1, fontFamily: fonts.medium, fontSize: 13.5, color: colors.limeDark },
  name: { marginTop: spacing.md, fontFamily: fonts.extrabold, fontSize: 22, color: colors.text },
  pack: { marginTop: 2, fontFamily: fonts.medium, fontSize: 15, color: colors.textMuted },
  line: { marginTop: spacing.md, flexDirection: 'row', justifyContent: 'space-between', gap: spacing.md },
  label: { fontFamily: fonts.regular, fontSize: 13.5, color: colors.textMuted },
  value: { flexShrink: 1, fontFamily: fonts.bold, fontSize: 13.5, color: colors.text },
  noReceipt: { marginTop: spacing.md, fontFamily: fonts.regular, fontSize: 12.5, lineHeight: 18, color: colors.textFaint },
});
