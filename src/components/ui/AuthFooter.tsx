import { Link, type Href } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import { colors, fonts, spacing } from '../../lib/theme';

type Props = {
  prompt: string;
  linkLabel: string;
  href: Href;
};

/** "Already have an account? Login" style footer. */
export function AuthFooter({ prompt, linkLabel, href }: Props) {
  return (
    <View style={styles.footer}>
      <Text style={styles.text}>{prompt} </Text>
      <Link href={href} replace style={styles.link}>
        {linkLabel}
      </Link>
    </View>
  );
}

const styles = StyleSheet.create({
  footer: {
    flexDirection: 'row',
    justifyContent: 'center',
    marginTop: spacing.lg,
  },
  text: {
    fontFamily: fonts.regular,
    fontSize: 14,
    color: colors.textMuted,
  },
  link: { fontFamily: fonts.bold, fontSize: 14, color: colors.limeInk },
});
