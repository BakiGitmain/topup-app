import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { colors, fonts, spacing } from '../../lib/theme';
import { Button } from '../ui/Button';

type Props = {
  icon: ReactNode;
  tone?: 'neutral' | 'danger';
  title: string;
  body: string;
  actionLabel: string;
  onAction: () => void;
  actionVariant?: 'solid' | 'outline';
};

/** Shared layout for the error and empty states. */
export function StateMessage({
  icon,
  tone = 'neutral',
  title,
  body,
  actionLabel,
  onAction,
  actionVariant = 'solid',
}: Props) {
  return (
    <View style={styles.wrap} accessibilityRole="alert">
      <View style={[styles.iconWrap, tone === 'danger' && styles.iconDanger]}>
        {icon}
      </View>
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.body}>{body}</Text>
      <Button
        label={actionLabel}
        onPress={onAction}
        variant={actionVariant}
        style={styles.action}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: 'center',
    paddingTop: spacing.xl,
    paddingHorizontal: spacing.md,
  },
  iconWrap: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: colors.limeSoft,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.md,
  },
  iconDanger: { backgroundColor: colors.dangerBg },
  title: {
    fontFamily: fonts.extrabold,
    fontSize: 20,
    color: colors.text,
    letterSpacing: -0.4,
    textAlign: 'center',
  },
  body: {
    marginTop: spacing.sm,
    fontFamily: fonts.regular,
    fontSize: 14.5,
    lineHeight: 21,
    color: colors.textMuted,
    textAlign: 'center',
    maxWidth: 300,
  },
  action: { marginTop: spacing.lg, width: '100%', maxWidth: 300 },
});
