import { useState } from 'react';
import { Pressable, StyleSheet, Switch, Text, View } from 'react-native';

import { formatDateTime } from '../../lib/format';
import { useT } from '../../lib/i18n';
import { colors, fonts, radius, spacing } from '../../lib/theme';
import type { VaultItem } from '../../lib/vault';
import { FeatherIcon } from '../art/FeatherIcon';

type Props = {
  item: VaultItem;
  onCopy: (code: string) => void;
  onToggleUsed: (item: VaultItem, used: boolean) => void;
};

/** A redeemable code: hidden until tapped, one-tap copy, and a used/unused switch. There is no delete. */
export function VaultCard({ item, onCopy, onToggleUsed }: Props) {
  const t = useT();
  const [revealed, setRevealed] = useState(false);

  return (
    <View style={[styles.card, item.is_used && styles.cardUsed]}>
      <View style={styles.head}>
        <View style={styles.icon}>
          <FeatherIcon name="key" size={18} color={colors.limeDark} />
        </View>
        <View style={styles.headText}>
          <Text style={styles.name} numberOfLines={1}>
            {item.productName}
          </Text>
          <Text style={styles.meta} numberOfLines={1}>
            {item.optionLabel}  ·  {formatDateTime(item.created_at)}
          </Text>
        </View>
      </View>

      <View style={styles.codeBox}>
        <Text
          style={[styles.code, !revealed && styles.codeMasked]}
          selectable={revealed}
          numberOfLines={2}
          accessibilityLabel={revealed ? item.code : undefined}
        >
          {revealed ? item.code : '••••  ••••  ••••'}
        </Text>
      </View>

      <View style={styles.actions}>
        <Pressable
          onPress={() => setRevealed((v) => !v)}
          accessibilityRole="button"
          style={({ pressed }) => [styles.action, pressed && styles.pressed]}
        >
          <FeatherIcon name={revealed ? 'eye-off' : 'eye'} size={17} color={colors.text} />
          <Text style={styles.actionText}>{revealed ? t('vault.hide') : t('vault.reveal')}</Text>
        </Pressable>

        <Pressable
          onPress={() => onCopy(item.code)}
          accessibilityRole="button"
          style={({ pressed }) => [styles.action, pressed && styles.pressed]}
        >
          <FeatherIcon name="copy" size={17} color={colors.text} />
          <Text style={styles.actionText}>{t('common.copy')}</Text>
        </Pressable>

        <View style={styles.usedWrap}>
          <Text style={styles.usedLabel}>{t('vault.used')}</Text>
          <Switch
            value={item.is_used}
            onValueChange={(next) => onToggleUsed(item, next)}
            trackColor={{ false: colors.borderStrong, true: colors.limeDeep }}
            thumbColor="#FFFFFF"
            accessibilityLabel={t('vault.markUsed')}
          />
        </View>
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
    gap: spacing.sm + 4,
  },
  cardUsed: { opacity: 0.6 },
  head: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm + 4 },
  icon: {
    width: 38,
    height: 38,
    borderRadius: 12,
    backgroundColor: colors.limeSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headText: { flex: 1 },
  name: { fontFamily: fonts.bold, fontSize: 15, color: colors.text },
  meta: { marginTop: 1, fontFamily: fonts.regular, fontSize: 12.5, color: colors.textMuted },
  codeBox: {
    paddingHorizontal: spacing.md,
    paddingVertical: 14,
    borderRadius: radius.md - 2,
    backgroundColor: colors.bg,
    borderWidth: 1.5,
    borderColor: colors.borderStrong,
    borderStyle: 'dashed',
  },
  code: { fontFamily: fonts.bold, fontSize: 17, letterSpacing: 1.2, color: colors.text },
  codeMasked: { color: colors.textFaint, letterSpacing: 3 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  action: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: 38,
    paddingHorizontal: 12,
    borderRadius: 19,
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  actionText: { fontFamily: fonts.semibold, fontSize: 13, color: colors.text },
  pressed: { opacity: 0.7 },
  usedWrap: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 8 },
  usedLabel: { fontFamily: fonts.semibold, fontSize: 13, color: colors.textMuted },
});
