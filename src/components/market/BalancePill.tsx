import { Pressable, StyleSheet, Text, View } from 'react-native';

import { formatBirr } from '../../lib/catalog';
import { useT } from '../../lib/i18n';
import { colors, fonts } from '../../lib/theme';
import { PlusIcon, WalletIcon } from '../art/Icons';

type Props = {
  /** Null when the wallet couldn't be read. */
  balance: number | null;
  /** Tapping the pill opens the wallet. */
  onPress: () => void;
  /** Tapping the small "+" goes straight to depositing. */
  onAdd: () => void;
};

const HEIGHT = 34;

/**
 * The balance in the header: a small wallet icon and the amount, nothing else ("Br 0"). Deliberately light: no gradient,
 * no shadow, no label. Tap it for the wallet; the "+" beside it is a quiet shortcut into the deposit flow.
 */
export function BalancePill({ balance, onPress, onAdd }: Props) {
  const t = useT();
  const amount = balance === null ? '—' : formatBirr(balance);
  // Long balances step down in size so they never get cut off.
  const amountSize = amount.length <= 8 ? 14 : amount.length <= 11 ? 13 : 12;

  return (
    <View style={styles.pill}>
      <Pressable
        onPress={onPress}
        hitSlop={{ top: 8, bottom: 8, left: 6, right: 0 }}
        accessibilityRole="button"
        accessibilityLabel={balance === null ? t('wallet.unavailable') : t('wallet.open', { amount })}
        style={({ pressed }) => [styles.main, pressed && styles.pressed]}
      >
        <WalletIcon size={16} color={colors.limeDark} />
        <Text style={[styles.amount, { fontSize: amountSize }]} numberOfLines={1}>
          {amount}
        </Text>
      </Pressable>

      <Pressable
        onPress={onAdd}
        hitSlop={{ top: 8, bottom: 8, left: 4, right: 8 }}
        accessibilityRole="button"
        accessibilityLabel={t('wallet.add')}
        style={({ pressed }) => [styles.add, pressed && styles.pressed]}
      >
        <PlusIcon size={13} color={colors.limeInk} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexShrink: 1,
    height: HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: HEIGHT / 2,
    borderWidth: 1,
    borderColor: colors.limeSoft,
    backgroundColor: colors.bgTint,
  },
  main: { flexShrink: 1, height: '100%', flexDirection: 'row', alignItems: 'center', gap: 5, paddingLeft: 10, paddingRight: 4 },
  pressed: { opacity: 0.6 },
  amount: { flexShrink: 1, fontFamily: fonts.bold, color: colors.limeDark, letterSpacing: -0.2 },
  add: { height: '100%', justifyContent: 'center', paddingLeft: 4, paddingRight: 10 },
});
