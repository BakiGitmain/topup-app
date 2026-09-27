import * as Haptics from 'expo-haptics';
import { Platform, Pressable, StyleSheet, Text } from 'react-native';

import { useT, useI18n } from '../../lib/i18n';
import { colors, fonts, radius } from '../../lib/theme';
import { FeatherIcon } from '../art/FeatherIcon';

const HEIGHT = 34;

/**
 * The header's language switch: a globe icon and the label for the language a tap will switch TO -- in English,
 * it reads "አማ" (tap to go Amharic); in Amharic, it reads "EN" (tap to go English). Not the current language: a
 * "tap to switch to X" affordance, not a status readout. One tap flips the whole app (no navigation, the choice is
 * remembered on this device). Replaces the old two-segment አማ|EN pill in this header specifically -- LanguagePill
 * (the two-segment version, which shows both languages at once with the active one highlighted) is unchanged and
 * still used on other screens.
 * `compact`: true hides the text label, icon only -- for the narrowest phones (see ShopHeader).
 */
export function LanguageButton({ compact = false }: { compact?: boolean }) {
  const { language, setLanguage } = useI18n();
  const t = useT();
  const next = language === 'am' ? 'en' : 'am';

  function toggle() {
    if (Platform.OS !== 'web') Haptics.selectionAsync().catch(() => {});
    setLanguage(next);
  }

  return (
    <Pressable
      onPress={toggle}
      hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
      accessibilityRole="button"
      accessibilityLabel={t('header.changeLanguage')}
      accessibilityLiveRegion="polite"
      style={({ pressed }) => [styles.button, compact && styles.buttonCompact, pressed && styles.pressed]}
    >
      <FeatherIcon name="globe" size={16} color={colors.text} strokeWidth={1.8} />
      {!compact && <Text style={styles.text}>{next === 'am' ? 'አማ' : 'EN'}</Text>}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: HEIGHT,
    paddingHorizontal: 10,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bg,
  },
  buttonCompact: { paddingHorizontal: 0, width: HEIGHT, justifyContent: 'center' },
  pressed: { opacity: 0.6 },
  text: { fontFamily: fonts.bold, fontSize: 13, color: colors.text },
});
