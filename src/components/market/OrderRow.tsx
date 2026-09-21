import { Pressable, StyleSheet, Text, View } from 'react-native';

import { formatBirr } from '../../lib/catalog';
import type { Order } from '../../lib/orders';
import { colors, fonts, radius, spacing } from '../../lib/theme';
import { FeatherIcon } from '../art/FeatherIcon';
import { StatusBadge } from '../ui/StatusBadge';

type Props = {
  order: Order;
  statusLabel: string;
  /** Second line under the item, e.g. a date or how long it has been waiting. */
  meta: string;
  onPress: () => void;
};

/** One order in a list. Shared by the customer's Orders tab and the admin's customer page. */
export function OrderRow({ order, statusLabel, meta, onPress }: Props) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${order.product_name}, ${order.option_label}, ${statusLabel}`}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <View style={styles.icon}>
        <FeatherIcon
          name={order.fulfillment === 'code' ? 'gift' : 'zap'}
          size={20}
          color={colors.limeDark}
        />
      </View>

      <View style={styles.text}>
        <Text style={styles.name} numberOfLines={1}>
          {order.product_name}
        </Text>
        <Text style={styles.option} numberOfLines={1}>
          {order.option_label}
        </Text>
        <Text style={styles.meta}>{meta}</Text>
      </View>

      <View style={styles.right}>
        <Text style={styles.amount}>{formatBirr(order.amount)}</Text>
        <StatusBadge status={order.status} label={statusLabel} />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md - 2,
    padding: spacing.md - 2,
    borderRadius: radius.lg - 4,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  pressed: { opacity: 0.8 },
  icon: {
    width: 44,
    height: 44,
    borderRadius: 14,
    backgroundColor: colors.limeSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  text: { flex: 1 },
  name: { fontFamily: fonts.bold, fontSize: 15, color: colors.text },
  option: { marginTop: 1, fontFamily: fonts.regular, fontSize: 13, color: colors.textMuted },
  meta: { marginTop: 3, fontFamily: fonts.regular, fontSize: 12, color: colors.textFaint },
  right: { alignItems: 'flex-end', gap: 6 },
  amount: { fontFamily: fonts.extrabold, fontSize: 14.5, color: colors.text },
});
