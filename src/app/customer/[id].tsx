import { Redirect, router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { OrderSheet } from '../../components/admin/OrderSheet';
import { Avatar } from '../../components/market/Avatar';
import { OrderRow } from '../../components/market/OrderRow';
import { StateMessage } from '../../components/market/StateMessage';
import { Button } from '../../components/ui/Button';
import { ErrorBanner } from '../../components/ui/ErrorBanner';
import { ScreenHeader } from '../../components/ui/ScreenHeader';
import { STATUS_LABELS_EN } from '../../components/ui/StatusBadge';
import { Column } from '../../components/ui/TabScroll';
import { TextField } from '../../components/ui/TextField';
import { FeatherIcon } from '../../components/art/FeatherIcon';
import {
  adjustBalance,
  adminErrorMessage,
  fetchCustomer,
  fetchCustomerOrders,
  type QueueOrder,
} from '../../lib/admin';
import { useAuth } from '../../lib/auth';
import { formatBirr } from '../../lib/catalog';
import type { Order } from '../../lib/orders';
import { formatDateTime, parsePrice } from '../../lib/format';
import { usePending } from '../../lib/pending';
import { colors, fonts, radius, spacing } from '../../lib/theme';
import { useToast } from '../../lib/toast';
import { useAsync } from '../../lib/useAsync';

type Mode = 'add' | 'remove';

/** One customer: their balance, a credit form, and their orders. Admin only. */
export default function CustomerDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { session, isAdmin, initializing } = useAuth();
  const { refresh: refreshPending } = usePending();
  const toast = useToast();
  const insets = useSafeAreaInsets();

  const allowed = !initializing && isAdmin && !!id;
  const customer = useAsync(() => fetchCustomer(id), id ?? '', allowed);
  const orders = useAsync(() => fetchCustomerOrders(id), id ?? '', allowed);

  const [mode, setMode] = useState<Mode>('add');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<QueueOrder | null>(null);

  if (!initializing && !session) return <Redirect href="/sign-in" />;
  if (!initializing && !isAdmin) return <Redirect href="/shop" />;

  const person = customer.data;
  const parsed = parsePrice(amount);
  const label = person?.display_name || person?.email || 'Customer';

  async function submit() {
    if (!person || parsed === null) return;
    setError(null);
    setBusy(true);
    try {
      await adjustBalance(person.id, mode === 'add' ? parsed : -parsed, note.trim());
      toast(mode === 'add' ? `Added ${formatBirr(parsed)}` : `Removed ${formatBirr(parsed)}`);
      setAmount('');
      setNote('');
      customer.reload();
    } catch (err) {
      setError(adminErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  function openOrder(order: Order) {
    if (!person) return;
    setSelected({
      ...order,
      user_id: person.id,
      customerName: label,
      customerEmail: person.email ?? '',
    });
  }

  const orderList = orders.data ?? [];

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView
        contentContainerStyle={{ paddingBottom: insets.bottom + spacing.xl }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <Column>
          <ScreenHeader title="Customer" onBack={() => (router.canGoBack() ? router.back() : router.replace('/customers'))} />

          {customer.status === 'loading' && !person && (
            <ActivityIndicator style={styles.loading} color={colors.limeDeep} />
          )}

          {customer.status !== 'loading' && !person && (
            <StateMessage
              icon={<FeatherIcon name="users" size={30} color={colors.limeInk} />}
              title="Customer not found"
              body="They may have been removed."
              actionLabel="Try again"
              onAction={customer.reload}
            />
          )}

          {person && (
            <>
              <View style={styles.identity}>
                <Avatar name={label} size={56} />
                <View style={styles.identityText}>
                  <Text style={styles.name} numberOfLines={1}>
                    {label}
                  </Text>
                  <Text style={styles.email} numberOfLines={1}>
                    {person.email ?? ''}
                  </Text>
                  <Text style={styles.joined}>Joined {formatDateTime(person.created_at)}</Text>
                </View>
              </View>

              <View style={styles.balanceCard}>
                <Text style={styles.balanceLabel}>Balance</Text>
                <Text style={styles.balanceAmount}>{formatBirr(person.balance)}</Text>
              </View>

              {/* Credit / remove balance */}
              <Text style={styles.section}>Change balance</Text>
              <View style={styles.segment}>
                {(['add', 'remove'] as const).map((m) => (
                  <Pressable
                    key={m}
                    onPress={() => setMode(m)}
                    accessibilityRole="button"
                    accessibilityState={{ selected: mode === m }}
                    style={[styles.segmentItem, mode === m && styles.segmentOn]}
                  >
                    <Text style={[styles.segmentText, mode === m && styles.segmentTextOn]}>
                      {m === 'add' ? 'Add money' : 'Remove money'}
                    </Text>
                  </Pressable>
                ))}
              </View>

              <TextField
                label="Amount (Br)"
                value={amount}
                onChangeText={setAmount}
                keyboardType="decimal-pad"
                placeholder="0"
                editable={!busy}
                error={amount.length > 0 && parsed === null ? 'Enter an amount above 0' : null}
              />
              <TextField
                label="Note (only you and the customer see it)"
                value={note}
                onChangeText={setNote}
                placeholder="e.g. Telebirr payment"
                maxLength={120}
                editable={!busy}
              />
              {error ? <ErrorBanner message={error} /> : null}
              <Button
                label={
                  parsed === null
                    ? mode === 'add'
                      ? 'Add money'
                      : 'Remove money'
                    : mode === 'add'
                      ? `Add ${formatBirr(parsed)}`
                      : `Remove ${formatBirr(parsed)}`
                }
                variant={mode === 'add' ? 'solid' : 'dark'}
                onPress={submit}
                loading={busy}
                disabled={parsed === null}
              />

              {/* Orders */}
              <Text style={styles.section}>Orders</Text>
              {orders.data && orderList.length === 0 ? (
                <Text style={styles.empty}>No orders yet.</Text>
              ) : (
                <View style={styles.list}>
                  {orderList.map((order) => (
                    <OrderRow
                      key={order.id}
                      order={order}
                      statusLabel={STATUS_LABELS_EN[order.status]}
                      meta={formatDateTime(order.created_at)}
                      onPress={() => openOrder(order)}
                    />
                  ))}
                </View>
              )}
            </>
          )}
        </Column>
      </ScrollView>

      <OrderSheet
        order={selected}
        onClose={() => setSelected(null)}
        onChanged={() => {
          orders.reload();
          customer.reload();
          refreshPending();
        }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  loading: { marginTop: spacing.xxl },
  identity: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, marginBottom: spacing.md },
  identityText: { flex: 1 },
  name: { fontFamily: fonts.extrabold, fontSize: 22, color: colors.text, letterSpacing: -0.5 },
  email: { marginTop: 1, fontFamily: fonts.regular, fontSize: 14, color: colors.textMuted },
  joined: { marginTop: 2, fontFamily: fonts.regular, fontSize: 12.5, color: colors.textFaint },
  balanceCard: {
    padding: spacing.lg,
    borderRadius: radius.xl - 4,
    backgroundColor: colors.limeSoft,
  },
  balanceLabel: { fontFamily: fonts.medium, fontSize: 13.5, color: '#5E7352' },
  balanceAmount: {
    marginTop: 2,
    fontFamily: fonts.extrabold,
    fontSize: 36,
    lineHeight: 44,
    color: colors.limeDark,
    letterSpacing: -1.2,
  },
  section: {
    marginTop: spacing.lg + 4,
    marginBottom: spacing.sm + 4,
    fontFamily: fonts.extrabold,
    fontSize: 18,
    color: colors.text,
    letterSpacing: -0.4,
  },
  segment: {
    flexDirection: 'row',
    padding: 4,
    borderRadius: 999,
    backgroundColor: colors.surface,
    marginBottom: spacing.md,
  },
  segmentItem: { flex: 1, height: 40, borderRadius: 999, alignItems: 'center', justifyContent: 'center' },
  segmentOn: { backgroundColor: colors.primary },
  segmentText: { fontFamily: fonts.semibold, fontSize: 14, color: colors.textMuted },
  segmentTextOn: { color: colors.primaryText },
  empty: { fontFamily: fonts.regular, fontSize: 14.5, color: colors.textMuted },
  list: { gap: spacing.sm + 2 },
});
