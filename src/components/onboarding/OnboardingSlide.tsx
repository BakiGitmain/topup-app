import { StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import Animated, { Extrapolation, interpolate, useAnimatedStyle, type SharedValue } from 'react-native-reanimated';

import { useT } from '../../lib/i18n';
import { colors, fonts, spacing } from '../../lib/theme';
import { ArchStage } from './ArchStage';
import type { OnboardingSlideSpec } from './slides';

const CONTENT_MAX = 440;
const GUTTER = spacing.lg;

/** Below this window height (iPhone SE and small Androids) the splash tightens type and spacing so the arch keeps a
 * usable size and all three buttons stay on screen without scrolling. */
export const COMPACT_HEIGHT = 720;

type Props = {
  slide: OnboardingSlideSpec;
  index: number;
  width: number;
  height: number;
  scrollX: SharedValue<number>;
  reduced: boolean;
};

/** One page: headline, subhead, and the arch with its illustration. The page is full-bleed (the backdrop behind it
 * is the whole screen) but its content is capped at the same 440pt column as every other screen. */
export function OnboardingSlide({ slide, index, width, height, scrollX, reduced }: Props) {
  const t = useT();
  const compact = useWindowDimensions().height < COMPACT_HEIGHT;
  const column = Math.min(width, CONTENT_MAX) - GUTTER * 2;
  const archWidth = Math.min(column * 0.86, 340);

  // Content eases out as it leaves the centre, so a swipe reads as a crossfade over the moving backdrop.
  const fade = useAnimatedStyle(() => {
    const input = [(index - 1) * width, index * width, (index + 1) * width];
    return {
      opacity: interpolate(scrollX.value, input, [0.2, 1, 0.2], Extrapolation.CLAMP),
      transform: [{ scale: interpolate(scrollX.value, input, [0.94, 1, 0.94], Extrapolation.CLAMP) }],
    };
  });

  return (
    <View style={{ width, height }}>
      <Animated.View style={[styles.column, { width: column }, fade]}>
        <Text
          style={[styles.title, (compact || column < 330) && styles.titleSmall]}
          numberOfLines={2}
          adjustsFontSizeToFit
          minimumFontScale={0.75}
          accessibilityRole="header"
        >
          {t(slide.titleKey)}
        </Text>
        <Text style={[styles.sub, compact && styles.subSmall]} numberOfLines={2}>
          {t(slide.subKey)}
        </Text>
        <View style={[styles.stage, compact && styles.stageSmall]}>
          <ArchStage colors={slide.arch} width={archWidth}>
            {(side) => slide.illustration(side, reduced)}
          </ArchStage>
        </View>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  column: { flex: 1, alignSelf: 'center' },
  title: {
    fontFamily: fonts.extrabold,
    fontSize: 30,
    lineHeight: 36,
    letterSpacing: -0.8,
    color: colors.text,
    textAlign: 'center',
  },
  titleSmall: { fontSize: 26, lineHeight: 31 },
  sub: {
    marginTop: spacing.sm,
    fontFamily: fonts.medium,
    fontSize: 14.5,
    lineHeight: 21,
    // The muted token is too light on the violet/teal backdrops; ink at 70% keeps AA on all three.
    color: 'rgba(20,26,18,0.7)',
    textAlign: 'center',
  },
  subSmall: { marginTop: spacing.xs, fontSize: 13.5, lineHeight: 19 },
  // The arch takes whatever height is left after the text and the buttons: it is the one flexible piece.
  stage: { flex: 1, justifyContent: 'center', paddingTop: spacing.lg },
  stageSmall: { paddingTop: spacing.md },
});
