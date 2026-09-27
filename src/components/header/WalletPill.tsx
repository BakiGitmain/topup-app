import { useEffect, useState } from 'react';
import { Animated, Easing, Pressable, StyleSheet, Text, View } from 'react-native';

import { formatBirrExact } from '../../lib/format';
import { useT } from '../../lib/i18n';
import { colors, fonts, radius, spacing } from '../../lib/theme';
import { useReducedMotion } from '../../lib/useReducedMotion';
import { FeatherIcon } from '../art/FeatherIcon';
import { WalletMenu } from './WalletMenu';

const HEIGHT = 36;

type Props = {
  /** True once the session is known and, if signed in, the account has finished its first load. */
  loading: boolean;
  signedIn: boolean;
  /** Null while loading or unavailable -- the pill shows "Br —", never a crash. */
  balance: number | null;
  pointsBalance: number | null;
  /** Tapping the "+" square goes straight here -- it never opens the menu. */
  onTopUp: () => void;
  /** Reached from inside the menu only (same place the old /wallet screen put it, next to Deposit). */
  onWithdraw: () => void;
  onSignIn: () => void;
  /** Called right when the menu opens, so the points balance shown is never more stale than "last time it was looked at". */
  onOpenMenu?: () => void;
};

/**
 * The header's wallet control. Signed out: a plain "Sign in" button, no pill. Signed in: the green balance pill --
 * tapping the balance opens WalletMenu (reward points + a Top up button); tapping the "+" square skips the menu
 * and goes straight to top-up, per the two separate tap targets the mockup calls out.
 */
export function WalletPill({ loading, signedIn, balance, pointsBalance, onTopUp, onWithdraw, onSignIn, onOpenMenu }: Props) {
  const t = useT();
  const [menuOpen, setMenuOpen] = useState(false);

  if (!signedIn) {
    return (
      <Pressable
        onPress={onSignIn}
        accessibilityRole="button"
        accessibilityLabel={t('header.signIn')}
        style={({ pressed }) => [styles.signIn, pressed && styles.pressed]}
      >
        <Text style={styles.signInText}>{t('header.signIn')}</Text>
      </Pressable>
    );
  }

  return (
    <View style={styles.pill}>
      <Pressable
        onPress={() => {
          setMenuOpen(true);
          onOpenMenu?.();
        }}
        hitSlop={{ top: 8, bottom: 8, left: 6, right: 0 }}
        accessibilityRole="button"
        accessibilityLabel={loading ? t('header.walletUnavailable') : t('header.wallet', { amount: formatBirrExact(balance) })}
        style={({ pressed }) => [styles.main, pressed && styles.pressed]}
      >
        {loading ? (
          <BalanceSkeleton />
        ) : (
          <Text style={styles.amount} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8}>
            {formatBirrExact(balance)}
          </Text>
        )}
      </Pressable>

      <Pressable
        onPress={onTopUp}
        hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
        accessibilityRole="button"
        accessibilityLabel={t('header.topUp')}
        style={({ pressed }) => [styles.add, pressed && styles.pressed]}
      >
        <FeatherIcon name="plus" size={14} color="#FFFFFF" strokeWidth={2.4} />
      </Pressable>

      <WalletMenu
        visible={menuOpen}
        onClose={() => setMenuOpen(false)}
        balance={balance}
        pointsBalance={pointsBalance}
        onTopUp={onTopUp}
        onWithdraw={onWithdraw}
      />
    </View>
  );
}

/** A small pulsing bar in place of the amount while the wallet loads. */
function BalanceSkeleton() {
  const reduced = useReducedMotion();
  const [pulse] = useState(() => new Animated.Value(0));

  useEffect(() => {
    if (reduced) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 700, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 700, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [pulse, reduced]);

  const opacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.4, 0.85] });
  return <Animated.View style={[styles.skeleton, { opacity }]} />;
}

const styles = StyleSheet.create({
  pill: {
    // Never shrinks: when the header runs short of room, the brand text gives way, not the balance.
    flexShrink: 0,
    height: HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingLeft: 12,
    paddingRight: 4,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.walletGreenBorder,
    backgroundColor: colors.walletGreenBg,
  },
  main: { height: '100%', justifyContent: 'center' },
  pressed: { opacity: 0.65 },
  amount: { fontFamily: fonts.bold, fontSize: 14, color: colors.walletGreen, letterSpacing: -0.2 },
  skeleton: { width: 56, height: 13, borderRadius: 4, backgroundColor: colors.walletGreenBorder },
  add: {
    width: 28,
    height: 28,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.walletGreen,
  },
  signIn: {
    height: HEIGHT,
    paddingHorizontal: spacing.md - 2,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.primary,
  },
  signInText: { fontFamily: fonts.bold, fontSize: 13.5, color: colors.primaryText },
});
