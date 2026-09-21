import { router } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { FeatherIcon } from '../../components/art/FeatherIcon';
import { AlertIcon } from '../../components/art/Icons';
import { OrderRow } from '../../components/market/OrderRow';
import { StateMessage } from '../../components/market/StateMessage';
import { LanguagePill } from '../../components/ui/LanguagePill';
import { Column, TabScroll } from '../../components/ui/TabScroll';
import { useAuth } from '../../lib/auth';
import { formatDateTime } from '../../lib/format';
import { useT } from '../../lib/i18n';
import { fetchMyOrders } from '../../lib/orders';
import { colors, fonts, spacing } from '../../lib/theme';
import { useAsync, useRefreshOnFocus } from '../../lib/useAsync';

export default function OrdersScreen() {
  const { user } = useAuth();
  const t = useT();
  const userId = user?.id;
  const [refreshing, setRefreshing] = useState(false);

  const orders = useAsync(() => (userId ? fetchMyOrders(userId) : Promise.resolve([])));
  useRefreshOnFocus(orders.reload);

  async function onRefresh() {
    setRefreshing(true);
    await orders.reload();
    setRefreshing(false);
  }

  const list = orders.data ?? [];

  return (
    <TabScroll refreshing={refreshing} onRefresh={onRefresh}>
      <Column>
        <View style={styles.headRow}>
          <Text style={[styles.title, styles.headTitle]}>{t('orders.title')}</Text>
          <LanguagePill />
        </View>

        {orders.status === 'error' && !orders.data && (
          <StateMessage
            tone="danger"
            icon={<AlertIcon size={30} color={colors.danger} />}
            title={t('orders.title')}
            body={t('common.loadError')}
            actionLabel={t('common.retry')}
            onAction={orders.reload}
          />
        )}

        {orders.data && list.length === 0 && (
          <StateMessage
            icon={<FeatherIcon name="file-text" size={30} color={colors.limeInk} />}
            title={t('orders.emptyTitle')}
            body={t('orders.emptyBody')}
            actionLabel={t('tab.shop')}
            onAction={() => router.navigate('/shop')}
          />
        )}

        <View style={styles.list}>
          {list.map((order) => (
            <OrderRow
              key={order.id}
              order={order}
              statusLabel={t(`status.${order.status}`)}
              meta={formatDateTime(order.created_at)}
              onPress={() =>
                order.status === 'pending_payment'
                  ? router.push({ pathname: '/pay/[id]', params: { id: order.id } })
                  : router.push({ pathname: '/order/[id]', params: { id: order.id } })
              }
            />
          ))}
        </View>
      </Column>
    </TabScroll>
  );
}

const styles = StyleSheet.create({
  headRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  headTitle: { flexShrink: 1 },
  title: {
    paddingTop: spacing.md,
    marginBottom: spacing.md,
    fontFamily: fonts.extrabold,
    fontSize: 32,
    color: colors.text,
    letterSpacing: -1,
  },
  list: { gap: spacing.sm + 2 },
});
