import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import type { BuyerField, IdCheck } from '../../lib/idValidation';
import { useT } from '../../lib/i18n';
import { colors, fonts, radius, spacing } from '../../lib/theme';
import { FeatherIcon } from '../art/FeatherIcon';
import { Chips } from '../ui/Chips';
import { CheckRow } from '../ui/CheckRow';
import { PasteButton } from '../ui/PasteButton';
import { TextField } from '../ui/TextField';

type Props = {
  fields: BuyerField[];
  values: Record<string, string>;
  onChange: (key: string, value: string) => void;
  /** 'supplier' shows the live check, 'tick' shows the checkbox, 'none' just the fields. */
  mode: 'supplier' | 'tick' | 'none';
  check: IdCheck;
  onRetry: () => void;
  ticked: boolean;
  onTick: (ticked: boolean) => void;
  hint?: string;
};

export function IdForm({ fields, values, onChange, mode, check, onRetry, ticked, onTick, hint }: Props) {
  const t = useT();
  if (fields.length === 0) return null;

  return (
    <View>
      {fields.map((field) =>
        field.type === 'select' ? (
          <View key={field.key} style={styles.select}>
            <Text style={styles.selectLabel}>{field.label}</Text>
            <Chips
              options={(field.options ?? []).map((o) => ({ id: o.value, label: o.label }))}
              value={values[field.key] ?? ''}
              onChange={(v) => onChange(field.key, v)}
            />
          </View>
        ) : (
          <TextField
            key={field.key}
            label={field.label}
            value={values[field.key] ?? ''}
            onChangeText={(v) => onChange(field.key, v)}
            autoCapitalize="none"
            autoCorrect={false}
            maxLength={128}
            returnKeyType="done"
            accessibilityLabel={field.label}
            right={<PasteButton onPaste={(text) => onChange(field.key, text)} />}
          />
        )
      )}

      {hint ? <Text style={styles.hint}>{hint}</Text> : null}

      {mode === 'supplier' && <CheckStatus check={check} onRetry={onRetry} />}

      {mode === 'tick' && (
        <View style={styles.tick}>
          <CheckRow checked={ticked} onChange={onTick} label={t('product.tick')} />
        </View>
      )}
    </View>
  );
}

export function CheckStatus({ check, onRetry }: { check: IdCheck; onRetry: () => void }) {
  const t = useT();

  if (check.kind === 'idle') return null;

  if (check.kind === 'checking') {
    return (
      <View style={styles.row} accessibilityLiveRegion="polite" accessibilityRole="progressbar" accessibilityLabel={t('product.checking')}>
        <ActivityIndicator size="small" color={colors.limeDeep} />
        <Text style={styles.muted}>{t('product.checking')}</Text>
      </View>
    );
  }

  if (check.kind === 'valid') {
    // The player's name is rendered exactly as the supplier sent it: one line, ellipsis, never sanitized.
    return (
      <View
        style={[styles.row, styles.valid]}
        accessible
        accessibilityLiveRegion="polite"
        accessibilityLabel={check.playerName ? t('product.playerLabel', { name: check.playerName }) : t('product.checking')}
      >
        <View style={styles.validIcon}>
          <FeatherIcon name="check" size={16} color={colors.text} strokeWidth={3} />
        </View>
        <View style={styles.validText}>
          {check.playerName !== null && (
            <Text style={styles.name} numberOfLines={1} ellipsizeMode="tail">
              {check.playerName}
            </Text>
          )}
          {check.accountRegion !== null && (
            <Text style={styles.muted}>{t('product.playerRegion', { region: check.accountRegion })}</Text>
          )}
        </View>
      </View>
    );
  }

  const message =
    check.kind === 'invalid'
      ? t('product.check.invalid')
      : check.kind === 'expired'
        ? t('product.check.expired')
        : check.reason === 'timeout'
          ? t('product.check.timeout')
          : t('product.check.failed');

  return (
    <View style={styles.problem} accessibilityRole="alert">
      <Text style={styles.problemText}>{message}</Text>
      {check.kind !== 'invalid' && (
        <Pressable
          onPress={onRetry}
          accessibilityRole="button"
          accessibilityLabel={check.kind === 'expired' ? t('product.checkAgain') : t('product.retry')}
          style={({ pressed }) => [styles.retry, pressed && { opacity: 0.8 }]}
        >
          <FeatherIcon name="refresh-cw" size={16} color={colors.text} />
          <Text style={styles.retryText}>{check.kind === 'expired' ? t('product.checkAgain') : t('product.retry')}</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  select: { marginBottom: spacing.md },
  selectLabel: { fontFamily: fonts.semibold, fontSize: 14, color: colors.textMuted, marginBottom: spacing.sm },
  hint: { fontFamily: fonts.regular, fontSize: 13, lineHeight: 18, color: colors.textMuted, marginTop: -spacing.xs, marginBottom: spacing.sm },
  tick: { marginTop: spacing.sm },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm + 2, minHeight: 44, marginTop: spacing.xs },
  muted: { fontFamily: fonts.medium, fontSize: 13, color: colors.textMuted },
  valid: {
    padding: spacing.sm + 2,
    borderRadius: radius.md,
    backgroundColor: colors.limeSoft,
  },
  validIcon: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: colors.lime,
    alignItems: 'center',
    justifyContent: 'center',
  },
  validText: { flex: 1 },
  name: { fontFamily: fonts.bold, fontSize: 15.5, color: colors.text },
  problem: {
    marginTop: spacing.xs,
    padding: spacing.md - 2,
    borderRadius: radius.md,
    backgroundColor: colors.dangerBg,
    borderWidth: 1,
    borderColor: colors.dangerBorder,
    gap: spacing.sm,
  },
  problemText: { fontFamily: fonts.medium, fontSize: 14, lineHeight: 20, color: colors.danger },
  retry: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minHeight: 44,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    backgroundColor: colors.lime,
  },
  retryText: { fontFamily: fonts.bold, fontSize: 14.5, color: colors.text },
});
