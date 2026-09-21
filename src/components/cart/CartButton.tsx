import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useCart } from '../../lib/cart';
import { useT } from '../../lib/i18n';
import { colors, fonts } from '../../lib/theme';
import { FeatherIcon } from '../art/FeatherIcon';

/** The cart icon with the number of items in it. Opens the cart. */
export function CartButton() {
  const { count } = useCart();
  const t = useT();
  return (
    <Pressable
      onPress={() => router.push('/cart')}
      hitSlop={6}
      accessibilityRole="button"
      accessibilityLabel={count > 0 ? `${t('cart.title')}, ${count}` : t('cart.title')}
      style={({ pressed }) => [styles.button, pressed && { opacity: 0.7 }]}
    >
      <FeatherIcon name="shopping-bag" size={22} color={colors.text} />
      {count > 0 && (
        <View style={styles.badge} pointerEvents="none">
          <Text style={styles.badgeText}>{count > 99 ? '99+' : count}</Text>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  badge: {
    position: 'absolute',
    top: 3,
    right: 1,
    minWidth: 18,
    height: 18,
    paddingHorizontal: 4,
    borderRadius: 9,
    backgroundColor: colors.lime,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: { fontFamily: fonts.bold, fontSize: 10.5, color: colors.primary },
});
