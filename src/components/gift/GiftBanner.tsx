import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useT } from '../../lib/i18n';
import type { GiftTarget } from '../../lib/giftMode';
import { colors, fonts, radius, spacing } from '../../lib/theme';
import { FeatherIcon } from '../art/FeatherIcon';

/**
 * Says, on every catalog screen while gifting, what is being bought and for whom, and that no player ID is asked now.
 * The cross leaves gift mode and goes back to the gift menu.
 */
export function GiftBanner({ target }: { target: GiftTarget }) {
  const t = useT();
  const title = target.kind === 'gift' ? t('gift.banner.gift', { name: target.toName || '…' }) : t('gift.banner.code');
  return (
    <View style={styles.banner} accessibilityRole="summary">
      <View style={styles.icon}>
        <FeatherIcon name={target.kind === 'gift' ? 'gift' : 'key'} size={18} color={colors.limeDark} />
      </View>
      <View style={styles.text}>
        <Text style={styles.title} numberOfLines={1}>
          {title}
        </Text>
        <Text style={styles.hint}>{t('gift.banner.hint')}</Text>
      </View>
      <Pressable
        onPress={() => router.dismissTo('/gift')}
        accessibilityRole="button"
        accessibilityLabel={t('gift.banner.cancel')}
        hitSlop={8}
        style={({ pressed }) => [styles.close, pressed && { opacity: 0.6 }]}
      >
        <FeatherIcon name="x" size={18} color={colors.textMuted} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm + 2,
    padding: spacing.sm + 4,
    borderRadius: radius.lg,
    backgroundColor: colors.limeSoft,
  },
  icon: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg },
  text: { flex: 1, minWidth: 0 },
  title: { fontFamily: fonts.bold, fontSize: 15, color: colors.text },
  hint: { marginTop: 2, fontFamily: fonts.regular, fontSize: 12.5, lineHeight: 17, color: colors.limeDark },
  close: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
});
