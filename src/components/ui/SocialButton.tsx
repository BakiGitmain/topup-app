import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text } from 'react-native';

import { colors, fonts, radius } from '../../lib/theme';

type Props = {
  label: string;
  icon: ReactNode;
  onPress: () => void;
  loading?: boolean;
  disabled?: boolean;
};

export function SocialButton({ label, icon, onPress, loading, disabled }: Props) {
  const blocked = !!loading || !!disabled;
  return (
    <Pressable
      onPress={onPress}
      disabled={blocked}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: blocked, busy: !!loading }}
      style={({ pressed }) => [styles.button, blocked && styles.blocked, pressed && !blocked && styles.pressed]}
    >
      {loading ? <ActivityIndicator size="small" color={colors.text} /> : icon}
      <Text style={styles.label}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    alignSelf: 'stretch',
    height: 54,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    borderRadius: radius.pill,
    borderWidth: 1.5,
    borderColor: colors.borderStrong,
    backgroundColor: colors.bg,
  },
  pressed: { backgroundColor: colors.surface },
  blocked: { opacity: 0.6 },
  label: {
    fontFamily: fonts.semibold,
    fontSize: 15,
    color: colors.text,
  },
});
