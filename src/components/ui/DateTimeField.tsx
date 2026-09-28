import DateTimePicker from '@react-native-community/datetimepicker';
import { createElement, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { formatDateTime } from '../../lib/format';
import { colors, fonts, radius, spacing } from '../../lib/theme';
import { FeatherIcon } from '../art/FeatherIcon';

type Props = {
  label: string;
  /** null = nothing picked. */
  value: Date | null;
  onChange: (value: Date) => void;
  placeholder: string;
  minimumDate?: Date;
  maximumDate?: Date;
};

/** "2026-09-28T14:30" in the device's own time zone, for the web's datetime-local input. */
function toLocalInput(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * A date AND time, picked with the platform's own pickers (never typed): Android shows its date dialog and then its
 * time dialog (it has no combined one); iOS shows one inline date-and-time picker under the field; the web gets the
 * browser's own date-time input. Always in the device's time zone; the value is a real instant (Date).
 */
export function DateTimeField({ label, value, onChange, placeholder, minimumDate, maximumDate }: Props) {
  // Android walks date -> time; `pending` holds the picked day while the time dialog is open.
  const [step, setStep] = useState<'closed' | 'date' | 'time' | 'inline'>('closed');
  const [pending, setPending] = useState<Date | null>(null);
  const shown = value ? formatDateTime(value.toISOString()) : placeholder;

  if (Platform.OS === 'web') {
    return (
      <View style={styles.field}>
        <Text style={styles.label}>{label}</Text>
        <View style={styles.box}>
          <FeatherIcon name="calendar" size={16} color={colors.textMuted} />
          {createElement('input', {
            type: 'datetime-local',
            'aria-label': label,
            value: value ? toLocalInput(value) : '',
            min: minimumDate ? toLocalInput(minimumDate) : undefined,
            max: maximumDate ? toLocalInput(maximumDate) : undefined,
            onChange: (e: { target: { value: string } }) => {
              const d = new Date(e.target.value);
              if (!Number.isNaN(d.getTime())) onChange(d);
            },
            style: { flex: 1, border: 'none', outline: 'none', background: 'transparent', fontSize: 15.5, color: colors.text, fontFamily: 'inherit' },
          })}
        </View>
      </View>
    );
  }

  function open() {
    setStep((s) => (s === 'closed' ? (Platform.OS === 'ios' ? 'inline' : 'date') : 'closed'));
  }

  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <Pressable onPress={open} accessibilityRole="button" accessibilityLabel={`${label}: ${shown}`} style={styles.box}>
        <FeatherIcon name="calendar" size={16} color={colors.textMuted} />
        <Text style={[styles.text, !value && styles.placeholder]}>{shown}</Text>
        <FeatherIcon name={step === 'inline' ? 'chevron-down' : 'chevron-right'} size={16} color={colors.textFaint} />
      </Pressable>

      {step === 'inline' && (
        <DateTimePicker
          value={value ?? minimumDate ?? new Date()}
          mode="datetime"
          display="inline"
          minimumDate={minimumDate}
          maximumDate={maximumDate}
          onChange={(_e, picked) => {
            if (picked) onChange(picked);
          }}
        />
      )}
      {step === 'date' && (
        <DateTimePicker
          value={value ?? minimumDate ?? new Date()}
          mode="date"
          minimumDate={minimumDate}
          maximumDate={maximumDate}
          onChange={(e, picked) => {
            if (e.type === 'set' && picked) {
              setPending(picked);
              setStep('time');
            } else {
              setStep('closed');
            }
          }}
        />
      )}
      {step === 'time' && pending && (
        <DateTimePicker
          value={value ?? pending}
          mode="time"
          onChange={(e, picked) => {
            setStep('closed');
            if (e.type === 'set' && picked) {
              const d = new Date(pending);
              d.setHours(picked.getHours(), picked.getMinutes(), 0, 0);
              onChange(d);
            }
          }}
        />
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
