import { useEffect } from 'react';
import { Pressable, StyleSheet, Text, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSequence, withTiming } from 'react-native-reanimated';

import { useT } from '../../lib/i18n';
import { colors, fonts, spacing } from '../../lib/theme';
import { useCopyFeedback } from '../../lib/useCopyFeedback';
import { FeatherIcon } from '../art/FeatherIcon';

type Props = {
  value: string;
  accessibilityLabel: string;
  /** 'icon' = a plain circular icon button (account numbers, order IDs). 'label' = an icon + "Copy" pill (the
   * bigger, more prominent copy actions like the payment account number). Both swap to a checkmark + "Copied" for
   * COPY_REVERT_MS, then revert -- the same one shared feedback pattern everywhere copying happens in the app. */
  variant?: 'icon' | 'label';
  size?: number;
  style?: StyleProp<ViewStyle>;
};

/** One shared copy button for the whole app -- see useCopyFeedback for the timing. Never claims success on a
 * failed clipboard write (the icon/label simply stays as "Copy"). */
export function CopyButton({ value, accessibilityLabel, variant = 'icon', size = 44, style }: Props) {
  const t = useT();
  const { copied, copy } = useCopyFeedback();
  const scale = useSharedValue(1);

  useEffect(() => {
    if (copied) scale.value = withSequence(withTiming(1.15, { duration: 120 }), withTiming(1, { duration: 160 }));
  }, [copied, scale]);

  const pulse = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  if (variant === 'label') {
    return (
      <Pressable
        onPress={() => copy(value)}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        style={({ pressed }) => [styles.pill, pressed && styles.pressed, style]}
      >
        <Animated.View style={[styles.row, pulse]}>
          <FeatherIcon name={copied ? 'check' : 'copy'} size={16} color={colors.limeDark} strokeWidth={2.4} />
          <Text style={styles.pillText}>{t(copied ? 'common.copied' : 'common.copy')}</Text>
        </Animated.View>
      </Pressable>
    );
  }

  return (
    <Pressable
      onPress={() => copy(value)}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      style={({ pressed }) => [styles.circle, { width: size, height: size, borderRadius: size / 2 }, pressed && styles.pressed, style]}
    >
      <Animated.View style={pulse}>
        <FeatherIcon name={copied ? 'check' : 'copy'} size={16} color={colors.limeDark} strokeWidth={2.4} />
      </Animated.View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  circle: { alignItems: 'center', justifyContent: 'center', backgroundColor: colors.limeSoft },
  row: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 44, paddingHorizontal: spacing.md, borderRadius: 22, backgroundColor: colors.limeSoft },
  pillText: { fontFamily: fonts.bold, fontSize: 13.5, color: colors.limeDark },
  pressed: { opacity: 0.8 },
});
