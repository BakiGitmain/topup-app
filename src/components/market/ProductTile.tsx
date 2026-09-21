import { Image } from 'expo-image';
import * as Haptics from 'expo-haptics';
import { useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import type { Product } from '../../lib/catalog';
import { tileLetter } from '../../lib/catalogRules';
import { STACK_GAP, STACK_NAME_LINES, STACK_NAME_LINE_HEIGHT, STACK_PAD, TILE_ART, TILE_HEIGHT, stackArt, tileHeight, tileLayout } from '../../lib/grid';
import { colors, fonts, radius } from '../../lib/theme';

type Props = {
  product: Product;
  width: number;
  onPress: (product: Product) => void;
};

/**
 * One product on the shop grid. The artwork is always CONTAINED in a fixed rounded square (shown whole, never cropped or
 * stretched; a picture that isn't square sits inside the box with room around it) and the name is always cut with an ellipsis
 * rather than overflowing. No price and no promotional badges. Without artwork (or if it fails to load) a letter tile takes its place.
 *
 * Two arrangements of the same parts, picked by the tile's own width (see lib/grid.ts):
 *  - ROW (tile >= 150pt): picture on the left, name on the right, vertically centred.
 *  - STACK (narrower, which is every 3-column phone tile): picture on top, name centred below it, up to two lines.
 */
export function ProductTile({ product, width, onPress }: Props) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const url = product.imageUrl;
  const showImage = url !== null && failedUrl !== url;
  const layout = tileLayout(width);
  const art = layout === 'row' ? TILE_ART : stackArt(width);

  function handlePress() {
    if (Platform.OS !== 'web') Haptics.selectionAsync().catch(() => {});
    onPress(product);
  }

  return (
    <Pressable
      onPress={handlePress}
      accessibilityRole="button"
      accessibilityLabel={product.name}
      style={({ pressed }) => [layout === 'row' ? styles.row : styles.stack, { width, height: tileHeight(width) }, pressed && styles.pressed]}
    >
      <View style={[styles.art, { width: art, height: art, backgroundColor: showImage ? colors.bg : product.tint }]}>
        {showImage ? (
          <Image
            source={{ uri: url }}
            style={StyleSheet.absoluteFill}
            contentFit="contain"
            transition={150}
            accessibilityIgnoresInvertColors
            onError={(event) => {
              if (__DEV__) console.warn(`[artwork] failed to load for "${product.name}": ${url} (${event.error})`);
              setFailedUrl(url);
            }}
          />
        ) : (
          <Text style={[styles.letter, layout === 'stack' && { fontSize: Math.round(art * 0.42) }]} numberOfLines={1} allowFontScaling={false} importantForAccessibility="no">
            {tileLetter(product.name)}
          </Text>
        )}
      </View>
      <Text
        style={layout === 'row' ? styles.nameRow : styles.nameStack}
        numberOfLines={layout === 'stack' ? STACK_NAME_LINES : 2}
        ellipsizeMode="tail"
        maxFontSizeMultiplier={1.15}
      >
        {product.name}
      </Text>
    </Pressable>
  );
}

const box = {
  borderRadius: radius.md,
  backgroundColor: colors.surface,
  borderWidth: StyleSheet.hairlineWidth,
  borderColor: colors.border,
} as const;

const styles = StyleSheet.create({
  row: { ...box, flexDirection: 'row', alignItems: 'center', gap: 12, padding: (TILE_HEIGHT - TILE_ART) / 2 },
  stack: { ...box, alignItems: 'center', padding: STACK_PAD, gap: STACK_GAP },
  pressed: { opacity: 0.85, transform: [{ scale: 0.98 }] },
  // A fixed square per tile, so every picture is the same size whatever shape the artwork is.
  art: {
    borderRadius: 14,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  letter: { fontFamily: fonts.extrabold, fontSize: 26, color: colors.text, opacity: 0.5, includeFontPadding: false },
  nameRow: { flex: 1, fontFamily: fonts.bold, fontSize: 14, lineHeight: 18, color: colors.text, letterSpacing: -0.1 },
  nameStack: { alignSelf: 'stretch', textAlign: 'center', fontFamily: fonts.bold, fontSize: 12, lineHeight: STACK_NAME_LINE_HEIGHT, color: colors.text },
});
