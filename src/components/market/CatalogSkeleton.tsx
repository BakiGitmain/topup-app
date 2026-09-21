import { useEffect, useState } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';

import { sectionLimit, tileHeight } from '../../lib/grid';
import { useT } from '../../lib/i18n';
import { colors, radius } from '../../lib/theme';
import { useReducedMotion } from '../../lib/useReducedMotion';
import { useProductGrid } from './ProductGrid';

/** Placeholder section: a title bar and the rows of tiles a section shows, the same size as the real ones. */
export function CatalogSkeleton() {
  const t = useT();
  const { columns, tile, gap } = useProductGrid();
  const reduced = useReducedMotion();
  const [pulse] = useState(() => new Animated.Value(0));

  useEffect(() => {
    if (reduced) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 800, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 800, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [pulse, reduced]);

  const opacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.55, 1] });

  return (
    <View accessible accessibilityRole="progressbar" accessibilityLabel={t('shop.loading')}>
      <Animated.View style={[styles.title, { opacity }]} />
      <View style={[styles.grid, { gap }]}>
        {Array.from({ length: sectionLimit(columns) }, (_, i) => (
          <Animated.View key={i} style={[styles.block, { width: tile, height: tileHeight(tile), opacity }]} />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  title: { width: 120, height: 18, borderRadius: 6, backgroundColor: colors.border, marginBottom: 14 },
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  block: { borderRadius: radius.md, backgroundColor: colors.border },
});
