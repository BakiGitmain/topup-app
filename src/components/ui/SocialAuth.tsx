import { Platform, StyleSheet, Text, View } from 'react-native';

import { useT } from '../../lib/i18n';
import { AppleIcon, GoogleIcon } from '../art/Icons';
import { SocialButton } from './SocialButton';
import { colors, fonts, spacing } from '../../lib/theme';

type Props = {
  /** Divider text, e.g. "or sign up with". */
  dividerLabel: string;
  onPress: () => void;
};

/** "or ..." divider plus the Google button (and Apple on iOS). */
export function SocialAuth({ dividerLabel, onPress }: Props) {
  const t = useT();
  return (
    <View>
      <View style={styles.dividerRow}>
        <View style={styles.divider} />
        <Text style={styles.dividerText}>{dividerLabel}</Text>
        <View style={styles.divider} />
      </View>

      <View style={styles.buttons}>
        <SocialButton
          label={t('auth.google')}
          icon={<GoogleIcon />}
          onPress={onPress}
        />
        {Platform.OS === 'ios' ? (
          <SocialButton
            label={t('auth.apple')}
            icon={<AppleIcon color={colors.text} />}
            onPress={onPress}
          />
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  dividerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: spacing.lg,
    gap: spacing.md,
  },
  divider: { flex: 1, height: 1, backgroundColor: colors.border },
  dividerText: {
    fontFamily: fonts.regular,
    fontSize: 13,
    color: colors.textMuted,
  },
  buttons: { gap: spacing.sm },
});
