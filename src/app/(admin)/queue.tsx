import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { OrderSheet } from '../../components/admin/OrderSheet';
import { FeatherIcon } from '../../components/art/FeatherIcon';
import { AlertIcon } from '../../components/art/Icons';
import { SearchBar } from '../../components/market/SearchBar';
import { StateMessage } from '../../components/market/StateMessage';
import { Chips, type ChipOption } from '../../components/ui/Chips';
import { STATUS_LABELS_EN, StatusBadge } from '../../components/ui/StatusBadge';
import { Column, TabScroll } from '../../components/ui/TabScroll';
import { fetchQueue, searchOrders, type QueueFilter, type QueueOrder } from '../../lib/admin';
import { formatBirr } from '../../lib/catalog';
import { shortWait } from '../../lib/format';
import { classifyOrderQuery, giftSideOf } from '../../lib/orderView';
import { usePending } from '../../lib/pending';
import { SEARCH_IDLE_MS } from '../../lib/searchLogic';
import { useDebouncedSearch } from '../../lib/useDebounced';
import { fetchPendingWithdrawalCount } from '../../lib/wallet';
import { colors, fonts, radius, spacing } from '../../lib/theme';
import { useAsync, useRefreshOnFocus } from '../../lib/useAsync';

export default function QueueScreen() {
  const { count: pendingCount, refresh: refreshPending } = usePending();
  const [filter, setFilter] = useState<QueueFilter>('pending');
  const [selected, setSelected] = useState<QueueOrder | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const queue = useAsync(() => fetchQueue(filter), filter);

  // Find any order by its ID (full, or "#1A2B3C4D") or by a payment reference. One request per pause in typing (1.5 s); Enter searches now.
  const [find, setFind] = useState('');
  const finder = useDebouncedSearch(find.trim(), SEARCH_IDLE_MS);
  const searchable = classifyOrderQuery(finder.value) !== null;
  const found = useAsync(() => searchOrders(finder.value), finder.value, searchable);
  const finding = find.trim() !== '';
  const withdrawals = useAsync(fetchPendingWithdrawalCount);
  useRefreshOnFocus(() => {
    queue.reload();
    refreshPending();
    withdrawals.reload();
  });

  const options: ChipOption<QueueFilter>[] = [
    { id: 'pending', label: 'Pending', count: pendingCount },
    { id: 'processing', label: 'Processing' },
    { id: 'done', label: 'Done' },
    { id: 'all', label: 'All' },
  ];

  async function onRefresh() {
    setRefreshing(true);
    refreshPending();
    await queue.reload();
    setRefreshing(false);
  }

  function changed() {
    queue.reload();
    refreshPending();
  }

  const orders = queue.data ?? [];
  const open = filter === 'pending' || filter === 'processing';

  return (
    <TabScroll refreshing={refreshing} onRefresh={onRefresh} stickyHeaderIndices={[1]}>
      <Column>
        <View style={styles.titleRow}>
          <Text style={styles.title}>Queue</Text>
          <Pressable
            onPress={() => router.push('/withdrawals')}
            accessibilityRole="button"
            accessibilityLabel={`Withdrawals, ${withdrawals.data ?? 0} waiting`}
            style={({ pressed }) => [styles.wdLink, (withdrawals.data ?? 0) > 0 && styles.wdLinkOn, pressed && styles.pressed]}
          >
            <FeatherIcon name="credit-card" size={13} color={(withdrawals.data ?? 0) > 0 ? colors.text : colors.textMuted} strokeWidth={2.4} />
            <Text style={[styles.wdText, (withdrawals.data ?? 0) > 0 && styles.wdTextOn]}>
              {(withdrawals.data ?? 0) > 0 ? `Withdrawals · ${withdrawals.data}` : 'Withdrawals'}
            </Text>
          </Pressable>
        </View>
      </Column>

      <View style={styles.sticky}>
        <Column style={styles.chips}>
          <SearchBar value={find} onChangeText={setFind} onSubmit={finder.flush} placeholder="Find an order by ID or reference" />
          {!finding && <Chips options={options} value={filter} onChange={setFilter} />}
        </Column>
      </View>

      {finding && (
        <Column style={styles.list}>
          {finder.pending && <Text style={styles.searchHint}>Searching when you stop typing… (Enter searches now)</Text>}
          {!finder.pending && !searchable && <Text style={styles.searchHint}>Type at least 4 characters of an order ID (like #1A2B3C4D) or a payment reference.</Text>}
          {searchable && !finder.pending && found.status === 'loading' && !found.data && <Text style={styles.searchHint}>Searching…</Text>}
          {searchable && found.status === 'error' && !found.data && <Text style={styles.searchHint}>Couldn&apos;t search. Check your connection and try again.</Text>}
          {searchable && !finder.pending && found.data && found.data.length === 0 && <Text style={styles.searchHint}>No order matches that.</Text>}
          {(found.data ?? []).map((order) => (
            <QueueRow key={order.id} order={order} open={false} onPress={() => setSelected(order)} />
          ))}
        </Column>
      )}

      <Column style={[styles.list, finding && styles.hidden]}>
        {queue.status === 'error' && !queue.data && (
          <StateMessage
            tone="danger"
            icon={<AlertIcon size={30} color={colors.danger} />}
            title="Couldn't load orders"
            body="Check your connection, then try again."
            actionLabel="Try again"
            onAction={queue.reload}
          />
        )}

        {queue.data && orders.length === 0 && (
          <StateMessage
            icon={<FeatherIcon name="check-circle" size={30} color={colors.limeInk} />}
            title={filter === 'pending' ? 'All caught up' : 'Nothing here'}
            body={
              filter === 'pending'
                ? 'No orders are waiting. New ones show up here.'
                : 'No orders match this filter.'
            }
            actionLabel="Refresh"
            actionVariant="outline"
            onAction={queue.reload}
          />
        )}

        {orders.map((order) => (
          <QueueRow key={order.id} order={order} open={open} onPress={() => setSelected(order)} />
        ))}
      </Column>

      <OrderSheet order={selected} onClose={() => setSelected(null)} onChanged={changed} />
    </TabScroll>
  );
}

function QueueRow({
  order,
  open,
  onPress,
}: {
  order: QueueOrder;
  open: boolean;
  onPress: () => void;
}) {
  const isOpen = order.status === 'pending' || order.status === 'processing';
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <View style={styles.rowTop}>
        <Text style={styles.customer} numberOfLines={1}>
          {order.customerName}
        </Text>
        <Text style={styles.wait}>
          {isOpen && open ? `waiting ${shortWait(order.created_at)}` : `${shortWait(order.created_at)} ago`}
        </Text>
      </View>
      <Text style={styles.product} numberOfLines={1}>
        {order.product_name} · {order.option_label}
      </Text>
      <View style={styles.rowBottom}>
        <StatusBadge status={order.status} label={STATUS_LABELS_EN[order.status]} />
        <View style={styles.tags}>
          {order.fulfillment === 'code' && <Text style={styles.tag}>CODE</Text>}
          {giftSideOf(order) === 'delivery' ? <Text style={styles.tag}>GIFT</Text> : <Text style={styles.amount}>{formatBirr(order.amount)}</Text>}
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  searchHint: { fontFamily: fonts.medium, fontSize: 13.5, lineHeight: 20, color: colors.textMuted, marginBottom: spacing.sm },
  hidden: { display: 'none' },
  titleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  wdLink: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 36, paddingHorizontal: 14, borderRadius: 18, justifyContent: 'center', borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  wdLinkOn: { backgroundColor: '#FFF1CC', borderColor: '#F2DFA6' },
  wdText: { fontFamily: fonts.bold, fontSize: 13, color: colors.textMuted },
  wdTextOn: { color: '#8A5A00' },
  title: {
    paddingTop: spacing.md,
    marginBottom: spacing.md,
    fontFamily: fonts.extrabold,
    fontSize: 32,
    color: colors.text,
    letterSpacing: -1,
  },
  sticky: { width: '100%', backgroundColor: colors.bg },
  chips: { paddingBottom: spacing.md },
  list: { gap: spacing.sm + 2, paddingTop: spacing.xs },
  row: {
    padding: spacing.md,
    borderRadius: radius.lg - 4,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    gap: 4,
  },
  pressed: { opacity: 0.8 },
  rowTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.md },
  customer: { flex: 1, fontFamily: fonts.bold, fontSize: 15.5, color: colors.text },
  wait: { fontFamily: fonts.semibold, fontSize: 12.5, color: colors.textMuted },
  product: { fontFamily: fonts.regular, fontSize: 14, color: colors.textMuted },
  rowBottom: {
    marginTop: spacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  tags: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm + 2 },
  tag: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    overflow: 'hidden',
    backgroundColor: colors.primary,
    color: colors.lime,
    fontFamily: fonts.bold,
    fontSize: 10.5,
    letterSpacing: 0.8,
  },
  amount: { fontFamily: fonts.extrabold, fontSize: 15.5, color: colors.text },
});
