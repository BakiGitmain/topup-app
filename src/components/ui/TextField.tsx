import { useState, type ReactNode } from 'react';
import {
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type ViewStyle,
} from 'react-native';

import { colors, fonts, radius, spacing } from '../../lib/theme';

type Props = TextInputProps & {
  label: string;
  error?: string | null;
  right?: ReactNode;
  /** Extra style for the outlined box, e.g. a taller box for a multi-line field. */
  boxStyle?: StyleProp<ViewStyle>;
};

export function TextField({
  label,
  error,
  right,
  boxStyle,
  onFocus,
  onBlur,
  style,
  ...inputProps
}: Props) {
  const [focused, setFocused] = useState(false);

  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <View
        style={[
          styles.box,
          focused && styles.boxFocused,
          !!error && styles.boxError,
          boxStyle,
        ]}
      >
        <TextInput
          {...inputProps}
          accessibilityLabel={inputProps.accessibilityLabel ?? label}
          style={[styles.input, style]}
          placeholderTextColor={colors.textFaint}
          onFocus={(e) => {
            setFocused(true);
            onFocus?.(e);
          }}
          onBlur={(e) => {
            setFocused(false);
            onBlur?.(e);
          }}
        />
        {right}
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  field: { marginBottom: spacing.md },
  label: {
    fontFamily: fonts.semibold,
    fontSize: 13.5,
    color: colors.limeInk,
    marginBottom: 7,
  },
  box: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 52,
    borderWidth: 1.5,
    borderColor: colors.borderStrong,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    backgroundColor: colors.bg,
  },
  boxFocused: { borderColor: colors.limeDeep },
  boxError: { borderColor: colors.danger },
  input: {
    flex: 1,
    height: '100%',
    fontFamily: fonts.regular,
    fontSize: 15.5,
    color: colors.text,
  },
  error: {
    marginTop: 6,
    fontFamily: fonts.medium,
    fontSize: 12.5,
    color: colors.danger,
  },
});
