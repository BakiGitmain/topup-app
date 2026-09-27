import { Redirect, router } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { FeatherIcon, type FeatherName } from '../components/art/FeatherIcon';
import { ScreenHeader } from '../components/ui/ScreenHeader';
import { Column } from '../components/ui/TabScroll';
import { useAuth } from '../lib/auth';
import { giftParams } from '../lib/giftMode';
import { useT } from '../lib/i18n';
import type { StringKey } from '../lib/strings';
import { colors, fonts, radius, spacing } from '../lib/theme';

/** Profile > Gift: send a pack to a friend, or buy a redeem code to hand to anyone. */
export default function GiftMenuScreen() {
  const { session, initializing } = useAuth();
  const t = useT();
  if (!initializing && !session) return <Redirect href="/sign-in" />;

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <Column>
          <ScreenHeader title={t('gift.menu.title')} onBack={() => router.replace('/profile')} />
          <Text style={styles.lead}>{t('gift.menu.body')}</Text>
          <Option
            icon="send"
            title="gift.send.title"
            body="gift.send.body"
            onPress={() => router.push('/gift/send')}
          />
          <Option
            icon="key"
            title="gift.code.title"
            body="gift.code.body"
            onPress={() => router.push({ pathname: '/gift/shop', params: giftParams({ kind: 'redeem_code', to: null, toName: null }) })}
          />
        </Column>
      </ScrollView>
    </SafeAreaView>
  );
}

function Option({ icon, title, body, onPress }: { icon: FeatherName; title: StringKey; body: StringKey; onPress: () => void }) {
  const t = useT();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${t(title)}. ${t(body)}`}
      style={({ pressed }) => [styles.option, pressed && styles.pressed]}
    >
      <View style={styles.optionIcon}>
        <FeatherIcon name={icon} size={22} color={colors.limeDark} />
      </View>
      <View style={styles.optionText}>
        <Text style={styles.optionTitle}>{t(title)}</Text>
        <Text style={styles.optionBody}>{t(body)}</Text>
      </View>
      <FeatherIcon name="chevron-right" size={18} color={colors.textFaint} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  scroll: { paddingBottom: spacing.xl },
  lead: { marginTop: spacing.xs, marginBottom: spacing.lg, fontFamily: fonts.regular, fontSize: 14.5, lineHeight: 21, color: colors.textMuted },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
    marginBottom: spacing.sm + 4,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
  },
  pressed: { backgroundColor: colors.border },
  optionIcon: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.limeSoft },
  optionText: { flex: 1, minWidth: 0 },
  optionTitle: { fontFamily: fonts.bold, fontSize: 16, color: colors.text },
  optionBody: { marginTop: 2, fontFamily: fonts.regular, fontSize: 13.5, lineHeight: 19, color: colors.textMuted },
});
