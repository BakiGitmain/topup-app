import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { FeatherIcon } from '../../components/art/FeatherIcon';
import { AlertIcon } from '../../components/art/Icons';
import { StateMessage } from '../../components/market/StateMessage';
import { VaultCard } from '../../components/market/VaultCard';
import { GiftCard } from '../../components/gift/GiftCard';
import { RedeemCodeCard } from '../../components/gift/RedeemCodeCard';
import { Chips } from '../../components/ui/Chips';
import { LanguagePill } from '../../components/ui/LanguagePill';
import { Column, TabScroll } from '../../components/ui/TabScroll';
import { useAuth } from '../../lib/auth';
import { useCustomerBadges } from '../../lib/badges';
import { useT } from '../../lib/i18n';
import { colors, fonts, spacing } from '../../lib/theme';
import { useToast } from '../../lib/toast';
import { useAsync, useRefreshOnFocus } from '../../lib/useAsync';
import { fetchMyRedeemCodes, fetchVault, fetchVaultGifts, setCodeUsed, type VaultGift, type VaultItem, type VaultRedeemCode } from '../../lib/vault';
import { liveCount, vaultSections, VAULT_FILTERS, type VaultEntry, type VaultFilter } from '../../lib/vaultView';
import type { StringKey } from '../../lib/strings';

export default function VaultScreen() {
  const { user } = useAuth();
  const t = useT();
  const toast = useToast();
  const userId = user?.id;
  const [refreshing, setRefreshing] = useState(false);

  const vault = useAsync(() => (userId ? fetchVault(userId) : Promise.resolve([])), userId ?? '');
  // Gifts received and the customer's own redeem codes live beside the gift-card codes (see lib/vaultView).
  const gifts = useAsync(() => (userId ? fetchVaultGifts() : Promise.resolve([] as VaultGift[])), userId ?? '');
  const codes = useAsync(() => (userId ? fetchMyRedeemCodes() : Promise.resolve([] as VaultRedeemCode[])), userId ?? '');
  const [filter, setFilter] = useState<VaultFilter>('all');
  // A notification can open the Vault on one filter (a gift received -> Gifts). Each tap carries its own token, so
  // the same notification tapped twice still switches; the params are cleared once used.
  const { filter: filterParam, hl } = useLocalSearchParams<{ filter?: string; hl?: string }>();
  const [appliedTap, setAppliedTap] = useState<string | undefined>(undefined);
  if (filterParam && hl && hl !== appliedTap && (VAULT_FILTERS as readonly string[]).includes(filterParam)) {
    // Adjusting state while rendering, keyed on the tap token (React's pattern for "a prop changed"): once per tap.
    setAppliedTap(hl);
    setFilter(filterParam as VaultFilter);
  }
  useEffect(() => {
    if (filterParam) router.setParams({ filter: undefined, hl: undefined });
  }, [filterParam]);
  const reloadAll = useCallback(() => {
    vault.reload();
    gifts.reload();
    codes.reload();
  }, [vault, gifts, codes]);
  useRefreshOnFocus(reloadAll);

  // Looking at the Vault clears the "new code" dot, including for a code that arrives while it is open.
  const { markVaultSeen } = useCustomerBadges();
  useFocusEffect(
    useCallback(() => {
      markVaultSeen();
    }, [markVaultSeen])
  );
  const loaded = vault.data;
  useEffect(() => {
    if (loaded) markVaultSeen();
  }, [loaded, markVaultSeen]);

  async function onRefresh() {
    setRefreshing(true);
    await Promise.all([vault.reload(), gifts.reload(), codes.reload()]);
    setRefreshing(false);
  }

  async function toggleUsed(item: VaultItem, used: boolean) {
    try {
      await setCodeUsed(item.id, used);
    } catch {
      toast(t('err.generic'));
    }
    vault.reload();
  }

  const items = vault.data ?? [];
  const data = { cards: items, gifts: gifts.data ?? [], codes: codes.data ?? [] };
  const { live, done } = vaultSections(filter, data);
  const loadedAll = vault.data && gifts.data && codes.data;
  const FILTER_LABEL: Record<VaultFilter, StringKey> = { all: 'vault.filter.all', cards: 'vault.filter.cards', gifts: 'vault.filter.gifts', codes: 'vault.filter.codes' };
  const EMPTY_BODY: Record<VaultFilter, StringKey> = { all: 'vault.emptyBody', cards: 'vault.emptyBody', gifts: 'vault.emptyGifts', codes: 'vault.emptyCodes' };

  const render = (entry: VaultEntry<VaultItem, VaultGift, VaultRedeemCode>) =>
    entry.kind === 'card' ? (
      <VaultCard key={entry.item.id} item={entry.item} onToggleUsed={toggleUsed} />
    ) : entry.kind === 'gift' ? (
      <GiftCard key={entry.item.id} gift={entry.item} onChanged={reloadAll} />
    ) : (
      <RedeemCodeCard key={entry.item.id} item={entry.item} />
    );

  return (
    <TabScroll refreshing={refreshing} onRefresh={onRefresh}>
      <Column>
        <View style={styles.headRow}>
          <Text style={[styles.title, styles.headTitle]}>{t('vault.title')}</Text>
          <LanguagePill />
        </View>
        <Text style={styles.subtitle}>{t('vault.subtitle')}</Text>

        <View style={styles.filters}>
          <Chips
            options={VAULT_FILTERS.map((id) => ({ id, label: t(FILTER_LABEL[id]), count: liveCount(id, data) }))}
            value={filter}
            onChange={setFilter}
          />
        </View>

        {vault.status === 'loading' && !vault.data && <ActivityIndicator style={styles.loading} color={colors.limeDeep} />}

        {vault.status === 'error' && !vault.data && (
          <StateMessage
            tone="danger"
            icon={<AlertIcon size={30} color={colors.danger} />}
            title={t('vault.title')}
            body={t('common.loadError')}
            actionLabel={t('common.retry')}
            onAction={vault.reload}
          />
        )}

        {loadedAll && live.length === 0 && done.length === 0 && (
          <StateMessage
            icon={<FeatherIcon name={filter === 'gifts' ? 'gift' : filter === 'codes' ? 'key' : 'package'} size={30} color={colors.limeInk} />}
            title={t(filter === 'all' ? 'vault.emptyTitle' : FILTER_LABEL[filter])}
            body={t(EMPTY_BODY[filter])}
            actionLabel={t('tab.shop')}
            onAction={() => router.navigate('/shop')}
          />
        )}

        <View style={styles.list}>{live.map(render)}</View>

        {done.length > 0 && (
          <>
            <Text style={styles.usedTitle}>{t('vault.used')}</Text>
            <View style={styles.list}>{done.map(render)}</View>
          </>
        )}
      </Column>
    </TabScroll>
  );
}

const styles = StyleSheet.create({
  loading: { marginTop: spacing.xl },
  headRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  headTitle: { flexShrink: 1 },
  title: {
    paddingTop: spacing.md,
    fontFamily: fonts.extrabold,
    fontSize: 32,
    color: colors.text,
    letterSpacing: -1,
  },
  subtitle: {
    marginTop: 4,
    marginBottom: spacing.md,
    fontFamily: fonts.regular,
    fontSize: 14.5,
    lineHeight: 21,
    color: colors.textMuted,
  },
  filters: { marginBottom: spacing.md },
  list: { gap: spacing.sm + 4 },
  usedTitle: {
    marginTop: spacing.lg,
    marginBottom: spacing.sm + 4,
    fontFamily: fonts.bold,
    fontSize: 15,
    color: colors.textMuted,
  },
});
