import * as Haptics from 'expo-haptics';
import { Platform, Pressable, StyleSheet, Text } from 'react-native';

import type { Product } from '../../lib/catalog';
import { STACK_GAP, STACK_NAME_LINES, STACK_NAME_LINE_HEIGHT, STACK_PAD, TILE_ART, TILE_HEIGHT, stackArt, tileHeight, tileLayout } from '../../lib/grid';
import { colors, fonts } from '../../lib/theme';
import { ProductArt } from './ProductArt';

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
      {/* The one shared art rule (contained picture in a rounded square, or the letter on the product's tint). */}
      <ProductArt name={product.name} imageUrl={product.imageUrl} tint={product.tint} size={art} letterSize={layout === 'stack' ? Math.round(art * 0.42) : undefined} />
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

// No card behind the tile any more (no background, no border): the picture is the tile. Only its own rounded corners
// (on `art`, below) give the grid its shape now.
const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: (TILE_HEIGHT - TILE_ART) / 2 },
  stack: { alignItems: 'center', padding: STACK_PAD, gap: STACK_GAP },
  pressed: { opacity: 0.85, transform: [{ scale: 0.98 }] },
  nameRow: { flex: 1, fontFamily: fonts.bold, fontSize: 14, lineHeight: 18, color: colors.text, letterSpacing: -0.1 },
  nameStack: { alignSelf: 'stretch', textAlign: 'center', fontFamily: fonts.bold, fontSize: 12, lineHeight: STACK_NAME_LINE_HEIGHT, color: colors.text },
});
