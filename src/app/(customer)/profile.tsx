import { LinearGradient } from 'expo-linear-gradient';
import { router, useLocalSearchParams } from 'expo-router';
import { useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Linking,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { FeatherIcon, type FeatherName } from '../../components/art/FeatherIcon';
import { FadeScrollView } from '../../components/ui/FadeScrollView';
import { HighlightTarget } from '../../components/ui/HighlightTarget';
import { Avatar } from '../../components/market/Avatar';
import { AccountSwitcher } from '../../components/profile/AccountSwitcher';
import { SettingsGroup, SettingsMenu, SettingsRow, type SettingsItem } from '../../components/profile/SettingsMenu';
import { Button } from '../../components/ui/Button';
import { LanguagePill } from '../../components/ui/LanguagePill';
import { Column, TabScroll } from '../../components/ui/TabScroll';
import { useAuth } from '../../lib/auth';
import { pickAvatar, saveAvatar } from '../../lib/avatar';
import { formatBirr } from '../../lib/catalog';
import { PRIVACY_POLICY_URL, SUPPORT } from '../../lib/config';
import { formatDateTime } from '../../lib/format';
import { useI18n, type Language } from '../../lib/i18n';
import { colors, fonts, radius, spacing } from '../../lib/theme';
import { useToast } from '../../lib/toast';
import { useAsync, useRefreshOnFocus } from '../../lib/useAsync';
import { useScrollContainer, useScrollToHighlight, type ScrollContainer } from '../../lib/useScrollToHighlight';
import { fetchTransactions, type TransactionKind } from '../../lib/wallet';

const TX_ICONS: Record<TransactionKind, FeatherName> = {
  deposit: 'arrow-down-left',
  purchase: 'arrow-up-right',
  refund: 'rotate-ccw',
  adjustment: 'edit-2',
  withdrawal: 'arrow-up-right',
  portal_coin_redemption: 'star',
  commission: 'tag',
};

const LANGUAGES: { id: Language; label: string }[] = [
  { id: 'en', label: 'English' },
  { id: 'am', label: 'አማርኛ' },
];

// A transaction row is 64pt tall (40pt icon + 12pt padding top and bottom) with a 10pt gap: 4.5 rows show at once,
// and the half row cut off at the bottom is itself the hint that the list scrolls.
const TX_ROW = 64;
const TX_GAP = spacing.sm + 2;
const TX_BOX_MAX = Math.round(4.5 * TX_ROW + 4 * TX_GAP);
/** The transaction history in a capped box of its own that scrolls inside itself (see FadeScrollView). */
function TransactionBox({ children, container }: { children: ReactNode; container: ScrollContainer }) {
  return (
    <FadeScrollView style={styles.txBox} contentContainerStyle={styles.list} container={container}>
      {children}
    </FadeScrollView>
  );
}

/**
 * Grouped like a phone's settings screen: the header on its own, then one card per group -- the photo action, the
 * balance, the everyday settings together in one card (rows split by thin dividers), the transactions, and the
 * account actions (admin view, sign out) apart from everything else because signing out is the one with consequences.
 */
export default function ProfileScreen() {
  const { user, profile, balance, isAdmin, signOut, refreshAccount } = useAuth();
  const { t, language, setLanguage } = useI18n();
  const toast = useToast();
  const userId = user?.id;
  const [refreshing, setRefreshing] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [uploading, setUploading] = useState(false);

  // A tapped money notification: scroll the Transactions box to its row and glow it once. The row stays in the
  // list afterwards (the history keeps reaching back to it) even though the route param is cleared.
  const { highlight, hl } = useLocalSearchParams<{ highlight?: string; hl?: string }>();
  const [throughId, setThroughId] = useState<string | null>(highlight ?? null);
  if (highlight && highlight !== throughId) setThroughId(highlight);
  const page = useScrollContainer();
  const txBox = useScrollContainer();

  const history = useAsync(
    () => (userId ? fetchTransactions(userId, 30, throughId) : Promise.resolve([])),
    `${userId ?? ''}|${throughId ?? ''}`
  );
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
      router.replace('/splash');
    } finally {
      setSigningOut(false);
    }
  }

  /** The same pick -> crop -> upload as Edit Profile's avatar, reachable in one tap from here. */
  async function changePhoto() {
    if (!userId || uploading) return;
    const picked = await pickAvatar();
    if (!picked) return;
    setUploading(true);
    try {
      await saveAvatar(userId, picked);
      await refreshAccount();
      toast(t('editProfile.photoSaved'));
    } catch {
      toast(t('editProfile.photoFailed'));
    } finally {
      setUploading(false);
    }
  }

  const transactions = history.data ?? [];
  const highlighter = useScrollToHighlight({
    targetId: highlight ?? null,
    token: hl ?? null,
    ready: history.status !== 'loading',
    present: !!highlight && transactions.some((tx) => tx.id === highlight),
    containers: [txBox, page],
    onConsumed: () => router.setParams({ highlight: undefined, hl: undefined }),
  });

  // Only rows with something real behind them: Privacy needs a published policy page or a support contact
  // (see lib/config.ts). There is no Appearance row (no theming exists) and no Notifications row (no push exists).
  const settingsItems: SettingsItem[] = [
    { key: 'edit', icon: 'user', label: t('settings.editProfile'), onPress: () => router.push('/settings/edit-profile') },
    { key: 'account', icon: 'lock', label: t('settings.account'), onPress: () => router.push('/settings/account') },
    ...(PRIVACY_POLICY_URL || SUPPORT.url
      ? [{ key: 'privacy', icon: 'shield' as const, label: t('settings.privacy'), onPress: () => router.push('/settings/privacy') }]
      : []),
  ];

  return (
    <TabScroll refreshing={refreshing} onRefresh={onRefresh} container={page}>
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

        <View style={styles.cards}>
          <SettingsGroup>
            <SettingsRow
              icon="camera"
              label={t('editProfile.changePhoto')}
              tone="accent"
              onPress={changePhoto}
              noChevron
              busy={uploading}
              right={uploading ? <ActivityIndicator color={colors.limeInk} /> : undefined}
            />
          </SettingsGroup>

          <AccountSwitcher />

          {/* Balance + top up: the screen's primary action, unchanged. */}
          <LinearGradient colors={['#F8FDEF', '#E1F5BC']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.balanceCard}>
            <View style={styles.arc} />
            <Text style={styles.balanceLabel}>{t('common.balance')}</Text>
            <Text style={styles.balanceAmount}>{balance === null ? '—' : formatBirr(balance)}</Text>
            <Button label={t('common.topUp')} variant="dark" onPress={() => router.push('/wallet')} style={styles.topUp} />
          </LinearGradient>

          <SettingsGroup>
            {/* Gift: send a pack to a friend or buy a redeem code (the gift flow, see app/gift). */}
            <SettingsRow icon="gift" label={t('gift.menu.title')} onPress={() => router.push('/gift')} />
            {/* Redeem code: a code someone handed over becomes a gift in this Vault (app/redeem). */}
            <SettingsRow icon="key" label={t('redeem.title')} onPress={() => router.push('/redeem')} />
            <SettingsMenu title={t('settings.title')} items={settingsItems} />
            <SettingsRow
              icon="globe"
              label={t('profile.language')}
              accessibleGroup={false}
              right={
                <View style={styles.segment}>
                  {LANGUAGES.map((option) => {
                    const on = option.id === language;
                    return (
                      <Pressable
                        key={option.id}
                        onPress={() => setLanguage(option.id)}
                        accessibilityRole="button"
                        accessibilityLabel={option.label}
                        accessibilityState={{ selected: on }}
                        hitSlop={4}
                        style={[styles.segmentItem, on && styles.segmentItemOn]}
                      >
                        <Text style={[styles.segmentText, on && styles.segmentTextOn]}>{option.label}</Text>
                      </Pressable>
                    );
                  })}
                </View>
              }
            />
            <SettingsRow
              icon="life-buoy"
              label={t('profile.support')}
              value={SUPPORT.url ? SUPPORT.label || t('topup.contact') : t('profile.supportBody')}
              valueLines={2}
              onPress={SUPPORT.url ? () => Linking.openURL(SUPPORT.url) : undefined}
            />
          </SettingsGroup>
        </View>

        {/* Transactions */}
        <Text style={styles.sectionTitle}>{t('profile.history')}</Text>
        {history.data && transactions.length === 0 ? (
          <Text style={styles.empty}>{t('profile.noHistory')}</Text>
        ) : (
          <TransactionBox container={txBox}>
            {transactions.map((tx) => {
              const positive = tx.amount > 0;
              return (
                <HighlightTarget key={tx.id} id={tx.id} binding={highlighter} radius={radius.lg - 4} outset={0}>
                  <View style={styles.txRow}>
                    <View style={[styles.txIcon, positive && styles.txIconIn]}>
                      <FeatherIcon name={TX_ICONS[tx.kind]} size={18} color={positive ? colors.limeDark : colors.text} />
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
                </HighlightTarget>
              );
            })}
          </TransactionBox>
        )}

        {/* Account actions, kept apart from the everyday settings. */}
        <View style={styles.actions}>
          <SettingsGroup>
            {isAdmin && <SettingsRow icon="grid" label={t('profile.adminView')} onPress={() => router.replace('/queue')} />}
            <SettingsRow
              icon="log-out"
              label={t('profile.signOut')}
              tone="danger"
              onPress={handleSignOut}
              noChevron
              busy={signingOut}
              right={signingOut ? <ActivityIndicator color={colors.danger} /> : undefined}
            />
          </SettingsGroup>
        </View>
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

  // One gap between every card, so each reads as its own group.
  cards: { gap: spacing.md },

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

  segment: { flexDirection: 'row', padding: 3, borderRadius: radius.pill, backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border },
  segmentItem: { height: 30, paddingHorizontal: 11, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center' },
  segmentItemOn: { backgroundColor: colors.primary },
  segmentText: { fontFamily: fonts.semibold, fontSize: 13, color: colors.textMuted },
  segmentTextOn: { color: colors.primaryText },

  sectionTitle: {
    marginTop: spacing.lg + 4,
    marginBottom: spacing.sm + 4,
    fontFamily: fonts.bold,
    fontSize: 17,
    color: colors.text,
    letterSpacing: -0.3,
  },
  empty: { fontFamily: fonts.regular, fontSize: 14.5, color: colors.textMuted },
  list: { gap: TX_GAP },
  txBox: { maxHeight: TX_BOX_MAX, borderRadius: radius.lg - 4, overflow: 'hidden' },
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

  actions: { marginTop: spacing.lg + 4 },
});
