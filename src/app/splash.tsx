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

import { HeroTopUp } from '../components/art/HeroTopUp';
import { Button } from '../components/ui/Button';
import { LanguagePill } from '../components/ui/LanguagePill';
import { useT } from '../lib/i18n';
import { colors, fonts, spacing } from '../lib/theme';

export default function SplashScreen() {
  const t = useT();
  const { width } = useWindowDimensions();
  const [fade] = useState(() => new Animated.Value(0));
  const [float] = useState(() => new Animated.Value(0));

  useEffect(() => {
    Animated.timing(fade, {
      toValue: 1,
      duration: 600,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();

    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(float, {
          toValue: -10,
          duration: 2200,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(float, {
          toValue: 0,
          duration: 2200,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
      ])
    );
    loop.start();

    return () => loop.stop();
  }, [fade, float]);

  // A big arch, like the reference: radius = half the (capped) screen width.
  const archRadius = Math.min(width, 520) / 2;

  return (
    <View style={styles.root}>
      <View style={{ position: 'absolute', top: 48, right: spacing.lg, zIndex: 10 }}>
        <LanguagePill />
      </View>
      <View
        style={[
          styles.arch,
          { borderTopLeftRadius: archRadius, borderTopRightRadius: archRadius },
        ]}
      />

      <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
        <Animated.View style={[styles.center, { opacity: fade }]}>
          <Animated.View style={{ transform: [{ translateY: float }] }}>
            <HeroTopUp size={250} />
          </Animated.View>

          <Text style={styles.brand}>
            topup<Text style={styles.brandDot}>.</Text>
          </Text>
          <Text style={styles.tagline}>
            {t('splash.tagline')}
          </Text>
        </Animated.View>

        <Button
          label={t('splash.continue')}
          variant="dark"
          onPress={() => router.replace('/welcome')}
          style={styles.cta}
        />
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  arch: {
    position: 'absolute',
    top: '14%',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: colors.limeSoft,
  },
  safe: {
    flex: 1,
    width: '100%',
    maxWidth: 440,
    alignSelf: 'center',
    paddingHorizontal: spacing.lg,
  },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  brand: {
    marginTop: spacing.md,
    fontFamily: fonts.extrabold,
    fontSize: 44,
    color: colors.text,
    letterSpacing: -1.5,
  },
  brandDot: { color: colors.limeDeep },
  tagline: {
    marginTop: spacing.sm,
    fontFamily: fonts.medium,
    fontSize: 15,
    lineHeight: 22,
    color: colors.textMuted,
    textAlign: 'center',
  },
  cta: { marginBottom: spacing.md },
});
