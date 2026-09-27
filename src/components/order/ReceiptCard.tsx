import { forwardRef } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { PayItem } from '../../lib/checkout';
import { formatBirr } from '../../lib/catalog';
import { formatDateTime } from '../../lib/format';
import type { useT } from '../../lib/i18n';
import { paymentMethodOf, shortOrderId, verificationOf } from '../../lib/orderView';
import type { Order } from '../../lib/orders';
import { describeFields } from '../../lib/productView';
import { colors, fonts, radius, spacing } from '../../lib/theme';
import { StatusBadge } from '../ui/StatusBadge';

type Props = { order: Order; items: readonly PayItem[] | null; t: ReturnType<typeof useT> };

/**
 * The order as a receipt: brand and "Receipt" on top, the amount in big type, then labelled rows in a fixed order (what, when, how
 * it was paid, which game account, order number). It is drawn on a solid white card so the picture that "Download receipt"
 * captures is exactly this view, readable anywhere it is shared. The order of the rows is the same for every kind of order,
 * and the last block (`trail`) is where a delivery status will go once fulfilment exists.
 */
export const ReceiptCard = forwardRef<View, Props>(function ReceiptCard({ order, items, t }, ref) {
  const method = paymentMethodOf(order);
  const verification = verificationOf(order);
  const fields = describeFields(order.delivery);
  const methodName = method === 'wallet' ? t('receipt.wallet') : method === 'telebirr' ? t('pay.telebirr') : method === 'cbe' ? t('pay.cbe') : null;

  return (
    // collapsable={false}: Android must not optimise this view away, or there is nothing to capture.
    <View ref={ref} collapsable={false} style={styles.card}>
      <View style={styles.top}>
        <Text style={styles.brand} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8}>
          Portal Topup<Text style={styles.brandDot}>.</Text>
        </Text>
        <Text style={styles.kind}>{t('receipt.title')}</Text>
      </View>

      <View style={styles.hero}>
        <StatusBadge status={order.status} label={t(`status.${order.status}`)} />
        <Text style={styles.amount} accessibilityLabel={`${t('order.amount')} ${formatBirr(order.amount)}`}>
          {formatBirr(order.amount)}
        </Text>
        <Text style={styles.when}>{formatDateTime(order.paid_at ?? order.created_at)}</Text>
      </View>

      <View style={styles.rule} />

      {/* What was bought */}
      {items && items.length > 0 ? (
        <View style={styles.block}>
          <Text style={styles.blockTitle}>{t('order.items')}</Text>
          {items.map((item) => (
            <View key={item.id} style={styles.itemRow}>
              <View style={styles.itemText}>
                <Text style={styles.itemName}>
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
              <Text style={styles.itemPrice}>{formatBirr(item.lineTotal)}</Text>
            </View>
          ))}
        </View>
      ) : (
        <View style={styles.block}>
          <Line label={t('order.item')} value={`${order.product_name} · ${order.option_label}`} />
          {order.region_label ? <Line label={t('order.region')} value={order.region_label} /> : null}
          {fields.map(([label, value]) => (
            <Line key={label} label={fields.length === 1 ? t('order.gameId') : label} value={value} />
          ))}
          {verification.kind === 'validated' && verification.playerName ? <Line label={t('product.player')} value={verification.playerName} /> : null}
        </View>
      )}

      <View style={styles.rule} />

      {/* How it was paid */}
      <View style={styles.block}>
        <Line label={t('order.placed')} value={formatDateTime(order.created_at)} />
        {order.paid_at ? <Line label={t('receipt.paidOn')} value={formatDateTime(order.paid_at)} /> : null}
        {methodName ? <Line label={t('receipt.paymentMethod')} value={methodName} /> : null}
        {order.payment_reference ? <Line label={t('receipt.reference')} value={order.payment_reference} mono /> : null}
        <Line label={t('order.number')} value={shortOrderId(order.id)} strong />
      </View>

      <View style={styles.foot}>
        <Text style={styles.thanks}>{t('receipt.thanks')}</Text>
        <Text style={styles.fullId} selectable>
          {order.id}
        </Text>
      </View>
    </View>
  );
});

function Line({ label, value, mono, strong }: { label: string; value: string; mono?: boolean; strong?: boolean }) {
  return (
    <View style={styles.line}>
      <Text style={styles.lineLabel}>{label}</Text>
      <Text style={[styles.lineValue, mono && styles.mono, strong && styles.strong]} selectable>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    padding: spacing.lg,
    borderRadius: radius.lg,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: colors.border,
  },
  top: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' },
  brand: { flexShrink: 1, fontFamily: fonts.extrabold, fontSize: 22, color: colors.text, letterSpacing: -0.5 },
  brandDot: { color: colors.limeDeep },
  kind: { fontFamily: fonts.bold, fontSize: 13, letterSpacing: 1.2, color: colors.textMuted, textTransform: 'uppercase' },
  hero: { alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.lg },
  amount: { fontFamily: fonts.extrabold, fontSize: 38, color: colors.text, letterSpacing: -1 },
  when: { fontFamily: fonts.medium, fontSize: 13, color: colors.textMuted },
  rule: { height: 1, backgroundColor: colors.border },
  block: { paddingVertical: spacing.md, gap: spacing.sm + 2 },
  blockTitle: { fontFamily: fonts.bold, fontSize: 12, letterSpacing: 1, color: colors.textMuted, textTransform: 'uppercase' },
  itemRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  itemText: { flex: 1, minWidth: 0 },
  itemName: { fontFamily: fonts.semibold, fontSize: 14.5, lineHeight: 20, color: colors.text },
  itemId: { marginTop: 2, fontFamily: fonts.regular, fontSize: 12.5, color: colors.textMuted },
  itemPrice: { fontFamily: fonts.bold, fontSize: 14.5, color: colors.text },
  line: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: spacing.md },
  lineLabel: { fontFamily: fonts.regular, fontSize: 13.5, color: colors.textMuted },
  lineValue: { flexShrink: 1, fontFamily: fonts.semibold, fontSize: 14, lineHeight: 19, color: colors.text, textAlign: 'right' },
  mono: { letterSpacing: 0.4 },
  strong: { fontFamily: fonts.extrabold, letterSpacing: 0.6 },
  foot: { alignItems: 'center', gap: 4, paddingTop: spacing.md, borderTopWidth: 1, borderTopColor: colors.border },
  thanks: { fontFamily: fonts.medium, fontSize: 13, color: colors.textMuted },
  fullId: { fontFamily: fonts.regular, fontSize: 10.5, color: colors.textFaint },
});
