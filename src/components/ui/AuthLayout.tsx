import { router } from 'expo-router';
import type { ReactNode } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { BackIcon } from '../art/Icons';
import { WaveHeader } from '../art/WaveHeader';
import { LanguagePill } from './LanguagePill';
import { colors, fonts, spacing } from '../../lib/theme';

type Props = {
  title: string;
  subtitle?: string;
  /** Optional artwork shown between the heading and the form. */
  illustration?: ReactNode;
  children: ReactNode;
};

function goBack() {
  if (router.canGoBack()) router.back();
  else router.replace('/splash');
}

/**
 * Shared shell for the sign-in and sign-up screens: wavy header with a back
 * button, centered heading, then the form. Scrolls so the form stays
 * reachable when the keyboard is open.
 */
export function AuthLayout({ title, subtitle, illustration, children }: Props) {
  const insets = useSafeAreaInsets();

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        style={styles.flex}
        contentContainerStyle={[
          styles.scroll,
          { paddingBottom: insets.bottom + spacing.lg },
        ]}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        bounces={false}
      >
        <WaveHeader />
        <View style={[styles.langCorner, { top: insets.top + 10 }]}>
          <LanguagePill />
        </View>

        <View style={styles.body}>
          <Text style={styles.title} accessibilityRole="header">
            {title}
          </Text>
          {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
          {illustration ? (
            <View style={styles.illustration}>{illustration}</View>
          ) : null}
          <View style={styles.form}>{children}</View>
        </View>
      </ScrollView>

      <Pressable
        onPress={goBack}
        hitSlop={12}
        accessibilityRole="button"
        accessibilityLabel="Go back"
        style={[styles.back, { top: insets.top + spacing.sm }]}
      >
        <BackIcon color={colors.text} />
      </Pressable>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  langCorner: { position: 'absolute', right: spacing.lg, zIndex: 10 },
  flex: { flex: 1, backgroundColor: colors.bg },
  scroll: { flexGrow: 1 },
  back: {
    position: 'absolute',
    left: spacing.md,
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  body: {
    width: '100%',
    maxWidth: 440,
    alignSelf: 'center',
    paddingHorizontal: spacing.lg,
    marginTop: -spacing.sm,
  },
  title: {
    fontFamily: fonts.extrabold,
    fontSize: 32,
    color: colors.limeInk,
    letterSpacing: -0.8,
    textAlign: 'center',
  },
  subtitle: {
    marginTop: 6,
    fontFamily: fonts.medium,
    fontSize: 15,
    color: colors.textMuted,
    textAlign: 'center',
  },
  illustration: { alignItems: 'center', marginTop: spacing.md },
  form: { marginTop: spacing.lg },
});
