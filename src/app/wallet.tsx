import { Redirect, router } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { FeatherIcon, type FeatherName } from '../components/art/FeatherIcon';
import { Button } from '../components/ui/Button';
import { ScreenHeader } from '../components/ui/ScreenHeader';
import { Column } from '../components/ui/TabScroll';
import { useAuth } from '../lib/auth';
import { formatBirr } from '../lib/catalog';
import { formatDateTime } from '../lib/format';
import { useT } from '../lib/i18n';
import type { StringKey } from '../lib/strings';
import { colors, fonts, radius, spacing } from '../lib/theme';
import { useAsync, useRefreshOnFocus } from '../lib/useAsync';
import { fetchMyWithdrawals, fetchOpenDeposit, fetchTransactions, type TransactionKind } from '../lib/wallet';
import { isCredit } from '../lib/walletLogic';

const TX_ICONS: Record<TransactionKind, FeatherName> = {
  deposit: 'arrow-down-left',
  purchase: 'arrow-up-right',
  refund: 'rotate-ccw',
  adjustment: 'edit-2',
  withdrawal: 'arrow-up-right',
  portal_coin_redemption: 'star',
  commission: 'tag',
};

/** The wallet: balance, Deposit / Withdraw, what is waiting, and every line of the ledger. */
export default function WalletScreen() {
  const { user, session, balance, refreshAccount, initializing } = useAuth();
  const t = useT();
  const insets = useSafeAreaInsets();
  const userId = user?.id;
  const [refreshing, setRefreshing] = useState(false);

  const history = useAsync(() => (userId ? fetchTransactions(userId, 50) : Promise.resolve([])), userId ?? '', !initializing && !!userId);
  const openDeposit = useAsync(() => (userId ? fetchOpenDeposit(userId) : Promise.resolve(null)), userId ?? '', !initializing && !!userId);
  const withdrawals = useAsync(() => (userId ? fetchMyWithdrawals(userId) : Promise.resolve([])), userId ?? '', !initializing && !!userId);

  const reloadAll = () => Promise.all([history.reload(), openDeposit.reload(), withdrawals.reload(), refreshAccount()]);
  useRefreshOnFocus(() => {
    reloadAll();
  });

  if (!initializing && !session) return <Redirect href="/sign-in" />;

  async function onRefresh() {
    setRefreshing(true);
    await reloadAll();
    setRefreshing(false);
  }

  const transactions = history.data ?? [];
  const requests = withdrawals.data ?? [];

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView
        contentContainerStyle={{ paddingBottom: insets.bottom + spacing.xxl }}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.limeDeep} />}
      >
        <Column>
          <ScreenHeader title={t('wallet.title')} onBack={() => (router.canGoBack() ? router.back() : router.replace('/shop'))} />

          <View style={styles.card}>
            <Text style={styles.cardLabel}>{t('wallet.balance')}</Text>
            <Text style={styles.cardAmount} accessibilityLabel={`${t('wallet.balance')} ${balance === null ? '' : formatBirr(balance)}`}>
              {balance === null ? '—' : formatBirr(balance)}
            </Text>
            <View style={styles.actions}>
              <Button label={t('wallet.deposit')} onPress={() => router.push('/deposit')} style={styles.action} />
              <Button label={t('wallet.withdraw')} variant="outline" onPress={() => router.push('/withdraw')} style={styles.action} />
            </View>
          </View>

          {openDeposit.data && (
            <View style={styles.banner} accessibilityRole="alert">
              <View style={styles.bannerText}>
                <Text style={styles.bannerTitle}>{t('wallet.openDeposit', { amount: formatBirr(openDeposit.data.amount) })}</Text>
                <Text style={styles.bannerBody}>{t('wallet.openDepositBody')}</Text>
              </View>
              <Button label={t('wallet.continue')} onPress={() => router.push('/deposit')} style={styles.bannerButton} />
            </View>
          )}

          {requests.length > 0 && (
            <>
              <Text style={styles.section}>{t('wallet.withdrawals')}</Text>
              <View style={styles.list}>
                {requests.map((w) => (
                  <View key={w.id} style={styles.wRow}>
                    <View style={styles.rowText}>
                      <Text style={styles.rowTitle}>
                        {formatBirr(w.amount)}
                        <Text style={styles.rowSub}>{`  →  ${t(w.provider === 'telebirr' ? 'pay.telebirr' : 'pay.cbe')} ${w.account}`}</Text>
                      </Text>
                      <Text style={styles.rowMeta}>{formatDateTime(w.createdAt)}</Text>
                      {w.status === 'declined' && w.adminNote ? <Text style={styles.note}>{t('wallet.declinedNote', { note: w.adminNote })}</Text> : null}
                    </View>
                    <View style={[styles.pill, w.status === 'paid' && styles.pillOk, w.status === 'declined' && styles.pillBad]}>
                      <Text style={[styles.pillText, w.status === 'paid' && styles.pillTextOk, w.status === 'declined' && styles.pillTextBad]}>{t(`wallet.wd.${w.status}` as StringKey)}</Text>
                    </View>
                  </View>
                ))}
              </View>
            </>
          )}

          <Text style={styles.section}>{t('wallet.history')}</Text>
          {history.status === 'loading' && !history.data ? (
            <ActivityIndicator style={styles.loading} color={colors.limeDeep} />
          ) : history.status === 'error' && !history.data ? (
            <Text style={styles.empty}>{t('common.loadError')}</Text>
          ) : history.data && transactions.length === 0 ? (
            <Text style={styles.empty}>{t('wallet.noHistory')}</Text>
          ) : (
            <View style={styles.list}>
              {transactions.map((tx) => {
                const positive = isCredit(tx.amount);
                return (
                  <View key={tx.id} style={styles.row}>
                    <View style={[styles.icon, positive && styles.iconIn]}>
                      <FeatherIcon name={TX_ICONS[tx.kind]} size={18} color={positive ? colors.limeDark : colors.text} />
                    </View>
                    <View style={styles.rowText}>
                      <Text style={styles.rowTitle}>{t(`tx.${tx.kind}` as StringKey)}</Text>
                      <Text style={styles.rowMeta} numberOfLines={1}>
                        {tx.note ? `${tx.note}  ·  ` : ''}
                        {formatDateTime(tx.created_at)}
                      </Text>
                    </View>
                    <View style={styles.amountBox}>
                      <Text style={[styles.amount, positive && styles.amountIn]}>
                        {positive ? '+' : '−'}
                        {formatBirr(Math.abs(tx.amount))}
                      </Text>
                      <Text style={styles.after}>{t('wallet.after', { balance: formatBirr(tx.balanceAfter) })}</Text>
                    </View>
                  </View>
                );
              })}
            </View>
          )}
        </Column>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  loading: { marginTop: spacing.lg },
  card: { padding: spacing.lg, borderRadius: radius.lg, backgroundColor: colors.bgTint, borderWidth: 1, borderColor: colors.limeSoft },
  cardLabel: { fontFamily: fonts.medium, fontSize: 14, color: colors.textMuted },
  cardAmount: { marginTop: 2, fontFamily: fonts.extrabold, fontSize: 36, color: colors.limeDark, letterSpacing: -1 },
  actions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md },
  action: { flex: 1 },
  banner: { marginTop: spacing.md, padding: spacing.md, borderRadius: radius.lg - 4, backgroundColor: '#FFF6DC', borderWidth: 1, borderColor: '#F2DFA6', gap: spacing.sm },
  bannerText: { gap: 2 },
  bannerTitle: { fontFamily: fonts.bold, fontSize: 14.5, color: '#6B4A00' },
  bannerBody: { fontFamily: fonts.regular, fontSize: 13, lineHeight: 19, color: '#6B4A00' },
  bannerButton: { alignSelf: 'flex-start' },
  section: { marginTop: spacing.lg, marginBottom: spacing.sm, fontFamily: fonts.bold, fontSize: 17, color: colors.text },
  empty: { fontFamily: fonts.medium, fontSize: 14, color: colors.textMuted },
  list: { borderRadius: radius.lg - 4, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, paddingHorizontal: spacing.md },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm + 2, paddingVertical: spacing.sm + 4, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  wRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm, paddingVertical: spacing.sm + 4, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  icon: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: colors.border },
  iconIn: { backgroundColor: colors.limeSoft, borderColor: colors.limeSoft },
  rowText: { flex: 1 },
  rowTitle: { fontFamily: fonts.semibold, fontSize: 14.5, color: colors.text },
  rowSub: { fontFamily: fonts.regular, fontSize: 13, color: colors.textMuted },
  rowMeta: { marginTop: 2, fontFamily: fonts.regular, fontSize: 12.5, color: colors.textMuted },
  note: { marginTop: 4, fontFamily: fonts.medium, fontSize: 12.5, lineHeight: 18, color: colors.danger },
  amountBox: { alignItems: 'flex-end' },
  amount: { fontFamily: fonts.bold, fontSize: 14.5, color: colors.text },
  amountIn: { color: colors.limeInk },
  after: { marginTop: 2, fontFamily: fonts.regular, fontSize: 11.5, color: colors.textFaint },
  pill: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12, backgroundColor: '#FFF1CC' },
  pillOk: { backgroundColor: colors.limeSoft },
  pillBad: { backgroundColor: colors.dangerBg },
  pillText: { fontFamily: fonts.bold, fontSize: 12, color: '#8A5A00' },
  pillTextOk: { color: colors.limeDark },
  pillTextBad: { color: colors.danger },
});
