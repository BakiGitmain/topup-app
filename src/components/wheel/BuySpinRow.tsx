import * as Haptics from 'expo-haptics';
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, fonts, radius, spacing, wheel as W } from '../../lib/theme';
import { FeatherIcon } from '../art/FeatherIcon';

type Props = {
  spins: number;
  label: string;
  priceLabel: string;
  onPress: () => void;
  loading?: boolean;
  disabled?: boolean;
};

/**
 * One spin package, in the wheel's own palette: a cream card with the spin count in a small rim-coloured badge, and
 * the Portal Coin price as the tappable pill (the same star the wallet menu uses for Portal Coins). Presentation only
 * -- the caller owns the purchase, exactly as before.
 */
export function BuySpinRow({ spins, label, priceLabel, onPress, loading = false, disabled = false }: Props) {
  const blocked = disabled || loading;

  function press() {
    if (blocked) return;
    if (Platform.OS !== 'web') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    onPress();
  }

  return (
    <View style={styles.card}>
      <View style={styles.badge}>
        <Text style={styles.badgeText} allowFontScaling={false}>
          {spins}
        </Text>
      </View>
      <Text style={styles.label} numberOfLines={1}>
        {label}
      </Text>
      <Pressable
        onPress={press}
        disabled={blocked}
        accessibilityRole="button"
        accessibilityLabel={`${label}, ${priceLabel}`}
        accessibilityState={{ disabled: blocked, busy: loading }}
        style={({ pressed }) => [styles.price, pressed && !blocked && styles.pricePressed, blocked && !loading && styles.blocked]}
      >
        {loading ? (
          <ActivityIndicator size="small" color={W.ink} />
        ) : (
          <>
            <FeatherIcon name="star" size={14} color={colors.limeDark} strokeWidth={2.4} />
            <Text style={styles.priceText} numberOfLines={1}>
              {priceLabel}
            </Text>
          </>
        )}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm + 4,
    paddingVertical: spacing.sm + 4,
    paddingLeft: spacing.sm + 4,
    paddingRight: spacing.sm + 2,
    borderRadius: radius.lg,
    backgroundColor: W.face,
    borderWidth: 1,
    borderColor: W.seam,
  },
  badge: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: W.faceAlt,
    borderWidth: 2,
    borderColor: W.rim[1],
  },
  badgeText: { fontFamily: fonts.extrabold, fontSize: 15, color: W.ink },
  label: { flex: 1, fontFamily: fonts.bold, fontSize: 15, color: W.ink },
  price: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minWidth: 112,
    height: 40,
    paddingHorizontal: 14,
    justifyContent: 'center',
    borderRadius: radius.pill,
    backgroundColor: '#FFFFFF',
    borderWidth: 1.5,
    borderColor: W.rim[1],
  },
  pricePressed: { backgroundColor: W.faceAlt },
  priceText: { fontFamily: fonts.bold, fontSize: 13.5, color: W.ink },
  blocked: { opacity: 0.5 },
});
