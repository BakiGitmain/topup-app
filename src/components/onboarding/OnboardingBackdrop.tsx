import { LinearGradient } from 'expo-linear-gradient';
import { StyleSheet } from 'react-native';
import Animated, { Extrapolation, interpolate, useAnimatedStyle, type SharedValue } from 'react-native-reanimated';

import type { GradientStops } from './ArchStage';

function Layer({ stops, index, width, scrollX }: { stops: GradientStops; index: number; width: number; scrollX: SharedValue<number> }) {
  const style = useAnimatedStyle(() => ({
    opacity:
      index === 0 ? 1 : interpolate(scrollX.value, [(index - 1) * width, index * width], [0, 1], Extrapolation.CLAMP),
  }));
  return (
    <Animated.View style={[StyleSheet.absoluteFill, style]} pointerEvents="none">
      <LinearGradient colors={stops} start={{ x: 0.5, y: 0 }} end={{ x: 0.5, y: 1 }} style={StyleSheet.absoluteFill} />
    </Animated.View>
  );
}

/**
 * The full-screen gradient behind everything, including the buttons. Layers stack in slide order and each one fades
 * in over the one below as its page scrolls into place, so the colour is always fully opaque (no white showing
 * through mid-swipe) and it tracks the finger exactly -- it is driven by scroll position on the UI thread, never by
 * a timer or React state.
 */
export function OnboardingBackdrop({
  palettes,
  width,
  scrollX,
}: {
  palettes: readonly GradientStops[];
  width: number;
  scrollX: SharedValue<number>;
}) {
  return (
    <>
      {palettes.map((stops, i) => (
        <Layer key={i} stops={stops} index={i} width={width} scrollX={scrollX} />
      ))}
    </>
  );
}
