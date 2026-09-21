import { StyleSheet, Text, View } from 'react-native';

import { colors, fonts, spacing } from '../../lib/theme';
import { FeatherIcon } from '../art/FeatherIcon';
import { Button } from '../ui/Button';

/** The end state of a payment or deposit: a big icon, a title, one paragraph, one button. */
export function Outcome({
  icon,
  tone,
  title,
  body,
  action,
  onAction,
}: {
  icon: 'check-circle' | 'alert-triangle' | 'clock';
  tone: 'ok' | 'warn';
  title: string;
  body: string;
  action: string;
  onAction: () => void;
}) {
  return (
    <View style={styles.outcome} accessibilityRole="alert">
      <View style={[styles.icon, tone === 'ok' ? styles.iconOk : styles.iconWarn]}>
        <FeatherIcon name={icon} size={34} color={tone === 'ok' ? colors.limeDark : '#8A5A00'} />
      </View>
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.body}>{body}</Text>
      <Button label={action} onPress={onAction} style={styles.button} />
    </View>
  );
}

const styles = StyleSheet.create({
  outcome: { alignItems: 'center', paddingTop: spacing.xl },
  icon: { width: 84, height: 84, borderRadius: 42, alignItems: 'center', justifyContent: 'center', marginBottom: spacing.lg },
  iconOk: { backgroundColor: colors.limeSoft },
  iconWarn: { backgroundColor: '#FFF1CC' },
  title: { fontFamily: fonts.extrabold, fontSize: 24, color: colors.text, textAlign: 'center', letterSpacing: -0.5 },
  body: { marginTop: spacing.sm, maxWidth: 320, fontFamily: fonts.medium, fontSize: 15, lineHeight: 22, color: colors.textMuted, textAlign: 'center' },
  button: { alignSelf: 'stretch', marginTop: spacing.lg },
});
