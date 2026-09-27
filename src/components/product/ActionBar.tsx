import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { useT } from '../../lib/i18n';
import { colors, fonts, spacing } from '../../lib/theme';
import { FeatherIcon } from '../art/FeatherIcon';
import { Button } from '../ui/Button';

type Props = {
  /** The chosen pack's price, already formatted ("Br 500"), or "—". */
  total: string;
  /** Why the buttons are off (the per-item ID check), in words; null when both are allowed. */
  blockerText: string | null;
  adding: boolean;
  buying: boolean;
  onAdd: () => void;
  onBuy: () => void;
  /** Gift mode (Profile > Gift): no add-to-cart, and the primary button says what is being bought. */
  giftLabel?: string;
};

/**
 * The product page's bottom bar: the total, a small icon-only "add to cart" button (bag with a "+"; stays on the page so
 * people can keep browsing) and the primary "Buy now" (add to cart if it isn't there, then straight to checkout). Both are
 * switched off together by the same blocker: the ID for this item must be checked first.
 */
export function ActionBar({ total, blockerText, adding, buying, onAdd, onBuy, giftLabel }: Props) {
  const t = useT();
  const blocked = blockerText !== null;

  return (
    <>
      {blocked && (
        <Text style={styles.blocker} accessibilityLiveRegion="polite">
          {blockerText}
        </Text>
      )}
      <View style={styles.row}>
        <View style={styles.totalBox}>
          <Text style={styles.totalLabel}>{t('product.total')}</Text>
          <Text style={styles.totalValue} accessibilityLabel={`${t('product.total')} ${total}`} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8}>
            {total}
          </Text>
        </View>

        {!giftLabel && (
        <Pressable
          onPress={onAdd}
          disabled={blocked || adding || buying}
          accessibilityRole="button"
          accessibilityLabel={t('cart.add')}
          accessibilityState={{ disabled: blocked, busy: adding }}
          style={({ pressed }) => [styles.addIcon, (blocked || buying) && styles.addIconOff, pressed && { opacity: 0.7 }]}
        >
          {adding ? (
            <ActivityIndicator size="small" color={colors.text} />
          ) : (
            <View>
              <FeatherIcon name="shopping-bag" size={22} color={colors.text} />
              <View style={styles.plusBadge} pointerEvents="none">
                <FeatherIcon name="plus" size={10} color="#FFFFFF" strokeWidth={3.4} />
              </View>
            </View>
          )}
        </Pressable>
        )}

        <Button label={giftLabel ?? t('product.buyNow')} onPress={onBuy} loading={buying} disabled={blocked || adding} style={styles.buy} />
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  blocker: { fontFamily: fonts.medium, fontSize: 13, color: colors.textMuted, marginBottom: spacing.sm, textAlign: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm + 4 },
  totalBox: { flexShrink: 1, minWidth: 72 },
  totalLabel: { fontFamily: fonts.medium, fontSize: 12.5, color: colors.textMuted },
  totalValue: { fontFamily: fonts.extrabold, fontSize: 21, color: colors.text, letterSpacing: -0.4 },
  addIcon: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surfaceAlt,
  },
  addIconOff: { opacity: 0.4 },
  plusBadge: {
    position: 'absolute',
    top: -6,
    right: -8,
    width: 16,
    height: 16,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.limeDeep,
    borderWidth: 1.5,
    borderColor: colors.surfaceAlt,
  },
  buy: { flex: 1, minWidth: 110 },
});
