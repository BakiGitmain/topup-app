import { StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import { useAuth } from '../../lib/auth';
import { fetchPortalCoinBalance } from '../../lib/portalCoin';
import { colors, fonts } from '../../lib/theme';
import { useAsync } from '../../lib/useAsync';
import { HeaderCartButton } from './HeaderCartButton';
import { LanguageButton } from './LanguageButton';
import { NotificationBell } from './NotificationBell';
import { WalletPill } from './WalletPill';

const HEIGHT = 56;
// Below this width the language button drops its "EN"/"አማ" text (icon only) to make room -- the balance must
// never be the thing that gets hidden or truncated (see the brief's edge cases). Raised from 340 to 400 when the
// notification bell joined the row: at 360 the extra 48pt squeezed the balance out of the pill entirely.
const NARROW_WIDTH = 400;

type Props = {
  /** The "+" on the wallet pill and the menu's "Top up wallet" button both call this. */
  onTopUp: () => void;
  /** The menu's "Withdraw" button. */
  onWithdraw: () => void;
  /** Shown as "Sign in" in place of the wallet pill when signed out. */
  onSignIn: () => void;
};

/**
 * The shop's top bar: logo, language button, cart, notification bell (signed in only), wallet pill. Self-contained -- reads auth/cart state itself, so
 * a screen only has to wire up navigation. Reuse pattern for a future header: one outer row component (this file)
 * composed from small, single-purpose controls (LanguageButton, HeaderCartButton, WalletPill/WalletMenu), each
 * either self-fetching its own data via a context hook (language, cart count -- nothing else needs to know) or
 * taking plain props for data a screen already owns (balance, points) plus navigation callbacks. Swap the controls
 * in the row to reuse the same shell elsewhere.
 */
export function ShopHeader({ onTopUp, onWithdraw, onSignIn }: Props) {
  const { session, user, balance, initializing } = useAuth();
  const userId = user?.id;
  const points = useAsync(() => (userId ? fetchPortalCoinBalance(userId) : Promise.resolve(null)), userId ?? '', !!userId);
  const { width } = useWindowDimensions();
  const narrow = width <= NARROW_WIDTH;

  return (
    <View style={styles.row}>
      {/* On a narrow phone the full wordmark would only ever show as "Portal T…" (four controls and the balance
          need the room), so it becomes its compact mark instead of a truncated word. */}
      <Text style={styles.brand} numberOfLines={1} accessibilityLabel="Portal Topup">
        {narrow ? 'P' : 'Portal Topup'}
        <Text style={styles.brandDot}>.</Text>
      </Text>

      <View style={[styles.right, narrow && styles.rightNarrow]}>
        <LanguageButton compact={narrow} />
        <HeaderCartButton />
        {session ? <NotificationBell /> : null}
        <WalletPill
          loading={initializing}
          signedIn={!!session}
          balance={balance}
          pointsBalance={points.data}
          onTopUp={onTopUp}
          onWithdraw={onWithdraw}
          onSignIn={onSignIn}
          onOpenMenu={points.reload}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    height: HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    backgroundColor: colors.bg,
    borderBottomWidth: 1,
    borderBottomColor: colors.headerBorder,
  },
  // The controls never shrink (the balance must stay whole); the brand takes what's left.
  right: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 0 },
  rightNarrow: { gap: 4 },
  brand: { fontFamily: fonts.bold, fontSize: 19, color: colors.text, letterSpacing: -0.4, flexShrink: 1, minWidth: 0, marginRight: 8 },
  brandDot: { color: colors.headerAccentDot },
});
