import * as Haptics from 'expo-haptics';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { useI18n } from '../../lib/i18n';
import { colors, fonts } from '../../lib/theme';

/**
 * The language switch: a small አማ | EN pill with the current language filled in. One tap switches the whole app at once (no
 * navigation) and the choice is remembered on this device. It sits in the header of every main screen, not in settings.
 * Both labels are written in their own language, so it reads the same whichever one is active.
 */
export function LanguagePill() {
  const { language, setLanguage } = useI18n();
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
      accessibilityLabel={language === 'am' ? 'Language: Amharic. Switch to English' : 'Language: English. Switch to Amharic'}
      accessibilityLiveRegion="polite"
      style={({ pressed }) => [styles.pill, pressed && { opacity: 0.7 }]}
    >
      <View style={[styles.seg, language === 'am' && styles.segOn]}>
        <Text style={[styles.text, language === 'am' && styles.textOn]} allowFontScaling={false}>
          አማ
        </Text>
      </View>
      <View style={[styles.seg, language === 'en' && styles.segOn]}>
        <Text style={[styles.text, language === 'en' && styles.textOn]} allowFontScaling={false}>
          EN
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 32,
    padding: 3,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  seg: { minWidth: 30, height: 26, paddingHorizontal: 7, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  segOn: { backgroundColor: colors.primary },
  text: { fontFamily: fonts.bold, fontSize: 12.5, color: colors.textMuted, includeFontPadding: false },
  textOn: { color: colors.primaryText },
});
