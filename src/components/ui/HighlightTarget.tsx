import { useEffect, type ReactNode } from 'react';
import { Platform, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withSequence, withTiming } from 'react-native-reanimated';

import { colors } from '../../lib/theme';
import type { HighlightBinding } from '../../lib/useScrollToHighlight';
import { useReducedMotion } from '../../lib/useReducedMotion';

/** The whole glow, start to finish: a soft rise, one gentle dip and return, then a slow fade. */
export const GLOW_MS = 1600;

type Props = {
  id: string;
  /** From useScrollToHighlight; omit when the list has nothing to highlight. */
  binding?: HighlightBinding;
  /** The corner radius of what it wraps, so the glow hugs it. */
  radius: number;
  /** How far the glow sits outside the item; 0 inside a container that clips. */
  outset?: number;
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
};

/**
 * Wraps one list item so useScrollToHighlight can measure it and glow it. Every highlightable item in the app
 * (a pack card, a transaction row) goes through this, so there is one glow and one way to point at an item.
 */
export function HighlightTarget({ id, binding, radius, outset = 3, style, children }: Props) {
  const isTarget = binding?.targetId === id;
  return (
    <View ref={isTarget ? binding?.targetRef : undefined} collapsable={false} style={style}>
      {children}
      {binding?.glowingId === id && <Glow radius={radius} outset={outset} onDone={binding.endGlow} />}
    </View>
  );
}

/**
 * Only opacity animates (on the UI thread), over a plain border and tint: cheap enough for low-end Android. With
 * reduce motion on, the outline simply shows for the same time, with no pulse.
 */
function Glow({ radius, outset, onDone }: { radius: number; outset: number; onDone: () => void }) {
  const reduced = useReducedMotion();
  const opacity = useSharedValue(0);

  useEffect(() => {
    if (reduced) {
      opacity.value = 1;
    } else {
      const ease = Easing.inOut(Easing.quad);
      opacity.value = withSequence(
        withTiming(1, { duration: 240, easing: ease }),
        withTiming(0.5, { duration: 320, easing: ease }),
        withTiming(1, { duration: 320, easing: ease }),
        withTiming(0, { duration: GLOW_MS - 880, easing: Easing.out(Easing.quad) })
      );
    }
    const timer = setTimeout(onDone, GLOW_MS);
    return () => clearTimeout(timer);
  }, [reduced, opacity, onDone]);

  const animated = useAnimatedStyle(() => ({ opacity: opacity.value }));

  return (
    <Animated.View
      pointerEvents="none"
      testID="highlight-glow"
      style={[
        styles.glow,
        { top: -outset, right: -outset, bottom: -outset, left: -outset, borderRadius: radius + outset },
        animated,
      ]}
    />
  );
}

const styles = StyleSheet.create({
  glow: {
    position: 'absolute',
    borderWidth: 2,
    borderColor: colors.lime,
    backgroundColor: 'rgba(163, 230, 53, 0.14)',
    // A soft outer glow where it is free (iOS and web draw shadows cheaply); Android keeps just the outline and tint.
    ...Platform.select({
      ios: { shadowColor: colors.lime, shadowOpacity: 0.7, shadowRadius: 10, shadowOffset: { width: 0, height: 0 } },
      web: { boxShadow: `0 0 12px ${colors.lime}` },
      default: {},
    }),
  },
});
