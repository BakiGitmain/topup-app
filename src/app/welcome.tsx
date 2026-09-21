import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import {
  Animated,
  Easing,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { PayIllustration } from '../components/art/Illustrations';
import { WaveHeader } from '../components/art/WaveHeader';
import { Button } from '../components/ui/Button';
import { LanguagePill } from '../components/ui/LanguagePill';
import { useT } from '../lib/i18n';
import { colors, fonts, spacing } from '../lib/theme';

export default function WelcomeScreen() {
  const t = useT();
  const { height } = useWindowDimensions();
  const [fade] = useState(() => new Animated.Value(0));
  const [rise] = useState(() => new Animated.Value(20));

  useEffect(() => {
    Animated.parallel([
      Animated.timing(fade, {
        toValue: 1,
        duration: 520,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(rise, {
        toValue: 0,
        duration: 520,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
    ]).start();
  }, [fade, rise]);

  // Keep the artwork proportional so short phones don't push the buttons off.
  const artWidth = Math.min(340, Math.round(height * 0.4));

  return (
    <View style={styles.root}>
      <WaveHeader />
      <View style={styles.langCorner}>
        <LanguagePill />
      </View>

      <SafeAreaView style={styles.safe} edges={['bottom']}>
        <Animated.View
          style={[
            styles.content,
            { opacity: fade, transform: [{ translateY: rise }] },
          ]}
        >
          <Text style={styles.title} accessibilityRole="header">
            {t('auth.welcome')}
          </Text>
          <Text style={styles.subtitle}>
            {t('auth.welcomeSub')}
          </Text>
          <View style={styles.art}>
            <PayIllustration width={artWidth} />
          </View>
        </Animated.View>

        <View style={styles.actions}>
          <Button label={t('auth.signUp')} onPress={() => router.push('/sign-up')} />
          <Button
            label={t('auth.login')}
            variant="outline"
            onPress={() => router.push('/sign-in')}
          />
        </View>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  langCorner: { position: 'absolute', top: 44, right: spacing.lg, zIndex: 10 },
  root: { flex: 1, backgroundColor: colors.bg },
  safe: {
    flex: 1,
    width: '100%',
    maxWidth: 440,
    alignSelf: 'center',
    paddingHorizontal: spacing.lg,
  },
  content: { flex: 1, alignItems: 'center' },
  title: {
    fontFamily: fonts.extrabold,
    fontSize: 36,
    color: colors.limeInk,
    letterSpacing: -1,
    textAlign: 'center',
  },
  subtitle: {
    marginTop: 6,
    maxWidth: 300,
    fontFamily: fonts.medium,
    fontSize: 15.5,
    lineHeight: 22,
    color: colors.textMuted,
    textAlign: 'center',
  },
  art: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  actions: { gap: spacing.sm + 4, paddingBottom: spacing.md },
});
