import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
} from 'react-native-reanimated';

import { GoogleIcon } from '../components/art/Icons';
import { OnboardingBackdrop } from '../components/onboarding/OnboardingBackdrop';
import { OnboardingCarousel, OnboardingDots } from '../components/onboarding/OnboardingCarousel';
import { COMPACT_HEIGHT } from '../components/onboarding/OnboardingSlide';
import { ONBOARDING_SLIDES } from '../components/onboarding/slides';
import { Button } from '../components/ui/Button';
import { ErrorBanner } from '../components/ui/ErrorBanner';
import { LanguagePill } from '../components/ui/LanguagePill';
import { SocialButton } from '../components/ui/SocialButton';
import { useAuth } from '../lib/auth';
import { useT } from '../lib/i18n';
import { useReducedMotion } from '../lib/useReducedMotion';
import { colors, fonts, spacing } from '../lib/theme';

const PALETTES = ONBOARDING_SLIDES.map((s) => s.backdrop);
// The carousel settles in first, then the sign-in actions rise up under it.
const HERO_MS = 480;
const ACTIONS_DELAY = HERO_MS + 180;
const EASE = Easing.out(Easing.cubic);

export default function SplashScreen() {
  const t = useT();
  const { signInWithGoogle } = useAuth();
  const reduced = useReducedMotion();
  const { width, height } = useWindowDimensions();
  const compact = height < COMPACT_HEIGHT;
  const scrollX = useSharedValue(0);
  const [googleBusy, setGoogleBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const heroOpacity = useSharedValue(reduced ? 1 : 0);
  const heroScale = useSharedValue(reduced ? 1 : 0.97);
  const actionsOpacity = useSharedValue(reduced ? 1 : 0);
  const actionsY = useSharedValue(reduced ? 0 : 16);

  useEffect(() => {
    if (reduced) return;
    heroOpacity.value = withTiming(1, { duration: HERO_MS, easing: EASE });
    heroScale.value = withTiming(1, { duration: HERO_MS, easing: EASE });
    actionsOpacity.value = withDelay(ACTIONS_DELAY, withTiming(1, { duration: 420, easing: EASE }));
    actionsY.value = withDelay(ACTIONS_DELAY, withTiming(0, { duration: 420, easing: EASE }));
    // Runs once on mount; `reduced` only seeds the starting values above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const heroStyle = useAnimatedStyle(() => ({
    opacity: heroOpacity.value,
    transform: [{ scale: heroScale.value }],
  }));
  const actionsStyle = useAnimatedStyle(() => ({
    opacity: actionsOpacity.value,
    transform: [{ translateY: actionsY.value }],
  }));

  async function handleGoogle() {
    if (googleBusy) return;
    setError(null);
    setGoogleBusy(true);
    try {
      await signInWithGoogle();
      router.replace('/');
    } catch (err) {
      // A deliberate cancel (closed the Google sheet without finishing) is not a failure worth showing.
      if (!(err instanceof Error && err.message === 'cancelled')) setError(t('auth.googleFailed'));
    } finally {
      setGoogleBusy(false);
    }
  }

  return (
    <View style={styles.root}>
      <OnboardingBackdrop palettes={PALETTES} width={width} scrollX={scrollX} />

      {/* One fixed flex column, no ScrollView: the header, dots and buttons take their natural height and the
          carousel (really its arch) takes whatever is left, so the Google button is always on screen. */}
      <SafeAreaView style={styles.fill} edges={['top', 'bottom']}>
        <View style={[styles.column, styles.header, compact && styles.headerCompact]}>
          <Text style={styles.brand} numberOfLines={1}>
            Portal Topup<Text style={styles.brandDot}>.</Text>
          </Text>
          <LanguagePill />
        </View>

        <Animated.View style={[styles.hero, compact && styles.heroCompact, heroStyle]}>
          <OnboardingCarousel slides={ONBOARDING_SLIDES} width={width} scrollX={scrollX} reduced={reduced} />
          <OnboardingDots count={ONBOARDING_SLIDES.length} width={width} scrollX={scrollX} />
        </Animated.View>

        <Animated.View style={[styles.column, styles.actions, compact && styles.actionsCompact, actionsStyle]}>
          {error ? <ErrorBanner message={error} /> : null}

          <Button label={t('auth.signUp')} onPress={() => router.push('/sign-up')} disabled={googleBusy} />
          <Button
            label={t('auth.login')}
            variant="outline"
            onPress={() => router.push('/sign-in')}
            disabled={googleBusy}
          />

          <View style={[styles.dividerRow, compact && styles.dividerRowCompact]}>
            <View style={styles.divider} />
            <Text style={styles.dividerText}>{t('splash.orContinue')}</Text>
            <View style={styles.divider} />
          </View>

          <SocialButton label={t('auth.google')} icon={<GoogleIcon />} onPress={handleGoogle} loading={googleBusy} />
        </Animated.View>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  fill: { flex: 1 },
  column: {
    width: '100%',
    maxWidth: 440,
    alignSelf: 'center',
    paddingHorizontal: spacing.lg,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: spacing.sm,
    gap: spacing.md,
  },
  brand: {
    flexShrink: 1,
    fontFamily: fonts.extrabold,
    fontSize: 20,
    letterSpacing: -0.6,
    color: colors.text,
  },
  brandDot: { color: colors.limeDeep },
  headerCompact: { paddingTop: spacing.xs },
  // minHeight 0 lets this flex child shrink below its content's preferred height instead of overflowing.
  hero: { flex: 1, minHeight: 0, marginTop: spacing.md },
  heroCompact: { marginTop: spacing.sm },
  actions: { gap: spacing.md - 4, paddingBottom: spacing.md },
  actionsCompact: { gap: spacing.sm, paddingBottom: spacing.sm },
  dividerRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, marginVertical: spacing.xs },
  dividerRowCompact: { marginVertical: 0 },
  divider: { flex: 1, height: 1, backgroundColor: 'rgba(20,26,18,0.14)' },
  // The muted token is too light on the teal/violet backdrops; ink at 70% stays readable on all three.
  dividerText: { fontFamily: fonts.medium, fontSize: 13, color: 'rgba(20,26,18,0.7)' },
});
