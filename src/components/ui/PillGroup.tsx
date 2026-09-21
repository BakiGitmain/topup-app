import * as Haptics from 'expo-haptics';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, fonts, spacing } from '../../lib/theme';

export type PillOption<T extends string> = { id: T; label: string };

type Props<T extends string> = {
  options: readonly PillOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Read out for the group as a whole. */
  label: string;
};

/**
 * A single-choice group of pills that WRAPS onto more rows instead of scrolling or squeezing. Every pill keeps its own
 * width (a pill is never narrower than its text), there is a gap between pills in both directions, and a label too
 * long for the screen is cut with an ellipsis inside its own pill rather than running into its neighbour.
 */
export function PillGroup<T extends string>({ options, value, onChange, label }: Props<T>) {
  return (
    <View style={styles.wrap} accessibilityRole="radiogroup" accessibilityLabel={label}>
      {options.map((option) => {
        const selected = option.id === value;
        return (
          <Pressable
            key={option.id}
            onPress={() => {
              if (selected) return;
              if (Platform.OS !== 'web') Haptics.selectionAsync().catch(() => {});
              onChange(option.id);
            }}
            accessibilityRole="radio"
            accessibilityState={{ checked: selected }}
            accessibilityLabel={option.label}
            style={[styles.pill, selected && styles.pillOn]}
          >
            <Text style={[styles.text, selected && styles.textOn]} numberOfLines={1} ellipsizeMode="tail">
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', flexWrap: 'wrap', columnGap: spacing.sm, rowGap: spacing.sm },
  pill: {
    minHeight: 44,
    maxWidth: '100%',
    flexShrink: 1,
    paddingHorizontal: spacing.md,
    borderRadius: 22,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pillOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  text: { flexShrink: 1, fontFamily: fonts.semibold, fontSize: 14, color: colors.textMuted },
  textOn: { color: colors.primaryText },
});
