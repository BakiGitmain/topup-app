import { StyleSheet, useWindowDimensions, View } from 'react-native';

import type { Product } from '../../lib/catalog';
import { GRID_GAP, gridColumns, sectionLimit, tileWidth } from '../../lib/grid';
import { spacing } from '../../lib/theme';
import { MAX_COLUMN_WIDTH } from '../ui/TabScroll';
import { ProductTile } from './ProductTile';

/** Column count (3) and tile size for the current window. Every product list in the app uses this one grid. */
export function useProductGrid() {
  const { width } = useWindowDimensions();
  const content = Math.min(width, MAX_COLUMN_WIDTH);
  const columns = gridColumns(content, spacing.lg);
  const tile = tileWidth(content, spacing.lg, columns);
  return { columns, tile, gap: GRID_GAP, limit: sectionLimit(columns) };
}

type Props = {
  products: readonly Product[];
  onPress: (product: Product) => void;
};

export function ProductGrid({ products, onPress }: Props) {
  const { tile } = useProductGrid();
  return (
    <View style={styles.grid}>
      {products.map((product) => (
        <ProductTile key={product.id} product={product} width={tile} onPress={onPress} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: GRID_GAP },
});
