import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';

import { colors, fonts, radius } from '../../lib/theme';

type Props = {
  label: string;
  icon: ReactNode;
  onPress: () => void;
};

export function SocialButton({ label, icon, onPress }: Props) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [styles.button, pressed && styles.pressed]}
    >
      {icon}
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
  label: {
    fontFamily: fonts.semibold,
    fontSize: 15,
    color: colors.text,
  },
});
