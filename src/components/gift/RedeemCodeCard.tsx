import { StyleSheet, Text, View } from 'react-native';

import { FeatherIcon } from '../art/FeatherIcon';
import { ProductArt } from '../market/ProductArt';
import { CopyButton } from '../ui/CopyButton';
import { groupCode } from '../../lib/giftMode';
import { useT } from '../../lib/i18n';
import { colors, fonts, radius, shadow, spacing } from '../../lib/theme';
import type { VaultRedeemCode } from '../../lib/vault';

/**
 * A redeem code the customer bought: the second place to get it after the one-time reveal screen. Same art
 * (ProductArt), same grouped code and copy button as that screen. Only a code nobody has used yet can be copied.
 */
export function RedeemCodeCard({ item }: { item: VaultRedeemCode }) {
  const t = useT();
  const active = item.status === 'active';
  const statusLabel = t(item.status === 'active' ? 'vault.code.active' : item.status === 'redeemed' ? 'vault.code.redeemed' : 'vault.code.expired');

  return (
    <View style={[styles.card, shadow.lift, !active && styles.cardDone]}>
      <View style={styles.head}>
        <ProductArt name={item.productName} imageUrl={item.imageUrl} tint={item.tint} size={48} />
        <View style={styles.headText}>
          <View style={styles.badge}>
            <FeatherIcon name="key" size={12} color={colors.limeDark} strokeWidth={2.4} />
            <Text style={styles.badgeText}>{t('orders.gift.code')}</Text>
          </View>
          <Text style={styles.name} numberOfLines={1}>
            {`${item.productName} ${item.optionLabel}`.trim()}
          </Text>
        </View>
        <Text style={[styles.status, item.status === 'expired' && styles.statusExpired, item.status === 'redeemed' && styles.statusDone]}>
          {statusLabel}
        </Text>
      </View>

      <View style={styles.codeRow}>
        <Text
          style={[styles.code, !active && styles.codeDone]}
          selectable={active}
          accessibilityLabel={item.code.split('').join(' ')}
          testID="vault-redeem-code"
        >
          {groupCode(item.code)}
        </Text>
        {active && <CopyButton value={item.code} accessibilityLabel={t('gift.done.copy')} />}
      </View>
      {active && <Text style={styles.hint}>{t('vault.code.hint')}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { padding: spacing.md, borderRadius: radius.xl, backgroundColor: colors.bg, borderWidth: 1.5, borderColor: colors.limeSoft },
  cardDone: { borderColor: colors.border, opacity: 0.8 },
  head: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  headText: { flex: 1, minWidth: 0 },
  badge: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    backgroundColor: colors.limeSoft,
    marginBottom: 4,
  },
  badgeText: { fontFamily: fonts.bold, fontSize: 11, letterSpacing: 0.4, textTransform: 'uppercase', color: colors.limeDark },
  name: { fontFamily: fonts.bold, fontSize: 15, color: colors.text },
  status: { flexShrink: 0, fontFamily: fonts.bold, fontSize: 12, color: colors.limeInk },
  statusDone: { color: colors.textMuted },
  statusExpired: { color: colors.danger },
  codeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    marginTop: spacing.md,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.lg,
    backgroundColor: colors.limeSoft,
  },
  code: { flexShrink: 1, fontFamily: fonts.extrabold, fontSize: 22, letterSpacing: 2, color: colors.text },
  codeDone: { color: colors.textMuted, textDecorationLine: 'line-through' },
  hint: { marginTop: spacing.sm, fontFamily: fonts.regular, fontSize: 12.5, color: colors.textMuted },
});
