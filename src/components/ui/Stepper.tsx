import * as Haptics from 'expo-haptics';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, fonts, radius, spacing } from '../../lib/theme';
import { FeatherIcon } from '../art/FeatherIcon';

type Props = {
  label: string;
  value: number;
  min: number;
  max: number;
  /** How far one tap moves (e.g. the team size, so a player count stays a multiple of it). */
  step?: number;
  onChange: (value: number) => void;
  /** A line under the row, e.g. "8 teams x 4 players = 32 players". */
  hint?: string;
};

/** A number picked with - / + (never typed), always inside min..max. */
export function Stepper({ label, value, min, max, step = 1, onChange, hint }: Props) {
  const canDown = value - step >= min;
  const canUp = value + step <= max;

  function move(delta: number) {
    const next = value + delta;
    if (next < min || next > max) return;
    if (Platform.OS !== 'web') Haptics.selectionAsync().catch(() => {});
    onChange(next);
  }

  return (
    <View style={styles.field}>
      <View style={styles.row}>
        <Text style={styles.label} numberOfLines={2}>
          {label}
        </Text>
        <View style={styles.control} accessibilityRole="adjustable" accessibilityLabel={label} accessibilityValue={{ min, max, now: value }}>
          <Pressable
            onPress={() => move(-step)}
            disabled={!canDown}
            hitSlop={6}
            accessibilityRole="button"
            accessibilityLabel={`${label} -`}
            style={({ pressed }) => [styles.button, !canDown && styles.off, pressed && styles.pressed]}
          >
            <FeatherIcon name="minus" size={18} color={colors.text} />
          </Pressable>
          <Text style={styles.value}>{value}</Text>
          <Pressable
            onPress={() => move(step)}
            disabled={!canUp}
            hitSlop={6}
            accessibilityRole="button"
            accessibilityLabel={`${label} +`}
            style={({ pressed }) => [styles.button, !canUp && styles.off, pressed && styles.pressed]}
          >
            <FeatherIcon name="plus" size={18} color={colors.text} />
          </Pressable>
        </View>
      </View>
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  field: { marginBottom: spacing.md },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  label: { flex: 1, fontFamily: fonts.semibold, fontSize: 14.5, color: colors.text },
  control: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  button: {
    width: 40,
    height: 40,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  pressed: { backgroundColor: colors.border },
  off: { opacity: 0.35 },
  value: { minWidth: 36, textAlign: 'center', fontFamily: fonts.extrabold, fontSize: 18, color: colors.text },
  hint: { marginTop: 6, fontFamily: fonts.medium, fontSize: 13, color: colors.textMuted },
});
