import { Image } from 'expo-image';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import { formatBirr, priceDisplay, priceSummary } from '../../lib/pricing';
import type { PackageState } from '../../lib/regionMatch';
import { useT } from '../../lib/i18n';
import type { PackageGroup, PackageView } from '../../lib/productView';
import { colors, fonts, radius, spacing } from '../../lib/theme';
import { FeatherIcon } from '../art/FeatherIcon';
import { MAX_COLUMN_WIDTH } from '../ui/TabScroll';

const GAP = 10;
const PER_ROW = 2;

type Props = {
  groups: PackageGroup[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  stateOf: (pkg: PackageView) => PackageState;
};

/** Two cards per row, so every card in a row can be exactly as tall as the tallest one. */
function inRows<T>(items: readonly T[]): T[][] {
  const rows: T[][] = [];
  for (let i = 0; i < items.length; i += PER_ROW) rows.push(items.slice(i, i + PER_ROW));
  return rows;
}

/** Packages under their group headings. */
export function PackageGrid({ groups, selectedId, onSelect, stateOf }: Props) {
  const { width } = useWindowDimensions();
  const cardWidth = Math.floor((Math.min(width, MAX_COLUMN_WIDTH) - spacing.lg * 2 - GAP * (PER_ROW - 1)) / PER_ROW);

  return (
    <View>
      {groups.map((group, i) => (
        <View key={group.label ?? `group-${i}`} style={styles.group}>
          {group.label !== null && (
            <Text style={styles.groupTitle} accessibilityRole="header">
              {group.label}
            </Text>
          )}
          {inRows(group.packages).map((row) => (
            <View key={row[0].id} style={styles.row}>
              {row.map((pkg) => (
                <PackageCard
                  key={pkg.id}
                  pkg={pkg}
                  width={cardWidth}
                  selected={pkg.id === selectedId}
                  state={stateOf(pkg)}
                  onSelect={onSelect}
                />
              ))}
            </View>
          ))}
        </View>
      ))}
    </View>
  );
}

function PackageCard({
  pkg,
  width,
  selected,
  state,
  onSelect,
}: {
  pkg: PackageView;
  width: number;
  selected: boolean;
  state: PackageState;
  onSelect: (id: string) => void;
}) {
  const t = useT();
  // A picture that fails to load falls back to the text-only card, never a broken box.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const showImage = pkg.imageUrl !== null && failedUrl !== pkg.imageUrl;

  const shown = priceDisplay(pkg.price, pkg.oldPrice);
  const blocked = state === 'wrong_region' || state === 'region_unknown' || state === 'unavailable';
  const reason =
    state === 'wrong_region'
      ? t('product.packWrongRegion')
      : state === 'region_unknown'
        ? t('product.packUnknownRegion')
        : state === 'unavailable'
          ? t('product.packUnavailable')
          : null;

  return (
    <Pressable
      onPress={() => onSelect(pkg.id)}
      disabled={blocked}
      accessibilityRole="radio"
      accessibilityState={{ checked: selected, selected, disabled: blocked }}
      aria-checked={selected}
      aria-disabled={blocked}
      accessibilityLabel={`${pkg.label}, ${priceSummary(pkg.price, pkg.oldPrice)}${reason ? `, ${reason}` : ''}`}
      style={({ pressed }) => [
        styles.card,
        { width },
        showImage && styles.cardWithImage,
        selected && styles.cardSelected,
        blocked && styles.cardBlocked,
        pressed && !blocked && styles.pressed,
      ]}
    >
      {showImage && (
        <View style={styles.imageBox}>
          <Image
            source={{ uri: pkg.imageUrl as string }}
            style={StyleSheet.absoluteFill}
            contentFit="cover"
            transition={120}
            accessibilityIgnoresInvertColors
            onError={() => setFailedUrl(pkg.imageUrl)}
          />
        </View>
      )}
      <View style={[styles.body, showImage && styles.bodyWithImage]}>
        <View style={styles.labelRow}>
          <Text style={styles.label} numberOfLines={2} ellipsizeMode="tail">
            {pkg.label}
          </Text>
          {selected && (
            <View style={styles.tick}>
              <FeatherIcon name="check" size={13} color={colors.text} strokeWidth={3} />
            </View>
          )}
        </View>
        <View style={styles.priceBlock}>
          <Text style={styles.price}>{formatBirr(shown.price)}</Text>
          {shown.oldPrice !== null && shown.discountPct !== null && (
            <View style={styles.oldRow}>
              <Text style={styles.oldPrice}>{formatBirr(shown.oldPrice)}</Text>
              <View style={styles.pct}>
                <Text style={styles.pctText}>{`-${shown.discountPct}%`}</Text>
              </View>
            </View>
          )}
          {reason !== null && <Text style={styles.reason}>{reason}</Text>}
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  group: { marginBottom: spacing.md },
  groupTitle: {
    fontFamily: fonts.bold,
    fontSize: 15,
    color: colors.textMuted,
    marginBottom: spacing.sm,
  },
  // Every card in a row stretches to the tallest one.
  row: { flexDirection: 'row', alignItems: 'stretch', gap: GAP, marginBottom: GAP },
  card: {
    minHeight: 96,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    borderWidth: 1.5,
    borderColor: 'transparent',
    overflow: 'hidden',
  },
  // A card with a picture gets a light outline instead of the tinted fill, so the picture sits on a clean edge.
  cardWithImage: { backgroundColor: colors.bg, borderColor: colors.border },
  cardSelected: { backgroundColor: colors.limeSoft, borderColor: colors.limeDeep },
  cardBlocked: { opacity: 0.5 },
  pressed: { opacity: 0.85 },
  imageBox: { width: '100%', aspectRatio: 1, backgroundColor: colors.surface },
  body: { flex: 1, padding: spacing.md - 2, justifyContent: 'space-between' },
  bodyWithImage: { paddingTop: spacing.sm + 2 },
  labelRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 6 },
  label: { flex: 1, fontFamily: fonts.bold, fontSize: 14.5, lineHeight: 19, color: colors.text },
  tick: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: colors.lime,
    alignItems: 'center',
    justifyContent: 'center',
  },
  priceBlock: { marginTop: 8 },
  price: { fontFamily: fonts.extrabold, fontSize: 17, color: colors.limeInk, letterSpacing: -0.3 },
  oldRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2 },
  oldPrice: {
    fontFamily: fonts.medium,
    fontSize: 12.5,
    color: colors.textFaint,
    textDecorationLine: 'line-through',
  },
  pct: { backgroundColor: colors.danger, borderRadius: 8, paddingHorizontal: 6, paddingVertical: 1 },
  pctText: { fontFamily: fonts.bold, fontSize: 11.5, color: '#FFFFFF' },
  reason: { marginTop: 6, fontFamily: fonts.medium, fontSize: 12, color: colors.textMuted },
});
