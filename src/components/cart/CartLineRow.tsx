import { useEffect } from 'react';
import { IconButton } from '../ui/IconButton';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { CartLine } from '../../lib/cartApi';
import { formatBirr } from '../../lib/catalog';
import { continueBlocker, isFieldsComplete } from '../../lib/idValidation';
import { useT } from '../../lib/i18n';
import { packageState } from '../../lib/regionMatch';
import { colors, fonts, radius, spacing } from '../../lib/theme';
import { useIdValidation } from '../../lib/useIdValidation';
import { CheckStatus } from '../product/IdForm';
import { CheckRow } from '../ui/CheckRow';

type Props = {
  line: CartLine;
  /** Reports whether this line may be checked out (null) or what blocks it. Called when it changes. */
  onBlocker: (lineId: string, blocker: string | null) => void;
  onQty: (lineId: string, quantity: number) => void;
  onTick: (lineId: string, checked: boolean) => void;
  onRemove: (lineId: string) => void;
};

/**
 * One cart line, with ITS OWN player ID. The ID is checked with the game here (the same server check the product page
 * uses), so a line with an unchecked, invalid or expired ID blocks checkout and says so.
 */
export function CartLineRow({ line, onBlocker, onQty, onTick, onRemove }: Props) {
  const t = useT();
  const complete = isFieldsComplete(line.buyerFields, line.fields);
  const { check, retry } = useIdValidation({
    regionId: line.regionId,
    buyerFields: line.buyerFields,
    values: line.fields,
    enabled: line.available && line.idMode === 'supplier',
  });

  const accountRegion = check.kind === 'valid' ? check.accountRegion : null;
  const pkgState = packageState(
    { regionLocked: line.regionLocked, accountRegionCodes: line.accountRegionCodes },
    { idMode: line.idMode, validated: check.kind === 'valid', accountRegion }
  );
  const blocker = line.available
    ? continueBlocker({ hasPackage: true, packageState: pkgState, fieldsComplete: complete, idMode: line.idMode, check, ticked: line.idChecked })
    : 'unavailable';

  useEffect(() => {
    onBlocker(line.id, line.available ? blocker : null);
  }, [line.id, line.available, blocker, onBlocker]);

  const total = line.unitPrice * line.quantity;

  return (
    <View style={[styles.card, !line.available && styles.cardGone]} accessibilityLabel={`${line.productName} ${line.label}`}>
      <View style={styles.top}>
        <View style={styles.titles}>
          <Text style={styles.name} numberOfLines={2}>
            {line.available ? line.productName : t('cart.unavailable')}
          </Text>
          {line.available && (
            <Text style={styles.label} numberOfLines={2}>
              {line.label}
              {line.regionLabel ? `  ·  ${line.regionLabel}` : ''}
            </Text>
          )}
        </View>
        {line.available && <Text style={styles.price}>{formatBirr(total)}</Text>}
      </View>

      {!line.available && <Text style={styles.gone}>{t('cart.unavailableBody')}</Text>}

      {line.available &&
        line.buyerFields.map((field) => (
          <Text key={field.key} style={styles.idLine} numberOfLines={1}>
            {field.label}: <Text style={styles.idValue}>{line.fields[field.key] ?? ''}</Text>
          </Text>
        ))}

      {line.available && line.idMode === 'supplier' && <CheckStatus check={check} onRetry={retry} />}
      {line.available && line.idMode === 'tick' && (
        <CheckRow checked={line.idChecked} onChange={(v) => onTick(line.id, v)} label={t('product.tick')} />
      )}
      {line.available && line.idMode === 'supplier' && (pkgState === 'wrong_region' || pkgState === 'region_unknown') && (
        <Text style={styles.problem}>{pkgState === 'wrong_region' ? t('product.packWrongRegion') : t('product.packUnknownRegion')}</Text>
      )}

      <View style={styles.bottom}>
        {line.available ? (
          <View style={styles.stepper} accessibilityRole="adjustable" accessibilityLabel={t('cart.qty')} accessibilityValue={{ now: line.quantity }}>
            <Pressable
              onPress={() => onQty(line.id, line.quantity - 1)}
              disabled={line.quantity <= 1}
              accessibilityRole="button"
              accessibilityLabel="-"
              style={[styles.stepButton, line.quantity <= 1 && styles.disabled]}
            >
              <Text style={styles.stepText}>−</Text>
            </Pressable>
            <Text style={styles.qty}>{line.quantity}</Text>
            <Pressable
              onPress={() => onQty(line.id, line.quantity + 1)}
              disabled={line.quantity >= 20}
              accessibilityRole="button"
              accessibilityLabel="+"
              style={[styles.stepButton, line.quantity >= 20 && styles.disabled]}
            >
              <Text style={styles.stepText}>+</Text>
            </Pressable>
          </View>
        ) : (
          <View />
        )}
        <IconButton icon="trash-2" label={`${t('cart.remove')} ${line.productName} ${line.label}`} onPress={() => onRemove(line.id)} tone="danger" size={40} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    padding: spacing.md,
    borderRadius: radius.lg - 4,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: spacing.sm + 2,
  },
  cardGone: { backgroundColor: colors.dangerBg, borderColor: colors.dangerBorder },
  top: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  titles: { flex: 1 },
  name: { fontFamily: fonts.bold, fontSize: 15.5, color: colors.text },
  label: { marginTop: 2, fontFamily: fonts.medium, fontSize: 13.5, color: colors.textMuted },
  price: { fontFamily: fonts.extrabold, fontSize: 16, color: colors.limeInk },
  gone: { marginTop: spacing.xs, fontFamily: fonts.medium, fontSize: 13, color: colors.danger },
  idLine: { marginTop: spacing.sm, fontFamily: fonts.regular, fontSize: 13.5, color: colors.textMuted },
  idValue: { fontFamily: fonts.bold, color: colors.text },
  problem: { marginTop: spacing.xs, fontFamily: fonts.medium, fontSize: 13, color: colors.danger },
  bottom: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: spacing.sm },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  stepButton: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.borderStrong, alignItems: 'center', justifyContent: 'center' },
  stepText: { fontFamily: fonts.bold, fontSize: 20, color: colors.text, lineHeight: 24 },
  qty: { minWidth: 28, textAlign: 'center', fontFamily: fonts.bold, fontSize: 16, color: colors.text },
  disabled: { opacity: 0.4 },
  remove: { minHeight: 44, minWidth: 64, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.sm },
  removeText: { fontFamily: fonts.bold, fontSize: 14, color: colors.danger },
});
