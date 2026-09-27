import { Redirect, router, useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { FeatherIcon } from '../../../components/art/FeatherIcon';
import { Avatar } from '../../../components/market/Avatar';
import { Outcome } from '../../../components/pay/Outcome';
import { Button } from '../../../components/ui/Button';
import { CopyButton } from '../../../components/ui/CopyButton';
import { Column } from '../../../components/ui/TabScroll';
import { useAuth } from '../../../lib/auth';
import { fetchGiftSummary } from '../../../lib/gift';
import { groupCode } from '../../../lib/giftMode';
import { useT } from '../../../lib/i18n';
import { colors, fonts, radius, spacing } from '../../../lib/theme';
import { useAsync } from '../../../lib/useAsync';

/**
 * After a gift or redeem code is paid for (straight from the wallet, or after the bank-transfer screen). A redeem code
 * is shown front and centre with a copy button: this is the moment it is meant to be grabbed. The code is read from
 * the server (gift_order_summary), never passed through the route, so it doesn't end up in navigation history.
 */
export default function GiftDoneScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { session, initializing } = useAuth();
  const t = useT();
  const summary = useAsync(() => fetchGiftSummary(id), id ?? '', !initializing && !!session && !!id);

  if (!initializing && !session) return <Redirect href="/sign-in" />;
  const s = summary.data;
  const pack = s ? `${s.productName} ${s.optionLabel}`.trim() : '';
  const finish = () => router.dismissTo('/profile');

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <Column>
          {summary.status === 'loading' && !s && <ActivityIndicator style={styles.loading} color={colors.limeDeep} />}

          {s && s.status !== 'paid' && (
            <Outcome icon="clock" tone="warn" title={t('gift.menu.title')} body={t('gift.done.waiting')} action={t('pay.title')} onAction={() => router.replace({ pathname: '/pay/[id]', params: { id: s.orderId } })} />
          )}

          {s && s.status === 'paid' && s.kind === 'redeem_code' && s.code && (
            <View style={styles.codeScreen}>
              <View style={styles.badge}>
                <FeatherIcon name="key" size={26} color={colors.limeDark} />
              </View>
              <Text style={styles.title} accessibilityRole="header">
                {t('gift.done.codeTitle')}
              </Text>
              <Text style={styles.body}>{t('gift.done.codeBody', { pack })}</Text>

              <View style={styles.codeCard}>
                <Text style={styles.code} selectable accessibilityLabel={s.code.split('').join(' ')} testID="redeem-code">
                  {groupCode(s.code)}
                </Text>
                <CopyButton value={s.code} variant="label" accessibilityLabel={t('gift.done.copy')} style={styles.copy} />
              </View>

              <Text style={styles.note}>{t('gift.done.codeUse')}</Text>
              <Text style={styles.warn}>{t('gift.done.codeSecret')}</Text>
              <Text style={styles.small}>{t('gift.done.expires')}</Text>
              <Button label={t('gift.done.done')} onPress={finish} style={styles.done} />
            </View>
          )}

          {s && s.status === 'paid' && s.kind === 'gift' && (
            <View style={styles.codeScreen}>
              <Avatar name={s.recipientName ?? '?'} uri={s.recipientAvatar} size={72} />
              <Text style={styles.title} accessibilityRole="header">
                {t('gift.done.giftTitle')}
              </Text>
              <Text style={styles.body}>{t('gift.done.giftBody', { pack, name: s.recipientName ?? '' })}</Text>
              <Text style={styles.small}>{t('gift.done.expires')}</Text>
              <Button label={t('gift.done.done')} onPress={finish} style={styles.done} />
            </View>
          )}

          {summary.status !== 'loading' && !s && (
            <Outcome icon="alert-triangle" tone="warn" title={t('gift.menu.title')} body={t('common.loadError')} action={t('gift.done.done')} onAction={finish} />
          )}
        </Column>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  scroll: { flexGrow: 1, paddingVertical: spacing.xl },
  loading: { marginTop: spacing.xl * 2 },
  codeScreen: { alignItems: 'center', paddingTop: spacing.lg },
  badge: { width: 64, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.limeSoft },
  title: { marginTop: spacing.md, fontFamily: fonts.extrabold, fontSize: 24, color: colors.text, textAlign: 'center' },
  body: { marginTop: spacing.xs, fontFamily: fonts.regular, fontSize: 15, lineHeight: 22, color: colors.textMuted, textAlign: 'center' },
  codeCard: {
    alignSelf: 'stretch',
    alignItems: 'center',
    marginTop: spacing.lg,
    paddingVertical: spacing.lg,
    paddingHorizontal: spacing.md,
    borderRadius: radius.xl,
    borderWidth: 2,
    borderColor: colors.lime,
    backgroundColor: colors.limeSoft,
  },
  code: { fontFamily: fonts.extrabold, fontSize: 32, letterSpacing: 3, color: colors.text, textAlign: 'center' },
  copy: { marginTop: spacing.md },
  note: { marginTop: spacing.lg, fontFamily: fonts.medium, fontSize: 14, lineHeight: 20, color: colors.text, textAlign: 'center' },
  warn: { marginTop: spacing.sm, fontFamily: fonts.medium, fontSize: 13.5, lineHeight: 19, color: colors.danger, textAlign: 'center' },
  small: { marginTop: spacing.sm, fontFamily: fonts.regular, fontSize: 12.5, color: colors.textFaint, textAlign: 'center' },
  done: { alignSelf: 'stretch', marginTop: spacing.xl },
});
