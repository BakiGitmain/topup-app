import * as Clipboard from 'expo-clipboard';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { FeatherIcon } from '../../components/art/FeatherIcon';
import { AlertIcon } from '../../components/art/Icons';
import { StateMessage } from '../../components/market/StateMessage';
import { VaultCard } from '../../components/market/VaultCard';
import { LanguagePill } from '../../components/ui/LanguagePill';
import { Column, TabScroll } from '../../components/ui/TabScroll';
import { useAuth } from '../../lib/auth';
import { useCustomerBadges } from '../../lib/badges';
import { useT } from '../../lib/i18n';
import { colors, fonts, spacing } from '../../lib/theme';
import { useToast } from '../../lib/toast';
import { useAsync, useRefreshOnFocus } from '../../lib/useAsync';
import { fetchVault, setCodeUsed, type VaultItem } from '../../lib/vault';

export default function VaultScreen() {
  const { user } = useAuth();
  const t = useT();
  const toast = useToast();
  const userId = user?.id;
  const [refreshing, setRefreshing] = useState(false);

  const vault = useAsync(() => (userId ? fetchVault(userId) : Promise.resolve([])));
  useRefreshOnFocus(vault.reload);

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
    await vault.reload();
    setRefreshing(false);
  }

  async function copy(code: string) {
    await Clipboard.setStringAsync(code);
    toast(t('vault.codeCopied'));
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
  const unused = items.filter((i) => !i.is_used);
  const used = items.filter((i) => i.is_used);

  const renderCard = (item: VaultItem) => (
    <VaultCard key={item.id} item={item} onCopy={copy} onToggleUsed={toggleUsed} />
  );

  return (
    <TabScroll refreshing={refreshing} onRefresh={onRefresh}>
      <Column>
        <View style={styles.headRow}>
          <Text style={[styles.title, styles.headTitle]}>{t('vault.title')}</Text>
          <LanguagePill />
        </View>
        <Text style={styles.subtitle}>{t('vault.subtitle')}</Text>

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

        {vault.data && items.length === 0 && (
          <StateMessage
            icon={<FeatherIcon name="package" size={30} color={colors.limeInk} />}
            title={t('vault.emptyTitle')}
            body={t('vault.emptyBody')}
            actionLabel={t('tab.shop')}
            onAction={() => router.navigate('/shop')}
          />
        )}

        <View style={styles.list}>{unused.map(renderCard)}</View>

        {used.length > 0 && (
          <>
            <Text style={styles.usedTitle}>{t('vault.used')}</Text>
            <View style={styles.list}>{used.map(renderCard)}</View>
          </>
        )}
      </Column>
    </TabScroll>
  );
}

const styles = StyleSheet.create({
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
  list: { gap: spacing.sm + 4 },
  usedTitle: {
    marginTop: spacing.lg,
    marginBottom: spacing.sm + 4,
    fontFamily: fonts.bold,
    fontSize: 15,
    color: colors.textMuted,
  },
});
