import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { formatBirrExact } from '../../lib/format';
import { useT } from '../../lib/i18n';
import { colors, fonts, radius, shadow, spacing } from '../../lib/theme';
import { FeatherIcon } from '../art/FeatherIcon';

const HEADER_HEIGHT = 56;
const CARD_WIDTH = 250;

type Props = {
  visible: boolean;
  onClose: () => void;
  /** Null while loading or unavailable -- rendered as "Br —" (see formatBirrExact), never a crash. */
  balance: number | null;
  /** Null while loading or unavailable. */
  pointsBalance: number | null;
  onTopUp: () => void;
  onWithdraw: () => void;
};

/**
 * The dropdown opened by tapping the wallet pill's balance: anchored top-right, under the header. Same Modal +
 * full-screen dimmed backdrop + a nested Pressable to stop a tap on the card falling through, as ConfirmHost and
 * BottomSheet already use elsewhere in this app -- `onRequestClose` covers the Android back button (and Escape on
 * web/desktop) for free, same as those. Closes on: outside tap, back/Escape, or picking Top up / Withdraw (both
 * also navigate). Withdraw sits right under Top up, same pairing the old /wallet screen used (Deposit then
 * Withdraw, outline style) -- carried into the dropdown, not dropped, when that screen's header moved here.
 */
export function WalletMenu({ visible, onClose, balance, pointsBalance, onTopUp, onWithdraw }: Props) {
  const t = useT();
  const insets = useSafeAreaInsets();

  function topUp() {
    onClose();
    onTopUp();
  }

  function withdraw() {
    onClose();
    onWithdraw();
  }

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityRole="button" accessibilityLabel={t('common.cancel')}>
        <View style={[styles.anchor, { top: insets.top + HEADER_HEIGHT + 6 }]} pointerEvents="box-none">
          {/* A press on the card itself must not fall through to the backdrop. */}
          <Pressable style={styles.card} onPress={() => {}} accessible={false}>
            <Text style={styles.label}>{t('header.walletBalanceLabel')}</Text>
            <Text style={styles.balance} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>
              {formatBirrExact(balance)}
            </Text>

            <View style={styles.pointsRow}>
              <FeatherIcon name="star" size={15} color={colors.limeDark} />
              <Text style={styles.pointsLabel}>{t('header.rewardPoints')}</Text>
              <Text style={styles.pointsValue}>{pointsBalance === null ? '—' : pointsBalance}</Text>
            </View>

            <Pressable
              onPress={topUp}
              accessibilityRole="button"
              accessibilityLabel={t('header.topUpWallet')}
              style={({ pressed }) => [styles.topUpButton, pressed && styles.pressed]}
            >
              <Text style={styles.topUpText}>{t('header.topUpWallet')}</Text>
            </Pressable>

            <Pressable
              onPress={withdraw}
              accessibilityRole="button"
              accessibilityLabel={t('wallet.withdraw')}
              style={({ pressed }) => [styles.withdrawButton, pressed && styles.pressed]}
            >
              <Text style={styles.withdrawText}>{t('wallet.withdraw')}</Text>
            </Pressable>
          </Pressable>
        </View>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(20, 26, 18, 0.35)' },
  anchor: { position: 'absolute', right: spacing.md, alignItems: 'flex-end' },
  card: {
    width: CARD_WIDTH,
    padding: 14,
    borderRadius: 18,
    backgroundColor: colors.bg,
    ...shadow.lift,
  },
  label: { fontFamily: fonts.bold, fontSize: 11, letterSpacing: 0.4, textTransform: 'uppercase', color: colors.textMuted },
  balance: { marginTop: 2, fontFamily: fonts.extrabold, fontSize: 24, color: colors.text, letterSpacing: -0.5 },
  pointsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: spacing.sm + 2,
    padding: spacing.sm + 2,
    borderRadius: radius.sm,
    backgroundColor: colors.surface,
  },
  pointsLabel: { flex: 1, fontFamily: fonts.semibold, fontSize: 13.5, color: colors.text },
  pointsValue: { fontFamily: fonts.bold, fontSize: 13.5, color: colors.text },
  topUpButton: {
    marginTop: spacing.sm + 2,
    height: 42,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.walletGreen,
  },
  pressed: { opacity: 0.85 },
  topUpText: { fontFamily: fonts.bold, fontSize: 14.5, color: '#FFFFFF' },
  withdrawButton: {
    marginTop: spacing.sm,
    height: 42,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.walletGreenBorder,
    backgroundColor: colors.bg,
  },
  withdrawText: { fontFamily: fonts.bold, fontSize: 14.5, color: colors.walletGreen },
});
