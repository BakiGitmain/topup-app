import { Redirect, router, useLocalSearchParams } from 'expo-router';
import { RefreshControl, ScrollView, StyleSheet } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useState } from 'react';

import { AlertIcon, SearchIcon } from '../../components/art/Icons';
import { CatalogSkeleton } from '../../components/market/CatalogSkeleton';
import { ProductGrid } from '../../components/market/ProductGrid';
import { StateMessage } from '../../components/market/StateMessage';
import { ScreenHeader } from '../../components/ui/ScreenHeader';
import { Column } from '../../components/ui/TabScroll';
import { useAuth } from '../../lib/auth';
import { BROWSE_CATEGORIES, fetchCatalog, type Product } from '../../lib/catalog';
import { useT } from '../../lib/i18n';
import { colors, spacing } from '../../lib/theme';
import { useAsync } from '../../lib/useAsync';

export default function CategoryScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const t = useT();
  const insets = useSafeAreaInsets();
  const { session, initializing } = useAuth();
  const category = BROWSE_CATEGORIES.find((c) => c === id);
  const catalog = useAsync(fetchCatalog, 0, !initializing && !!session && !!category);
  const [refreshing, setRefreshing] = useState(false);

  const products = (catalog.data ?? []).filter((p) => p.category === category);

  const open = (product: Product) =>
    router.push({ pathname: '/product/[id]', params: { id: product.id } });

  async function onRefresh() {
    setRefreshing(true);
    await catalog.reload();
    setRefreshing(false);
  }

  if (!initializing && !session) return <Redirect href="/sign-in" />;
  if (!category) return <Redirect href="/shop" />;

  const loading = catalog.status === 'loading' && !catalog.data;
  const failed = catalog.status === 'error' && !catalog.data;

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView
        contentContainerStyle={{ paddingBottom: insets.bottom + spacing.xl }}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={colors.limeDeep}
            colors={[colors.limeDeep]}
          />
        }
      >
        <Column>
          <ScreenHeader title={category ? t(`cat.${category}`) : ''} />

          {loading && <CatalogSkeleton />}

          {failed && (
            <StateMessage
              tone="danger"
              icon={<AlertIcon size={30} color={colors.danger} />}
              title={t('shop.errorTitle')}
              body={t('common.loadError')}
              actionLabel={t('common.retry')}
              onAction={catalog.reload}
            />
          )}

          {catalog.data && products.length === 0 && (
            <StateMessage
              icon={<SearchIcon size={28} color={colors.limeInk} />}
              title={t('shop.emptyTitle')}
              body={t('shop.emptyBody')}
              actionLabel={t('common.retry')}
              onAction={catalog.reload}
            />
          )}

          {products.length > 0 && <ProductGrid products={products} onPress={open} />}
        </Column>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
});
