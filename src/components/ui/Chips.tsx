import * as Haptics from 'expo-haptics';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { colors, fonts, spacing } from '../../lib/theme';

export type ChipOption<T extends string> = { id: T; label: string; count?: number };

type Props<T extends string> = {
  options: ChipOption<T>[];
  value: T;
  onChange: (value: T) => void;
};

/** Horizontal pill selector, used for filters. */
export function Chips<T extends string>({ options, value, onChange }: Props<T>) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.row}
      keyboardShouldPersistTaps="handled"
    >
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
            accessibilityRole="button"
            accessibilityState={{ selected }}
            style={[styles.chip, selected && styles.chipSelected]}
          >
            <Text style={[styles.label, selected && styles.labelSelected]}>{option.label}</Text>
            {option.count ? (
              <View style={[styles.count, selected && styles.countSelected]}>
                <Text style={[styles.countText, selected && styles.countTextSelected]}>
                  {option.count}
                </Text>
              </View>
            ) : null}
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  row: { gap: spacing.sm - 2, paddingRight: spacing.lg },
  chip: {
    minHeight: 44,
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 13,
    borderRadius: 22,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipSelected: { backgroundColor: colors.primary },
  label: { fontFamily: fonts.semibold, fontSize: 14, color: colors.textMuted },
  labelSelected: { color: colors.primaryText },
  count: {
    minWidth: 20,
    height: 20,
    paddingHorizontal: 6,
    borderRadius: 10,
    backgroundColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  countSelected: { backgroundColor: colors.lime },
  countText: { fontFamily: fonts.bold, fontSize: 11.5, color: colors.textMuted },
  countTextSelected: { color: colors.primary },
});
