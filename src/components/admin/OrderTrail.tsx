import * as Clipboard from 'expo-clipboard';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { fetchPaymentAttempts, type QueueOrder } from '../../lib/admin';
import { formatBirr } from '../../lib/catalog';
import { formatDateTime } from '../../lib/format';
import { attemptText, fulfilmentOf, paymentMethodOf, shortOrderId } from '../../lib/orderView';
import { colors, fonts, radius, spacing } from '../../lib/theme';
import { useToast } from '../../lib/toast';
import { useAsync } from '../../lib/useAsync';
import { FeatherIcon } from '../art/FeatherIcon';

const METHOD: Record<string, string> = { telebirr: 'Telebirr', cbe: 'CBE', wallet: 'Wallet' };

/**
 * An order's whole trail for the admin, in two parts that always appear in this order:
 *   1. PAYMENT: how it was paid, the reference, what the provider verified (and whether it was the TEST key), and every
 *      verification attempt with what ShegerPay said.
 *   2. DELIVERY: the fulfilment steps. This is the slot for fulfilment: while an order is only "paid" there is no delivery status
 *      to show and it says so; once fulfilment exists, fulfilmentOf() returns real steps and nothing here has to be redesigned.
 */
export function OrderTrail({ order }: { order: QueueOrder }) {
  const toast = useToast();
  const attempts = useAsync(() => fetchPaymentAttempts(order.id), order.id);
  const method = paymentMethodOf(order);
  const fulfilment = fulfilmentOf(order.status);
  const isBank = method === 'telebirr' || method === 'cbe';

  async function copy(text: string, what: string) {
    await Clipboard.setStringAsync(text);
    toast(`${what} copied`);
  }

  return (
    <View style={styles.wrap}>
      <View style={styles.card}>
        <Text style={styles.title}>Order</Text>
        <Line label="Order ID" value={order.id} selectable onCopy={() => copy(order.id, 'Order ID')} />
        <Line label="Short ID" value={shortOrderId(order.id)} />
      </View>

      <View style={styles.card}>
        <Text style={styles.title}>Payment</Text>
        <Line label="Method" value={method ? (METHOD[method] ?? method) : 'Not paid yet'} />
        <Line label="Order total" value={formatBirr(order.amount)} />
        {order.payment_verified_amount !== null && order.payment_verified_amount !== undefined ? (
          <Line label="Verified amount" value={formatBirr(Number(order.payment_verified_amount))} />
        ) : null}
        {order.payment_reference ? <Line label="Reference" value={order.payment_reference} selectable onCopy={() => copy(order.payment_reference as string, 'Reference')} /> : null}
        {order.paid_at ? <Line label="Paid at" value={formatDateTime(order.paid_at)} /> : null}
        {order.payment_mode ? <Line label="Mode" value={order.payment_mode === 'test' ? 'TEST key (no real money)' : order.payment_mode === 'wallet' ? 'Wallet (no bank)' : 'Live'} warn={order.payment_mode === 'test'} /> : null}

        {isBank || (attempts.data ?? []).length > 0 ? (
          <View style={styles.attempts}>
            <Text style={styles.subTitle}>Verification attempts</Text>
            {attempts.status === 'loading' && !attempts.data ? <Text style={styles.muted}>Loading…</Text> : null}
            {attempts.status === 'error' && !attempts.data ? <Text style={styles.muted}>Couldn&apos;t load the attempts.</Text> : null}
            {attempts.data && attempts.data.length === 0 ? <Text style={styles.muted}>No verification was tried yet.</Text> : null}
            {(attempts.data ?? []).map((a) => (
              <View key={a.id} style={styles.attempt}>
                <Text style={styles.attemptWhen}>{formatDateTime(a.created_at)}</Text>
                <Text style={styles.attemptText}>{attemptText(a)}</Text>
                <Text style={styles.attemptRef} selectable>
                  {METHOD[a.provider] ?? a.provider} · {a.reference}
                </Text>
              </View>
            ))}
          </View>
        ) : null}
      </View>

      <View style={styles.card}>
        <Text style={styles.title}>Delivery</Text>
        {fulfilment.tracked ? (
          <View style={styles.steps}>
            {fulfilment.steps.map((step) => (
              <View key={step.key} style={styles.step}>
                <View style={[styles.dot, step.state === 'done' && styles.dotDone, step.state === 'current' && styles.dotCurrent]}>
                  {step.state === 'done' && <FeatherIcon name="check" size={11} color="#FFFFFF" strokeWidth={3.4} />}
                </View>
                <Text style={[styles.stepText, step.state === 'todo' && styles.stepTodo]}>{step.label}</Text>
              </View>
            ))}
          </View>
        ) : (
          <Text style={styles.muted}>
            No delivery status yet. Fulfilment for paid orders isn&apos;t built, so a paid order stays &ldquo;paid&rdquo; until it is. Its delivery steps will show here.
          </Text>
        )}
      </View>
    </View>
  );
}

function Line({ label, value, selectable, onCopy, warn }: { label: string; value: string; selectable?: boolean; onCopy?: () => void; warn?: boolean }) {
  return (
    <View style={styles.line}>
      <Text style={styles.label}>{label}</Text>
      <View style={styles.valueBox}>
        <Text style={[styles.value, warn && styles.warn]} selectable={selectable}>
          {value}
        </Text>
        {onCopy ? (
          <Pressable onPress={onCopy} hitSlop={8} accessibilityRole="button" accessibilityLabel={`Copy ${label}`} style={styles.copy}>
            <FeatherIcon name="copy" size={15} color={colors.limeDark} />
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: spacing.sm + 2, marginTop: spacing.sm },
  card: { padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, gap: spacing.sm },
  title: { fontFamily: fonts.bold, fontSize: 12, letterSpacing: 1, color: colors.textMuted, textTransform: 'uppercase' },
  subTitle: { fontFamily: fonts.bold, fontSize: 13, color: colors.text },
  line: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: spacing.md },
  label: { fontFamily: fonts.regular, fontSize: 13.5, color: colors.textMuted },
  valueBox: { flexShrink: 1, flexDirection: 'row', alignItems: 'center', gap: 6 },
  value: { flexShrink: 1, fontFamily: fonts.semibold, fontSize: 13.5, color: colors.text, textAlign: 'right' },
  warn: { color: '#8A5A00' },
  copy: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.limeSoft },
  attempts: { marginTop: spacing.xs, gap: spacing.sm },
  attempt: { paddingVertical: spacing.sm, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, gap: 2 },
  attemptWhen: { fontFamily: fonts.regular, fontSize: 12, color: colors.textMuted },
  attemptText: { fontFamily: fonts.semibold, fontSize: 13.5, color: colors.text },
  attemptRef: { fontFamily: fonts.regular, fontSize: 12, color: colors.textMuted },
  muted: { fontFamily: fonts.regular, fontSize: 13, lineHeight: 19, color: colors.textMuted },
  steps: { gap: spacing.sm },
  step: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  dot: { width: 20, height: 20, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.border },
  dotDone: { backgroundColor: colors.limeDeep },
  dotCurrent: { backgroundColor: '#F2B233' },
  stepText: { fontFamily: fonts.semibold, fontSize: 14, color: colors.text },
  stepTodo: { color: colors.textFaint },
});
