import { LinearGradient } from 'expo-linear-gradient';
import { useState, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { radius } from '../../lib/theme';

export type GradientStops = readonly [string, string, ...string[]];

type Props = {
  colors: GradientStops;
  width: number;
  /** Receives the side of the square illustration box, sized to whatever height the arch actually got. */
  children: (side: number) => ReactNode;
};

/**
 * The "stadium" frame: a tall pill, fully round on top (radius = half its width), gently rounded at the bottom.
 * The radius is a number computed from the known width rather than a percentage, because percentage border radii
 * aren't reliable across RN's native renderers.
 *
 * Two layers on purpose: the gradient is clipped to the arch shape, but the illustration layer is not, so a card
 * corner or a sparkle can break out of the frame a little -- that overlap is most of what makes this style read
 * as layered rather than boxed in.
 */
export function ArchStage({ colors, width, children }: Props) {
  const [height, setHeight] = useState(0);
  const side = Math.min(width * 0.96, height * 0.92);
  const boxTop = height - side - (height - side) * 0.35;

  return (
    <View
      style={[styles.arch, { width, maxHeight: width * 1.3 }]}
      onLayout={(e) => setHeight(e.nativeEvent.layout.height)}
    >
      <View
        style={[
          StyleSheet.absoluteFill,
          styles.clip,
          { borderTopLeftRadius: width / 2, borderTopRightRadius: width / 2 },
        ]}
      >
        <LinearGradient colors={colors} start={{ x: 0.15, y: 0 }} end={{ x: 0.85, y: 1 }} style={StyleSheet.absoluteFill} />
        <LinearGradient
          colors={['rgba(255,255,255,0.55)', 'rgba(255,255,255,0)']}
          start={{ x: 0.5, y: 0 }}
          end={{ x: 0.5, y: 0.45 }}
          style={StyleSheet.absoluteFill}
        />
      </View>

      {height > 0 && side > 0 ? (
        <View style={[styles.box, { width: side, height: side, left: (width - side) / 2, top: boxTop }]}>
          {children(side)}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  arch: {
    alignSelf: 'center',
    flexGrow: 1,
    flexShrink: 1,
    // No minimum on purpose: on a short phone the arch (and the illustration, which is sized from it) is what
    // gives, so the buttons never get pushed off screen.
    minHeight: 0,
  },
  clip: {
    overflow: 'hidden',
    borderBottomLeftRadius: radius.xl,
    borderBottomRightRadius: radius.xl,
  },
  box: { position: 'absolute' },
});
