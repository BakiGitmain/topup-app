import { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  Extrapolation,
  interpolate,
  runOnJS,
  scrollTo,
  useAnimatedRef,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  type SharedValue,
} from 'react-native-reanimated';

import { colors } from '../../lib/theme';
import { OnboardingSlide } from './OnboardingSlide';
import type { OnboardingSlideSpec } from './slides';

const SLIDE_INTERVAL_MS = 3000;
/** Autoplay stays paused until the carousel has been left alone this long. */
const RESUME_AFTER_MS = 4000;

type Props = {
  slides: readonly OnboardingSlideSpec[];
  /** Page width: the full screen width, since the pages are full-bleed. */
  width: number;
  /** Owned by the screen so the full-screen backdrop and the dots can follow the same scroll position. */
  scrollX: SharedValue<number>;
  reduced: boolean;
};

/**
 * Native paging does the swipe (cheapest possible on a low-end phone, and it never fights the finger); Reanimated
 * does everything that follows the scroll (backdrop, content fade, dots) on the UI thread. The autoplay timer
 * touches no React state: it reads the current page from the scroll position itself, so it stays right even on
 * Android, where a programmatic smooth scroll doesn't reliably fire a momentum-end event.
 */
export function OnboardingCarousel({ slides, width, scrollX, reduced }: Props) {
  const scrollRef = useAnimatedRef<Animated.ScrollView>();
  const [height, setHeight] = useState(0);
  const lastTouch = useRef(0);

  useEffect(() => {
    if (reduced || width === 0) return;
    const id = setInterval(() => {
      if (Date.now() - lastTouch.current < RESUME_AFTER_MS) return;
      const current = Math.round(scrollX.get() / width);
      scrollTo(scrollRef, ((current + 1) % slides.length) * width, 0, true);
    }, SLIDE_INTERVAL_MS);
    return () => clearInterval(id);
  }, [reduced, width, slides.length, scrollRef, scrollX]);

  function touched() {
    lastTouch.current = Date.now();
  }

  const onScroll = useAnimatedScrollHandler({
    onScroll: (e) => {
      scrollX.set(e.contentOffset.x);
    },
    onBeginDrag: () => {
      runOnJS(touched)();
    },
    onEndDrag: () => {
      runOnJS(touched)();
    },
  });

  return (
    <View style={styles.fill} onLayout={(e) => setHeight(e.nativeEvent.layout.height)}>
      {height > 0 ? (
        <Animated.ScrollView
          ref={scrollRef}
          horizontal
          pagingEnabled
          bounces={false}
          showsHorizontalScrollIndicator={false}
          onScroll={onScroll}
          scrollEventThrottle={16}
        >
          {slides.map((slide, i) => (
            <OnboardingSlide
              key={slide.key}
              slide={slide}
              index={i}
              width={width}
              height={height}
              scrollX={scrollX}
              reduced={reduced}
            />
          ))}
        </Animated.ScrollView>
      ) : null}
    </View>
  );
}

function PageDot({ index, width, scrollX }: { index: number; width: number; scrollX: SharedValue<number> }) {
  const style = useAnimatedStyle(() => {
    const input = [(index - 1) * width, index * width, (index + 1) * width];
    return {
      width: interpolate(scrollX.value, input, [7, 22, 7], Extrapolation.CLAMP),
      opacity: interpolate(scrollX.value, input, [0.25, 1, 0.25], Extrapolation.CLAMP),
    };
  });
  return <Animated.View style={[styles.dot, style]} />;
}

/** Position dots that stretch and fill continuously with the swipe, rather than jumping when a page settles. */
export function OnboardingDots({ count, width, scrollX }: { count: number; width: number; scrollX: SharedValue<number> }) {
  return (
    <View style={styles.dots} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {Array.from({ length: count }, (_, i) => (
        <PageDot key={i} index={i} width={width} scrollX={scrollX} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  dots: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 6, paddingVertical: 14 },
  dot: { height: 7, borderRadius: 4, backgroundColor: colors.text },
});
