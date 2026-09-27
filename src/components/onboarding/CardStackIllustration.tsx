import { Image } from 'expo-image';
import { StyleSheet, View } from 'react-native';

import { colors, shadow } from '../../lib/theme';
import { Glow, Particles, type Particle } from './Decor';

const ART = 'https://qbhsevgdgliacmswkpft.supabase.co/storage/v1/object/public/product-art/products';

/** Left to right across the fan. The catalog's own artwork (products.image_url, public `product-art` bucket), the
 * same images the shop grid shows -- nothing fetched from outside the app. */
const CARDS = [
  { name: 'Telegram', uri: `${ART}/mue5si72-yjj0y76g.jpg` },
  { name: 'Mobile Legends: Bang Bang', uri: `${ART}/mufhhx5z-rth1sous.jpg` },
  { name: 'PUBG Mobile', uri: `${ART}/mucdfs76-rfd069da.jpg` },
  { name: 'Free Fire', uri: `${ART}/mucbdk1u-qp7zhn7e.jpg` },
  { name: 'Delta Force', uri: `${ART}/mue4dl7p-cg0qa6wj.jpg` },
  { name: 'Steam', uri: `${ART}/mufy137a-a8qlh2y5.jpg` },
] as const;

const PARTICLES: readonly Particle[] = [
  { x: 0.16, y: 0.14, size: 0.09, kind: 'spark' },
  { x: 0.86, y: 0.2, size: 0.07, kind: 'spark' },
  { x: 0.72, y: 0.07, size: 0.035, kind: 'dot', opacity: 0.7 },
  { x: 0.3, y: 0.05, size: 0.025, kind: 'dot', opacity: 0.6 },
];

const CARD = 0.34; // card side, as a fraction of the box
const SPREAD = 0.125; // horizontal step between neighbours
const TILT = 8; // degrees of rotation per step from the centre
const DROOP = 0.018; // how much the outer cards sink, like a hand of cards

/**
 * A loose, fanned deck: each card rotates and slides out from the centre by its distance from the middle, the outer
 * ones droop a little, and the middle two sit on top. Pure transforms on plain Views -- no layout math per frame.
 */
export function CardStackIllustration({ side }: { side: number }) {
  const card = side * CARD;
  const mid = (CARDS.length - 1) / 2;

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      <View style={[styles.glow, { left: side * 0.05, top: side * 0.12 }]}>
        <Glow size={side * 0.9} intensity={0.7} />
      </View>

      {CARDS.map((c, i) => {
        const t = i - mid;
        return (
          <View
            key={c.name}
            style={[
              styles.card,
              {
                width: card,
                height: card,
                borderRadius: card * 0.24,
                left: side / 2 - card / 2 + t * side * SPREAD,
                top: side * 0.52 - card / 2 + t * t * side * DROOP,
                zIndex: 10 - Math.round(Math.abs(t) * 2),
                transform: [{ rotate: `${t * TILT}deg` }],
              },
            ]}
          >
            <Image
              source={{ uri: c.uri }}
              style={[styles.image, { borderRadius: card * 0.24 - 3 }]}
              contentFit="cover"
              cachePolicy="memory-disk"
              transition={180}
              accessibilityLabel={c.name}
            />
          </View>
        );
      })}

      <Particles items={PARTICLES} side={side} />
    </View>
  );
}

const styles = StyleSheet.create({
  glow: { position: 'absolute' },
  card: {
    position: 'absolute',
    borderWidth: 3,
    borderColor: colors.bg,
    backgroundColor: colors.surface,
    ...shadow.lift,
  },
  image: { width: '100%', height: '100%' },
});
