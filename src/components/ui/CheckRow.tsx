import * as Haptics from 'expo-haptics';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, fonts, radius, spacing } from '../../lib/theme';
import { FeatherIcon } from '../art/FeatherIcon';

type Props = {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
};

/** A labelled checkbox with a touch target well over 44pt. */
export function CheckRow({ checked, onChange, label }: Props) {
  return (
    <Pressable
      onPress={() => {
        if (Platform.OS !== 'web') Haptics.selectionAsync().catch(() => {});
        onChange(!checked);
      }}
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      aria-checked={checked}
      accessibilityLabel={label}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <View style={[styles.box, checked && styles.boxOn]}>
        {checked && <FeatherIcon name="check" size={16} color={colors.text} strokeWidth={3} />}
      </View>
      <Text style={styles.label}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm + 4,
    minHeight: 48,
    paddingVertical: spacing.sm,
  },
  pressed: { opacity: 0.8 },
  box: {
    width: 26,
    height: 26,
    marginTop: 1,
    borderRadius: radius.sm - 2,
    borderWidth: 2,
    borderColor: colors.borderStrong,
    backgroundColor: colors.bg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  boxOn: { backgroundColor: colors.lime, borderColor: colors.limeDeep },
  label: { flex: 1, fontFamily: fonts.medium, fontSize: 14.5, lineHeight: 21, color: colors.text },
});
