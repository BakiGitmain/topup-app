import DateTimePicker from '@react-native-community/datetimepicker';
import { useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { formatDate } from '../../lib/format';
import { colors, fonts, radius, spacing } from '../../lib/theme';
import { FeatherIcon } from '../art/FeatherIcon';

type Props = {
  label: string;
  /** null = nothing picked. */
  value: Date | null;
  onChange: (value: Date | null) => void;
  placeholder: string;
  minimumDate?: Date;
  disabled?: boolean;
};

/**
 * A date-only field backed by the platform's native picker (a calendar on Android, a wheel/inline calendar on iOS)
 * instead of free-typed text, so an admin can't type an unparseable or malformed date. Tapping the field opens the
 * picker; an "x" clears back to "no date" once one is set. Not yet seen on a device (this environment can't run
 * one) -- the native picker's exact look on each platform is unverified, only that it's wired the way the library's
 * own docs describe.
 */
export function DateField({ label, value, onChange, placeholder, minimumDate, disabled }: Props) {
  const [open, setOpen] = useState(false);

  function handleChange(event: { type: string }, picked?: Date) {
    // Android: the dialog closes itself and reports 'dismissed' on Cancel. iOS: the inline picker stays open, so
    // there is no 'dismissed' to react to here -- closing it is the field's own onPress toggle instead.
    if (Platform.OS === 'android') setOpen(false);
    if (event.type === 'set' && picked) onChange(picked);
  }

  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <Pressable
        onPress={() => !disabled && setOpen((o) => !o)}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={value ? formatDate(value.toISOString()) : placeholder}
        style={styles.box}
      >
        <FeatherIcon name="clock" size={16} color={colors.textMuted} />
        <Text style={[styles.text, !value && styles.placeholder]}>{value ? formatDate(value.toISOString()) : placeholder}</Text>
        {value && (
          <Pressable
            onPress={() => {
              onChange(null);
              setOpen(false);
            }}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Clear date"
          >
            <FeatherIcon name="x" size={16} color={colors.textMuted} />
          </Pressable>
        )}
      </Pressable>
      {open && (
        <DateTimePicker value={value ?? new Date()} mode="date" minimumDate={minimumDate} display={Platform.OS === 'ios' ? 'inline' : 'default'} onChange={handleChange} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  field: { marginBottom: spacing.md },
  label: { fontFamily: fonts.semibold, fontSize: 13.5, color: colors.limeInk, marginBottom: 7 },
  box: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    height: 52,
    borderWidth: 1.5,
    borderColor: colors.borderStrong,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    backgroundColor: colors.bg,
  },
  text: { flex: 1, fontFamily: fonts.regular, fontSize: 15.5, color: colors.text },
  placeholder: { color: colors.textFaint },
});
