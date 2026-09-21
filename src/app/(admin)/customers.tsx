import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { FeatherIcon } from '../../components/art/FeatherIcon';
import { AlertIcon } from '../../components/art/Icons';
import { Avatar } from '../../components/market/Avatar';
import { SearchBar } from '../../components/market/SearchBar';
import { StateMessage } from '../../components/market/StateMessage';
import { Column, TabScroll } from '../../components/ui/TabScroll';
import { searchCustomers, type Customer } from '../../lib/admin';
import { formatBirr } from '../../lib/catalog';
import { colors, fonts, radius, spacing } from '../../lib/theme';
import { SEARCH_IDLE_MS } from '../../lib/searchLogic';
import { useAsync, useRefreshOnFocus } from '../../lib/useAsync';
import { useDebouncedSearch } from '../../lib/useDebounced';


export default function CustomersScreen() {
  const [text, setText] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  // One request per pause in typing (1.5 s), not one per key. Enter searches at once; clearing the box shows everyone at once.
  const search = useDebouncedSearch(text.trim(), SEARCH_IDLE_MS);
  const query = search.value;

  const customers = useAsync(() => searchCustomers(query), query);
  useRefreshOnFocus(customers.reload);

  async function onRefresh() {
    setRefreshing(true);
    await customers.reload();
    setRefreshing(false);
  }

  const list = customers.data ?? [];

  return (
    <TabScroll refreshing={refreshing} onRefresh={onRefresh} stickyHeaderIndices={[1]}>
      <Column>
        <Text style={styles.title}>Customers</Text>
      </Column>

      <View style={styles.sticky}>
        <Column style={styles.searchWrap}>
          <SearchBar value={text} onChangeText={setText} onSubmit={search.flush} placeholder="Search by email or name" />
        </Column>
      </View>

      <Column style={styles.list}>
        {customers.status === 'error' && !customers.data && (
          <StateMessage
            tone="danger"
            icon={<AlertIcon size={30} color={colors.danger} />}
            title="Couldn't load customers"
            body="Check your connection, then try again."
            actionLabel="Try again"
            onAction={customers.reload}
          />
        )}

        {customers.data && list.length === 0 && (
          <StateMessage
            icon={<FeatherIcon name="users" size={30} color={colors.limeInk} />}
            title={query ? 'No matches' : 'No customers yet'}
            body={query ? 'Check the spelling of the email.' : 'People who sign up show up here.'}
            actionLabel={query ? 'Clear search' : 'Refresh'}
            actionVariant="outline"
            onAction={() => (query ? setText('') : customers.reload())}
          />
        )}

        {list.map((customer) => (
          <CustomerRow key={customer.id} customer={customer} />
        ))}
      </Column>
    </TabScroll>
  );
}

function CustomerRow({ customer }: { customer: Customer }) {
  return (
    <Pressable
      onPress={() => router.push({ pathname: '/customer/[id]', params: { id: customer.id } })}
      accessibilityRole="button"
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <Avatar name={customer.display_name || customer.email} size={44} />
      <View style={styles.rowText}>
        <Text style={styles.name} numberOfLines={1}>
          {customer.display_name || customer.email || 'Customer'}
          {customer.role === 'admin' ? '  ·  admin' : ''}
        </Text>
        <Text style={styles.email} numberOfLines={1}>
          {customer.email ?? ''}
        </Text>
      </View>
      <Text style={styles.balance}>{formatBirr(customer.balance)}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  title: {
    paddingTop: spacing.md,
    marginBottom: spacing.md,
    fontFamily: fonts.extrabold,
    fontSize: 32,
    color: colors.text,
    letterSpacing: -1,
  },
  sticky: { width: '100%', backgroundColor: colors.bg },
  searchWrap: { paddingBottom: spacing.md },
  list: { gap: spacing.sm + 2, paddingTop: spacing.xs },
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
  rowText: { flex: 1 },
  name: { fontFamily: fonts.bold, fontSize: 15, color: colors.text },
  email: { marginTop: 1, fontFamily: fonts.regular, fontSize: 13, color: colors.textMuted },
  balance: { fontFamily: fonts.extrabold, fontSize: 14.5, color: colors.limeInk },
});
