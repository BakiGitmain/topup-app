import { StyleSheet, Text, View } from 'react-native';

import { colors, fonts } from '../../lib/theme';
import type { OrderStatus } from '../../lib/orders';

const TONES: Record<OrderStatus, { bg: string; fg: string }> = {
  pending: { bg: '#FFF1CC', fg: '#8A5A00' },
  processing: { bg: '#DCEBFB', fg: '#1F5C99' },
  completed: { bg: colors.limeSoft, fg: colors.limeInk },
  failed: { bg: colors.dangerBg, fg: colors.danger },
  refunded: { bg: '#ECEEE9', fg: '#5C6459' },
  pending_payment: { bg: '#FFF1CC', fg: '#8A5A00' },
  paid: { bg: colors.limeSoft, fg: colors.limeInk },
  payment_mismatch: { bg: colors.dangerBg, fg: colors.danger },
  cancelled: { bg: '#ECEEE9', fg: '#5C6459' },
};

/** Plain-English labels, for the admin screens (customers get translated ones). */
export const STATUS_LABELS_EN: Record<OrderStatus, string> = {
  pending: 'Pending',
  processing: 'Processing',
  completed: 'Completed',
  failed: 'Failed',
  refunded: 'Refunded',
  pending_payment: 'Awaiting payment',
  paid: 'Paid',
  payment_mismatch: 'Payment mismatch',
  cancelled: 'Cancelled',
};

export function StatusBadge({ status, label }: { status: OrderStatus; label: string }) {
  const tone = TONES[status];
  return (
    <View style={[styles.badge, { backgroundColor: tone.bg }]}>
      <View style={[styles.dot, { backgroundColor: tone.fg }]} />
      <Text style={[styles.text, { color: tone.fg }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
  },
  dot: { width: 6, height: 6, borderRadius: 3 },
  text: { fontFamily: fonts.bold, fontSize: 12, lineHeight: 15 },
});
