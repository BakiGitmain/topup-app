import { Redirect, router } from 'expo-router';
import { Linking, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { CARD_RADIUS, SettingsRow } from '../../components/profile/SettingsMenu';
import { Button } from '../../components/ui/Button';
import { ScreenHeader } from '../../components/ui/ScreenHeader';
import { Column } from '../../components/ui/TabScroll';
import { useAuth } from '../../lib/auth';
import { PRIVACY_POLICY_URL, SUPPORT } from '../../lib/config';
import { useT } from '../../lib/i18n';
import { colors, fonts, spacing } from '../../lib/theme';

/**
 * The published privacy policy, and a support-routed account deletion request (support deletes by hand; there is
 * no self-service deletion). Each part shows only once its link is filled in (lib/config.ts): nothing here points
 * at placeholder text or a dead link.
 */
export default function PrivacyScreen() {
  const { session, initializing } = useAuth();
  const t = useT();
  const insets = useSafeAreaInsets();

  if (!initializing && !session) return <Redirect href="/sign-in" />;

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + spacing.xxl }}>
        <Column>
          <ScreenHeader title={t('settings.privacy')} onBack={() => (router.canGoBack() ? router.back() : router.replace('/profile'))} />

          {PRIVACY_POLICY_URL ? (
            <View style={styles.block}>
              <SettingsRow icon="file-text" label={t('privacy.policy')} onPress={() => Linking.openURL(PRIVACY_POLICY_URL)} />
            </View>
          ) : null}

          {SUPPORT.url ? (
            <View style={[styles.block, styles.card]}>
              <Text style={styles.title}>{t('privacy.deleteAccount')}</Text>
              <Text style={styles.body}>{t('privacy.deleteBody')}</Text>
              <Button label={SUPPORT.label || t('topup.contact')} variant="outline" onPress={() => Linking.openURL(SUPPORT.url)} />
            </View>
          ) : null}
        </Column>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  block: { marginTop: spacing.sm + 4 },
  card: { padding: spacing.md, borderRadius: CARD_RADIUS, backgroundColor: colors.surface, gap: spacing.sm + 4 },
  title: { fontFamily: fonts.bold, fontSize: 15, color: colors.text },
  body: { fontFamily: fonts.regular, fontSize: 14, lineHeight: 20, color: colors.textMuted },
});
