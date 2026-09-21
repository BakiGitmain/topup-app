import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { FeatherIcon } from '../../components/art/FeatherIcon';
import { AlertIcon, SearchIcon } from '../../components/art/Icons';
import { CartButton } from '../../components/cart/CartButton';
import { LanguagePill } from '../../components/ui/LanguagePill';
import { BalancePill } from '../../components/market/BalancePill';
import { CatalogSkeleton } from '../../components/market/CatalogSkeleton';
import { ProductGrid, useProductGrid } from '../../components/market/ProductGrid';
import { SearchBar } from '../../components/market/SearchBar';
import { StateMessage } from '../../components/market/StateMessage';
import { Column, TabScroll } from '../../components/ui/TabScroll';
import { useAuth } from '../../lib/auth';
import {
  BROWSE_CATEGORIES,
  fetchCatalog,
  formatBirr,
  type BrowseCategory,
  type Product,
} from '../../lib/catalog';
import { useT } from '../../lib/i18n';
import { fetchBuyAgain, type BuyAgainItem } from '../../lib/orders';
import { colors, fonts, radius, spacing } from '../../lib/theme';
import { SHOP_SEARCH_IDLE_MS, searchProducts } from '../../lib/searchLogic';
import { useAsync, useRefreshOnFocus } from '../../lib/useAsync';
import { useDebouncedSearch } from '../../lib/useDebounced';

export default function ShopScreen() {
  const { user, refreshAccount, balance } = useAuth();
  const t = useT();
  const [query, setQuery] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  const userId = user?.id;
  const catalog = useAsync(fetchCatalog);
  const buyAgain = useAsync(() => (userId ? fetchBuyAgain(userId) : Promise.resolve([])));
  useRefreshOnFocus(buyAgain.reload);

  async function onRefresh() {
    setRefreshing(true);
    await Promise.all([catalog.reload(), buyAgain.reload(), refreshAccount()]);
    setRefreshing(false);
  }

  const products = catalog.data ?? [];
  // Filters the list already on the phone (no request), across every kind of product: see searchLogic.ts.
  const search = useDebouncedSearch(query, SHOP_SEARCH_IDLE_MS);
  const needle = search.value.trim();
  const searching = needle.length > 0;
  const matches = searching ? searchProducts(products, needle) : [];
  const sections = BROWSE_CATEGORIES.map((id) => ({
    id,
    products: products.filter((p) => p.category === id),
  })).filter((section) => section.products.length > 0);

  const openProduct = (product: Product) =>
    router.push({ pathname: '/product/[id]', params: { id: product.id } });
  const openWallet = () => router.push('/wallet');
  const openDeposit = () => router.push('/deposit');

  const loading = catalog.status === 'loading' && !catalog.data;
  const failed = catalog.status === 'error' && !catalog.data;

  return (
    <TabScroll refreshing={refreshing} onRefresh={onRefresh} stickyHeaderIndices={[1]}>
      <Column>
        <View style={styles.topRow}>
          <Text style={styles.brand}>
            topup<Text style={styles.brandDot}>.</Text>
          </Text>
          <View style={styles.topRight}>
            <LanguagePill />
            <CartButton />
            <BalancePill balance={balance} onPress={openWallet} onAdd={openDeposit} />
          </View>
        </View>
      </Column>

      {/* Sticky: kept as a direct child so the ScrollView can pin it. */}
      <View style={styles.stickyBar}>
        <Column style={styles.searchWrap}>
          <SearchBar value={query} onChangeText={setQuery} onSubmit={search.flush} placeholder={t('shop.search')} />
        </Column>
      </View>

      <Column style={styles.results}>
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

        {catalog.data && !searching && sections.length === 0 && (
          <StateMessage
            icon={<SearchIcon size={28} color={colors.limeInk} />}
            title={t('shop.emptyTitle')}
            body={t('shop.emptyBody')}
            actionLabel={t('common.retry')}
            onAction={catalog.reload}
          />
        )}

        {catalog.data && searching && matches.length === 0 && (
          <StateMessage
            icon={<SearchIcon size={28} color={colors.limeInk} />}
            title={t('shop.noResults', { q: query.trim() })}
            body={t('shop.noResultsBody')}
            actionLabel={t('shop.clear')}
            actionVariant="outline"
            onAction={() => setQuery('')}
          />
        )}

        {/* Searching: one flat result grid. */}
        {catalog.data && searching && matches.length > 0 && (
          <View style={styles.section}>
            <SectionHeader title={t('shop.results')} />
            <ProductGrid products={matches} onPress={openProduct} />
          </View>
        )}

        {/* Browsing. */}
        {catalog.data && !searching && sections.length > 0 && (
          <>
            {(buyAgain.data ?? []).length > 0 && (
              <View style={styles.section}>
                <SectionHeader title={t('shop.buyAgain')} />
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={styles.buyAgainRow}
                >
                  {(buyAgain.data ?? []).map((item) => (
                    <BuyAgainCard key={item.optionId} item={item} />
                  ))}
                </ScrollView>
              </View>
            )}

            {sections.map((section) => (
              <CategorySection
                key={section.id}
                id={section.id}
                products={section.products}
                onOpen={openProduct}
              />
            ))}
          </>
        )}
      </Column>
    </TabScroll>
  );
}

function SectionHeader({ title, onSeeAll, seeAllLabel }: {
  title: string;
  onSeeAll?: () => void;
  seeAllLabel?: string;
}) {
  const t = useT();
  return (
    <View style={styles.sectionRow}>
      <Text style={styles.sectionTitle} accessibilityRole="header">
        {title}
      </Text>
      {onSeeAll && (
        <Pressable
          onPress={onSeeAll}
          accessibilityRole="button"
          accessibilityLabel={seeAllLabel}
          hitSlop={8}
          style={({ pressed }) => [styles.seeAll, pressed && styles.pressed]}
        >
          <Text style={styles.seeAllText}>{t('shop.seeAll')}</Text>
          <FeatherIcon name="chevron-right" size={16} color={colors.limeInk} />
        </Pressable>
      )}
    </View>
  );
}

/** The first few tiles of one category; "See all" opens the full list when there are more. */
function CategorySection({ id, products, onOpen }: {
  id: BrowseCategory;
  products: Product[];
  onOpen: (product: Product) => void;
}) {
  const t = useT();
  const { limit } = useProductGrid();
  const name = t(`cat.${id}`);
  const hasMore = products.length > limit;

  return (
    <View style={styles.section}>
      <SectionHeader
        title={name}
        onSeeAll={hasMore ? () => router.push({ pathname: '/category/[id]', params: { id } }) : undefined}
        seeAllLabel={t('shop.seeAllIn', { name })}
      />
      <ProductGrid products={products.slice(0, limit)} onPress={onOpen} />
    </View>
  );
}

/** Tap = open checkout with this option and the same game ID already filled in. */
function BuyAgainCard({ item }: { item: BuyAgainItem }) {
  return (
    <Pressable
      onPress={() =>
        router.push({
          pathname: '/product/[id]',
          params: {
            id: item.productId,
            optionId: item.optionId,
            ...(item.accountId ? { accountId: item.accountId } : {}),
          },
        })
      }
      accessibilityRole="button"
      accessibilityLabel={`${item.productName} ${item.optionLabel}`}
      style={({ pressed }) => [styles.buyAgain, pressed && styles.pressed]}
    >
      <View style={styles.buyAgainIcon}>
        <FeatherIcon name="repeat" size={18} color={colors.limeDark} />
      </View>
      <View style={styles.buyAgainText}>
        <Text style={styles.buyAgainName} numberOfLines={1}>
          {item.productName}
        </Text>
        <Text style={styles.buyAgainOption} numberOfLines={1}>
          {item.optionLabel}
          {item.accountId ? `  ·  ID …${item.accountId.slice(-4)}` : ''}
        </Text>
        <Text style={styles.buyAgainPrice}>{formatBirr(item.price)}</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm + 2,
    paddingTop: spacing.md,
    paddingBottom: spacing.md,
  },
  topRight: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexShrink: 1 },
  brand: {
    fontFamily: fonts.extrabold,
    fontSize: 22,
    color: colors.text,
    letterSpacing: -0.5,
    flexShrink: 0,
  },
  brandDot: { color: colors.limeDeep },
  stickyBar: { width: '100%', backgroundColor: colors.bg },
  searchWrap: { paddingTop: spacing.xs, paddingBottom: spacing.md },
  results: { paddingTop: spacing.xs },
  section: { marginBottom: spacing.lg + 4 },
  sectionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 44,
    marginBottom: spacing.xs,
  },
  sectionTitle: {
    flexShrink: 1,
    fontFamily: fonts.bold,
    fontSize: 17,
    color: colors.text,
    letterSpacing: -0.3,
  },
  seeAll: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    minHeight: 44,
    paddingLeft: spacing.sm,
  },
  seeAllText: { fontFamily: fonts.semibold, fontSize: 14, color: colors.limeInk },
  pressed: { opacity: 0.8 },

  buyAgainRow: { gap: spacing.sm + 4, paddingRight: spacing.lg },
  buyAgain: {
    width: 232,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm + 4,
    padding: spacing.md - 2,
    borderRadius: radius.lg - 4,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  buyAgainIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.limeSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buyAgainText: { flex: 1 },
  buyAgainName: { fontFamily: fonts.bold, fontSize: 14, color: colors.text },
  buyAgainOption: {
    marginTop: 1,
    fontFamily: fonts.regular,
    fontSize: 12,
    color: colors.textMuted,
  },
  buyAgainPrice: {
    marginTop: 3,
    fontFamily: fonts.extrabold,
    fontSize: 13,
    color: colors.limeInk,
  },
});
