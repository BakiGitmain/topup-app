import { useEffect, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withDelay, withTiming } from 'react-native-reanimated';

import { colors } from '../../lib/theme';

const COLORS = [colors.limeDeep, colors.limeInk, '#F7D154', '#FF8A5B', '#5B8DEF', '#B075E5'];
const DURATION_MS = 700;
const MAX_DELAY_MS = 90;

type Piece = { angle: number; distance: number; color: string; size: number; delay: number; spin: number };

/** A fresh, random burst every time `count` particles is called for -- not memoized across renders, since a real
 * confetti burst should never look identical twice. */
function makePieces(count: number): Piece[] {
  return Array.from({ length: count }, (_, i) => ({
    angle: (360 / count) * i + (Math.random() * 26 - 13),
    distance: 64 + Math.random() * 48,
    color: COLORS[i % COLORS.length],
    size: 5 + Math.random() * 4,
    delay: Math.random() * MAX_DELAY_MS,
    spin: Math.random() > 0.5 ? 1 : -1,
  }));
}

function ConfettiPiece({ piece }: { piece: Piece }) {
  const progress = useSharedValue(0);

  useEffect(() => {
    progress.value = withDelay(piece.delay, withTiming(1, { duration: DURATION_MS, easing: Easing.out(Easing.cubic) }));
    // Fires once per mount -- the parent gives this piece a fresh key on every burst, so it never replays stale state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const style = useAnimatedStyle(() => {
    const rad = (piece.angle * Math.PI) / 180;
    const dist = progress.value * piece.distance;
    return {
      opacity: 1 - progress.value,
      transform: [
        { translateX: Math.cos(rad) * dist },
        // A slight extra downward drift near the end, like real confetti losing momentum -- not a straight line out.
        { translateY: Math.sin(rad) * dist + progress.value * progress.value * 26 },
        { rotate: `${progress.value * 220 * piece.spin}deg` },
        { scale: 1 - progress.value * 0.35 },
      ],
    };
  });

  return <Animated.View style={[styles.piece, { backgroundColor: piece.color, width: piece.size, height: piece.size }, style]} />;
}

/**
 * A tiny custom particle burst -- no confetti library (same "build it, don't depend on it" call already made for
 * the wheel itself). `burstKey` changes (any new value) fire a fresh burst; 0/null renders nothing, so the very
 * first mount is silent until an actual win increments it.
 */
export function ConfettiBurst({ burstKey, count = 18 }: { burstKey: number; count?: number }) {
  // burstKey is a deliberate recompute trigger, not an input to makePieces -- every new value must produce a fresh
  // random burst, so it stays in the dependency list even though the memoized value itself never reads it.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const pieces = useMemo(() => makePieces(count), [burstKey, count]);
  if (!burstKey) return null;

  return (
    <View pointerEvents="none" style={styles.wrap}>
      {pieces.map((piece, i) => (
        <ConfettiPiece key={`${burstKey}-${i}`} piece={piece} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center' },
  piece: { position: 'absolute', borderRadius: 2 },
});
