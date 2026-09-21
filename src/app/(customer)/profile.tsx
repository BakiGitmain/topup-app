import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import { useState } from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';

import { FeatherIcon, type FeatherName } from '../../components/art/FeatherIcon';
import { Avatar } from '../../components/market/Avatar';
import { Button } from '../../components/ui/Button';
import { LanguagePill } from '../../components/ui/LanguagePill';
import { Column, TabScroll } from '../../components/ui/TabScroll';
import { useAuth } from '../../lib/auth';
import { formatBirr } from '../../lib/catalog';
import { SUPPORT } from '../../lib/config';
import { formatDateTime } from '../../lib/format';
import { useI18n, type Language } from '../../lib/i18n';
import { colors, fonts, radius, spacing } from '../../lib/theme';
import { useAsync, useRefreshOnFocus } from '../../lib/useAsync';
import { fetchTransactions, type TransactionKind } from '../../lib/wallet';

const TX_ICONS: Record<TransactionKind, FeatherName> = {
  deposit: 'arrow-down-left',
  purchase: 'arrow-up-right',
  refund: 'rotate-ccw',
  adjustment: 'edit-2',
  withdrawal: 'arrow-up-right',
};

const LANGUAGES: { id: Language; label: string }[] = [
  { id: 'en', label: 'English' },
  { id: 'am', label: 'አማርኛ' },
];

export default function ProfileScreen() {
  const { user, profile, balance, isAdmin, signOut, refreshAccount } = useAuth();
  const { t, language, setLanguage } = useI18n();
  const userId = user?.id;
  const [refreshing, setRefreshing] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  const history = useAsync(() => (userId ? fetchTransactions(userId) : Promise.resolve([])));
  useRefreshOnFocus(() => {
    history.reload();
    refreshAccount();
  });

  async function onRefresh() {
    setRefreshing(true);
    await Promise.all([history.reload(), refreshAccount()]);
    setRefreshing(false);
  }

  async function handleSignOut() {
    setSigningOut(true);
    try {
      await signOut();
      router.replace('/sign-in');
    } finally {
      setSigningOut(false);
    }
  }

  const transactions = history.data ?? [];

  return (
    <TabScroll refreshing={refreshing} onRefresh={onRefresh}>
      <Column>
        <View style={styles.identity}>
          <Avatar name={profile?.display_name} uri={profile?.avatar_url} size={60} />
          <View style={styles.identityText}>
            <Text style={styles.name} numberOfLines={1}>
              {profile?.display_name || t('tab.profile')}
            </Text>
            <Text style={styles.email} numberOfLines={1}>
              {user?.email ?? ''}
            </Text>
          </View>
          <LanguagePill />
        </View>

        {/* Balance + top up */}
        <LinearGradient
          colors={['#F8FDEF', '#E1F5BC']}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.balanceCard}
        >
          <View style={styles.arc} />
          <Text style={styles.balanceLabel}>{t('common.balance')}</Text>
          <Text style={styles.balanceAmount}>{balance === null ? '—' : formatBirr(balance)}</Text>
          <Button
            label={t('common.topUp')}
            variant="dark"
            onPress={() => router.push('/wallet')}
            style={styles.topUp}
          />
        </LinearGradient>

        {/* Transactions */}
        <Text style={styles.sectionTitle}>{t('profile.history')}</Text>
        {history.data && transactions.length === 0 ? (
          <Text style={styles.empty}>{t('profile.noHistory')}</Text>
        ) : (
          <View style={styles.list}>
            {transactions.map((tx) => {
              const positive = tx.amount > 0;
              return (
                <View key={tx.id} style={styles.txRow}>
                  <View style={[styles.txIcon, positive && styles.txIconIn]}>
                    <FeatherIcon
                      name={TX_ICONS[tx.kind]}
                      size={18}
                      color={positive ? colors.limeDark : colors.text}
                    />
                  </View>
                  <View style={styles.txText}>
                    <Text style={styles.txTitle}>{t(`tx.${tx.kind}`)}</Text>
                    <Text style={styles.txMeta} numberOfLines={1}>
                      {tx.note ? `${tx.note}  ·  ` : ''}
                      {formatDateTime(tx.created_at)}
                    </Text>
                  </View>
                  <Text style={[styles.txAmount, positive && styles.txAmountIn]}>
                    {positive ? '+' : '−'}
                    {formatBirr(Math.abs(tx.amount))}
                  </Text>
                </View>
              );
            })}
          </View>
        )}

        {/* Language */}
        <Text style={styles.sectionTitle}>{t('profile.language')}</Text>
        <View style={styles.segment}>
          {LANGUAGES.map((option) => {
            const on = option.id === language;
            return (
              <Pressable
                key={option.id}
                onPress={() => setLanguage(option.id)}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
                style={[styles.segmentItem, on && styles.segmentItemOn]}
              >
                <Text style={[styles.segmentText, on && styles.segmentTextOn]}>{option.label}</Text>
              </Pressable>
            );
          })}
        </View>

        {/* Support */}
        <Text style={styles.sectionTitle}>{t('profile.support')}</Text>
        <View style={styles.supportCard}>
          <Text style={styles.supportText}>{t('profile.supportBody')}</Text>
          {SUPPORT.url ? (
            <Button
              label={SUPPORT.label || t('topup.contact')}
              variant="outline"
              onPress={() => Linking.openURL(SUPPORT.url)}
              style={styles.supportButton}
            />
          ) : null}
        </View>

        {isAdmin && (
          <Button
            label={t('profile.adminView')}
            onPress={() => router.replace('/queue')}
            style={styles.adminButton}
          />
        )}

        <Button
          label={t('profile.signOut')}
          variant="outline"
          onPress={handleSignOut}
          loading={signingOut}
          style={styles.signOut}
        />
      </Column>
    </TabScroll>
  );
}

const styles = StyleSheet.create({
  identity: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingTop: spacing.md,
    marginBottom: spacing.lg,
  },
  identityText: { flex: 1 },
  name: { fontFamily: fonts.extrabold, fontSize: 24, color: colors.text, letterSpacing: -0.6 },
  email: { marginTop: 2, fontFamily: fonts.regular, fontSize: 14, color: colors.textMuted },

  balanceCard: {
    overflow: 'hidden',
    padding: spacing.lg,
    borderRadius: radius.xl - 4,
    borderWidth: 1,
    borderColor: '#D3EFA6',
  },
  arc: {
    position: 'absolute',
    top: -50,
    right: -30,
    width: 150,
    height: 150,
    borderRadius: 75,
    backgroundColor: 'rgba(190, 232, 106, 0.32)',
  },
  balanceLabel: { fontFamily: fonts.medium, fontSize: 13.5, color: '#6E7F62' },
  balanceAmount: {
    marginTop: 2,
    fontFamily: fonts.extrabold,
    fontSize: 38,
    lineHeight: 46,
    color: colors.limeDark,
    letterSpacing: -1.2,
  },
  topUp: { marginTop: spacing.md },

  sectionTitle: {
    marginTop: spacing.lg + 4,
    marginBottom: spacing.sm + 4,
    fontFamily: fonts.bold,
    fontSize: 17,
    color: colors.text,
    letterSpacing: -0.3,
  },
  empty: { fontFamily: fonts.regular, fontSize: 14.5, color: colors.textMuted },
  list: { gap: spacing.sm + 2 },
  txRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md - 2,
    padding: spacing.md - 2,
    borderRadius: radius.lg - 4,
    backgroundColor: colors.surface,
  },
  txIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  txIconIn: { backgroundColor: colors.limeSoft },
  txText: { flex: 1 },
  txTitle: { fontFamily: fonts.bold, fontSize: 14.5, color: colors.text },
  txMeta: { marginTop: 1, fontFamily: fonts.regular, fontSize: 12, color: colors.textMuted },
  txAmount: { fontFamily: fonts.extrabold, fontSize: 14.5, color: colors.text },
  txAmountIn: { color: colors.limeInk },

  segment: {
    flexDirection: 'row',
    padding: 4,
    borderRadius: 999,
    backgroundColor: colors.surface,
  },
  segmentItem: {
    flex: 1,
    height: 42,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  segmentItemOn: { backgroundColor: colors.primary },
  segmentText: { fontFamily: fonts.semibold, fontSize: 14.5, color: colors.textMuted },
  segmentTextOn: { color: colors.primaryText },

  supportCard: {
    padding: spacing.md,
    borderRadius: radius.lg - 4,
    backgroundColor: colors.surface,
    gap: spacing.sm + 4,
  },
  supportText: { fontFamily: fonts.regular, fontSize: 14.5, lineHeight: 21, color: colors.textMuted },
  supportButton: { alignSelf: 'stretch' },

  adminButton: { marginTop: spacing.lg + 4 },
  signOut: { marginTop: spacing.sm + 4 },
});
