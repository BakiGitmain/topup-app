import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { FeatherIcon, type FeatherName } from '../../components/art/FeatherIcon';
import { AlertIcon, SearchIcon } from '../../components/art/Icons';
import { CatalogSkeleton } from '../../components/market/CatalogSkeleton';
import { ProductGrid, useProductGrid } from '../../components/market/ProductGrid';
import { SearchBar } from '../../components/market/SearchBar';
import { StateMessage } from '../../components/market/StateMessage';
import { GiftBanner } from '../../components/gift/GiftBanner';
import { ShopHeader } from '../../components/header/ShopHeader';
import { Column, TabScroll } from '../../components/ui/TabScroll';
import { useAuth } from '../../lib/auth';
import {
  BROWSE_CATEGORIES,
  fetchCatalog,
  formatBirr,
  type BrowseCategory,
  type Product,
} from '../../lib/catalog';
import { giftParams, type GiftTarget } from '../../lib/giftMode';
import { useT } from '../../lib/i18n';
import { fetchBuyAgain, type BuyAgainItem } from '../../lib/orders';
import { colors, fonts, radius, spacing } from '../../lib/theme';
import { SHOP_SEARCH_IDLE_MS, searchProducts } from '../../lib/searchLogic';
import { useAsync, useRefreshOnFocus } from '../../lib/useAsync';
import { useDebouncedSearch } from '../../lib/useDebounced';

// A small recognition aid next to each section title -- literal, not decorative (a gift box for gift cards, a key
// for game keys...). Only on the shop's own browse sections; category/[id]'s plain header stays as it is.
const CATEGORY_ICONS: Record<BrowseCategory, FeatherName> = {
  games: 'zap',
  'gift-cards': 'gift',
  'game-keys': 'key',
  subscriptions: 'refresh-cw',
};

export default function ShopScreen() {
  return <ShopCatalog />;
}

/**
 * The shop's whole catalog. With `gift`, the same catalog serves the gift flow (Profile > Gift): a gift banner instead
 * of the wallet header, no "Buy again" (that re-buys for yourself), and every product opens in gift mode.
 */
export function ShopCatalog({ gift }: { gift?: GiftTarget }) {
  const { user, refreshAccount } = useAuth();
  const t = useT();
  const [query, setQuery] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  const userId = user?.id;
  const catalog = useAsync(fetchCatalog);
  const buyAgain = useAsync(() => (userId ? fetchBuyAgain(userId) : Promise.resolve([])), userId ?? '');
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
    router.push({ pathname: '/product/[id]', params: { id: product.id, ...giftParams(gift) } });
  const openCategory = (id: BrowseCategory) => router.push({ pathname: '/category/[id]', params: { id, ...giftParams(gift) } });
  const openDeposit = () => router.push('/deposit');
  const openWithdraw = () => router.push('/withdraw');
  const openSignIn = () => router.push('/sign-in');

  const loading = catalog.status === 'loading' && !catalog.data;
  const failed = catalog.status === 'error' && !catalog.data;

  return (
    <TabScroll refreshing={refreshing} onRefresh={onRefresh} stickyHeaderIndices={[1]}>
      {gift ? (
        <Column style={styles.giftBanner}>
          <GiftBanner target={gift} />
        </Column>
      ) : (
        <ShopHeader onTopUp={openDeposit} onWithdraw={openWithdraw} onSignIn={openSignIn} />
      )}

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
            {!gift && (buyAgain.data ?? []).length > 0 && (
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
                onSeeAll={() => openCategory(section.id)}
              />
            ))}
          </>
        )}
      </Column>
    </TabScroll>
  );
}

function SectionHeader({ title, icon, onSeeAll, seeAllLabel }: {
  title: string;
  icon?: FeatherName;
  onSeeAll?: () => void;
  seeAllLabel?: string;
}) {
  const t = useT();
  return (
    <View style={styles.sectionRow}>
      <View style={styles.sectionTitleRow}>
        {icon && <FeatherIcon name={icon} size={17} color={colors.limeInk} strokeWidth={2.2} />}
        <Text style={styles.sectionTitle} accessibilityRole="header">
          {title}
        </Text>
      </View>
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
function CategorySection({ id, products, onOpen, onSeeAll }: {
  id: BrowseCategory;
  products: Product[];
  onOpen: (product: Product) => void;
  onSeeAll: () => void;
}) {
  const t = useT();
  const { limit } = useProductGrid();
  const name = t(`cat.${id}`);
  const hasMore = products.length > limit;

  return (
    <View style={styles.section}>
      <SectionHeader
        title={name}
        icon={CATEGORY_ICONS[id]}
        onSeeAll={hasMore ? onSeeAll : undefined}
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
  giftBanner: { paddingTop: spacing.md, paddingBottom: spacing.sm },
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
  sectionTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 7, flexShrink: 1 },
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
