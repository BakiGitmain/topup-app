import { StyleSheet, Text, View } from 'react-native';

import { colors, fonts, radius, spacing } from '../../lib/theme';

export function ErrorBanner({ message }: { message: string }) {
  return (
    <View style={styles.box} accessibilityRole="alert">
      <Text style={styles.text}>{message}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    backgroundColor: colors.dangerBg,
    borderWidth: 1,
    borderColor: colors.dangerBorder,
    borderRadius: radius.sm,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  text: {
    fontFamily: fonts.medium,
    color: colors.danger,
    fontSize: 14,
    lineHeight: 20,
  },
});
