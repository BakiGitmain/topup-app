import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useCart } from '../../lib/cart';
import { useT } from '../../lib/i18n';
import { colors, fonts } from '../../lib/theme';
import { FeatherIcon } from '../art/FeatherIcon';

const SIZE = 40;

/**
 * The header's cart icon: a 40x40 button, bag icon, a small dark count badge top-right (only shown above 0, capped
 * "9+"). A header-specific size/badge, not a change to the shared CartButton (still 44x44 with a lime "99+" badge)
 * used on the product page, so that screen's own cart icon is untouched.
 */
export function HeaderCartButton() {
  const { count } = useCart();
  const t = useT();
  const label = count > 0 ? t('header.cartItems', { n: String(count) }) : t('header.cart');

  return (
    <Pressable
      onPress={() => router.push('/cart')}
      hitSlop={4}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [styles.button, pressed && styles.pressed]}
    >
      <FeatherIcon name="shopping-bag" size={20} color={colors.text} strokeWidth={1.8} />
      {count > 0 && (
        <View style={styles.badge} pointerEvents="none">
          <Text style={styles.badgeText}>{count > 9 ? '9+' : count}</Text>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: { width: SIZE, height: SIZE, alignItems: 'center', justifyContent: 'center' },
  pressed: { opacity: 0.6 },
  badge: {
    position: 'absolute',
    top: 3,
    right: 2,
    minWidth: 16,
    height: 16,
    paddingHorizontal: 3,
    borderRadius: 8,
    backgroundColor: colors.text,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: { fontFamily: fonts.bold, fontSize: 9.5, color: colors.bg },
});
