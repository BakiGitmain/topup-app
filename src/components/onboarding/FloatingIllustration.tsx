import { Image, type ImageSource } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

import { colors, fonts, shadow } from '../../lib/theme';
import { Glow, GroundShadow, Particles, type Particle } from './Decor';

/** Geometry is in fractions of the illustration box's side: x/y is the item's centre, size its width. */
export type FloatItem = {
  key: string;
  x: number;
  y: number;
  size: number;
  rotate?: number;
  z?: number;
  /** One gentle bob per composition, on the hero object: enough to feel alive, cheap on a low-end phone. */
  float?: boolean;
} & ({ source: ImageSource | number } | { badge: 'percent' });

export type FloatingComposition = {
  items: readonly FloatItem[];
  particles: readonly Particle[];
  /** Centre of the glow and the ground shadow, usually under the hero item. */
  glow: { x: number; y: number; size: number };
  ground: { x: number; y: number; width: number };
};

function Bob({ enabled, children }: { enabled: boolean; children: React.ReactNode }) {
  const y = useSharedValue(0);
  useEffect(() => {
    if (!enabled) return;
    const ease = Easing.inOut(Easing.sin);
    y.value = withRepeat(
      withSequence(withTiming(-6, { duration: 1600, easing: ease }), withTiming(0, { duration: 1600, easing: ease })),
      -1
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);
  const style = useAnimatedStyle(() => ({ transform: [{ translateY: y.value }] }));
  return <Animated.View style={[StyleSheet.absoluteFill, style]}>{children}</Animated.View>;
}

/**
 * A clay-style "%" tile. No discount/percent icon exists in the 3D set these slides use, so this one is built from
 * the same ingredients the renders are made of: a darker slab underneath for thickness, a lit gradient face, a
 * soft highlight -- close enough in weight that it sits next to the coins without looking pasted in.
 */
function PercentBadge({ size }: { size: number }) {
  const r = size * 0.26;
  const depth = size * 0.07;
  return (
    <View style={{ width: size, height: size + depth }}>
      <View style={[styles.badgeSlab, { top: depth, width: size, height: size, borderRadius: r }]} />
      <View style={[styles.badgeFace, { width: size, height: size, borderRadius: r }]}>
        <LinearGradient
          colors={['#FFFFFF', colors.surface, colors.limeSoft]}
          start={{ x: 0.1, y: 0 }}
          end={{ x: 0.9, y: 1 }}
          style={[StyleSheet.absoluteFill, { borderRadius: r }]}
        />
        <Text style={[styles.percent, { fontSize: size * 0.56, lineHeight: size * 0.7 }]} allowFontScaling={false}>
          %
        </Text>
      </View>
    </View>
  );
}

export function FloatingIllustration({
  side,
  composition,
  reduced,
}: {
  side: number;
  composition: FloatingComposition;
  reduced: boolean;
}) {
  const { items, particles, glow, ground } = composition;

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      <View style={{ position: 'absolute', left: (glow.x - glow.size / 2) * side, top: (glow.y - glow.size / 2) * side }}>
        <Glow size={glow.size * side} intensity={0.85} />
      </View>
      <View style={{ position: 'absolute', left: (ground.x - ground.width / 2) * side, top: ground.y * side }}>
        <GroundShadow width={ground.width * side} />
      </View>

      {items.map((item) => {
        const px = item.size * side;
        const body =
          'badge' in item ? (
            <PercentBadge size={px} />
          ) : (
            <Image source={item.source} style={{ width: px, height: px }} contentFit="contain" />
          );
        const placed = (
          <View
            style={{
              position: 'absolute',
              left: item.x * side - px / 2,
              top: item.y * side - px / 2,
              transform: [{ rotate: `${item.rotate ?? 0}deg` }],
            }}
          >
            {body}
          </View>
        );
        return (
          <View key={item.key} style={[StyleSheet.absoluteFill, { zIndex: item.z ?? 1 }]}>
            {item.float ? <Bob enabled={!reduced}>{placed}</Bob> : placed}
          </View>
        );
      })}

      <Particles items={particles} side={side} />
    </View>
  );
}

const styles = StyleSheet.create({
  badgeSlab: { position: 'absolute', left: 0, backgroundColor: colors.limeDeep },
  badgeFace: {
    position: 'absolute',
    top: 0,
    left: 0,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bg,
    ...shadow.soft,
  },
  percent: { fontFamily: fonts.extrabold, color: colors.limeInk, textAlign: 'center' },
});
