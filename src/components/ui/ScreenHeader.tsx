import { router } from 'expo-router';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, fonts, spacing } from '../../lib/theme';
import { BackIcon } from '../art/Icons';

type Props = {
  title: string;
  /** Where the arrow goes. Defaults to going back, or to the shop if there's nothing to go back to. */
  onBack?: () => void;
  right?: ReactNode;
};

/** Title row for screens that sit on top of the tabs. */
export function ScreenHeader({ title, onBack, right }: Props) {
  function back() {
    if (onBack) onBack();
    else if (router.canGoBack()) router.back();
    else router.replace('/shop');
  }

  return (
    <View style={styles.row}>
      <Pressable
        onPress={back}
        hitSlop={12}
        accessibilityRole="button"
        accessibilityLabel="Go back"
        style={styles.back}
      >
        <BackIcon size={22} color={colors.text} />
      </Pressable>
      <Text style={styles.title} numberOfLines={1} accessibilityRole="header">
        {title}
      </Text>
      <View style={styles.right}>{right}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingTop: spacing.md,
    paddingBottom: spacing.md,
  },
  back: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
  },
  title: {
    flex: 1,
    fontFamily: fonts.extrabold,
    fontSize: 22,
    color: colors.text,
    letterSpacing: -0.5,
  },
  right: { minWidth: 40, alignItems: 'flex-end' },
});
