import { StyleSheet, Text, View } from 'react-native';

import { useT } from '../../lib/i18n';
import { GoogleIcon } from '../art/Icons';
import { SocialButton } from './SocialButton';
import { colors, fonts, spacing } from '../../lib/theme';

type Props = {
  /** Divider text, e.g. "or sign up with". */
  dividerLabel: string;
  onPress: () => void;
  loading?: boolean;
};

/** "or ..." divider plus the Google button. Google is the only third-party sign-in method right now. */
export function SocialAuth({ dividerLabel, onPress, loading }: Props) {
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
          loading={loading}
        />
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
