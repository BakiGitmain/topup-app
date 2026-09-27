import { StyleSheet, Text, View } from 'react-native';

import { useT } from '../../lib/i18n';
import type { GiftTerm } from '../../lib/giftMode';
import { colors, fonts, radius, spacing } from '../../lib/theme';
import { FeatherIcon } from '../art/FeatherIcon';

/**
 * What a gift buyer must know before paying (lib/giftMode giftTerms): no refunds, the 90-day expiry, and for a
 * region-locked pack which accounts can claim it. Shown under the packs in gift mode, before the buy button.
 */
export function GiftTerms({ terms }: { terms: GiftTerm[] }) {
  const t = useT();
  return (
    <View style={styles.box} accessibilityRole="summary">
      <Text style={styles.title}>{t('gift.terms.title')}</Text>
      {terms.map((term) => (
        <View key={term.key} style={styles.row}>
          <FeatherIcon name={term.key === 'gift.terms.noRefund' ? 'alert-triangle' : 'globe'} size={15} color={colors.textMuted} />
          <Text style={styles.text}>{term.key === 'gift.terms.noRefund' ? t(term.key) : t(term.key, { regions: term.regions })}</Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { marginTop: spacing.lg, padding: spacing.md, gap: spacing.sm, borderRadius: radius.lg, backgroundColor: colors.surface },
  title: { fontFamily: fonts.bold, fontSize: 14, color: colors.text },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  text: { flex: 1, fontFamily: fonts.regular, fontSize: 13.5, lineHeight: 19, color: colors.textMuted },
});
