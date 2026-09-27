import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { useState } from 'react';
import { Platform, Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring, withTiming } from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';

import { formatBirr } from '../../lib/pricing';
import { formatDateTime } from '../../lib/format';
import { useT } from '../../lib/i18n';
import { colors, fonts, gradients, radius, shadow, spacing } from '../../lib/theme';
import { useCopyFeedback } from '../../lib/useCopyFeedback';
import type { VaultItem } from '../../lib/vault';
import { vaultBrandOf } from '../../lib/vaultBrands';
import { FeatherIcon } from '../art/FeatherIcon';

type Props = {
  item: VaultItem;
  onToggleUsed: (item: VaultItem, used: boolean) => void;
};

// A tiny press-in/out spring, the same shape GlassTabBar's own button feedback uses (see TabButton in
// components/nav/GlassTabBar.tsx): a quick timing down, a spring back up. Kept subtle -- this is a physical
// response to touch, not a gesture the customer has to learn.
const TILT_IN = { duration: 90 };
const SETTLE = { damping: 14, stiffness: 220 };

/**
 * A gift-card product's Vault entry, styled like a real card (an Apple Wallet pass, not a receipt row): the
 * product's own brand gradient and mark where one has been sourced (vaultBrands.ts), a plain dark card otherwise --
 * never a fake logo. The redeemable code keeps the exact reveal/hide/copy/used mechanics the plain row already had;
 * only the face changes.
 */
export function VaultCard({ item, onToggleUsed }: Props) {
  const t = useT();
  const [revealed, setRevealed] = useState(false);
  const { copied, copy } = useCopyFeedback();
  const brand = vaultBrandOf(item.productName);
  const gradientColors = brand?.gradient ?? gradients.vaultNeutral;

  const scale = useSharedValue(1);
  const tilt = useSharedValue(0);
  const pressStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.get() }, { rotateZ: `${tilt.get()}deg` }],
  }));
  function pressIn() {
    scale.set(withTiming(0.97, TILT_IN));
    tilt.set(withTiming(-0.5, TILT_IN));
  }
  function pressOut() {
    scale.set(withSpring(1, SETTLE));
    tilt.set(withSpring(0, SETTLE));
  }
  function toggleReveal() {
    if (Platform.OS !== 'web') Haptics.selectionAsync().catch(() => {});
    setRevealed((v) => !v);
  }

  return (
    <Animated.View style={[shadow.lift, styles.wrap, pressStyle, item.is_used && styles.wrapUsed]}>
      <Pressable
        onPressIn={pressIn}
        onPressOut={pressOut}
        onPress={toggleReveal}
        accessibilityRole="button"
        accessibilityLabel={`${item.productName}, ${item.optionLabel}`}
        style={styles.pressable}
      >
        <LinearGradient colors={gradientColors} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.card}>
          <View style={styles.head}>
            {brand ? (
              <View style={styles.logoBadge}>
                <Image source={brand.logo} style={styles.logo} contentFit="contain" accessibilityIgnoresInvertColors />
              </View>
            ) : (
              <View style={[styles.logoBadge, styles.logoFallback]}>
                <Text style={styles.logoFallbackText}>{item.productName.charAt(0).toUpperCase()}</Text>
              </View>
            )}
            <View style={styles.headText}>
              <Text style={styles.brand} numberOfLines={1}>
                {item.productName}
              </Text>
              <Text style={styles.date} numberOfLines={1}>
                {formatDateTime(item.created_at)}
              </Text>
            </View>
            {item.is_used && (
              <View style={styles.usedTag}>
                <Text style={styles.usedTagText}>{t('vault.used')}</Text>
              </View>
            )}
          </View>

          <View style={styles.balanceBlock}>
            <Text style={styles.balanceValue} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6}>
              {item.optionLabel}
            </Text>
            <Text style={styles.paid}>{t('vault.paidAmount', { amount: formatBirr(item.amount) })}</Text>
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
              onPress={toggleReveal}
              accessibilityRole="button"
              style={({ pressed }) => [styles.action, pressed && styles.actionPressed]}
            >
              <FeatherIcon name={revealed ? 'eye-off' : 'eye'} size={16} color="#FFFFFF" />
              <Text style={styles.actionText}>{revealed ? t('vault.hide') : t('vault.reveal')}</Text>
            </Pressable>

            <Pressable
              onPress={() => copy(item.code)}
              accessibilityRole="button"
              style={({ pressed }) => [styles.action, pressed && styles.actionPressed]}
            >
              <FeatherIcon name={copied ? 'check' : 'copy'} size={16} color="#FFFFFF" />
              <Text style={styles.actionText}>{t(copied ? 'common.copied' : 'common.copy')}</Text>
            </Pressable>

            <View style={styles.usedWrap}>
              <Text style={styles.usedLabel}>{t('vault.used')}</Text>
              <Switch
                value={item.is_used}
                onValueChange={(next) => onToggleUsed(item, next)}
                trackColor={{ false: 'rgba(255,255,255,0.3)', true: colors.lime }}
                thumbColor="#FFFFFF"
                accessibilityLabel={t('vault.markUsed')}
              />
            </View>
          </View>
        </LinearGradient>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: { borderRadius: radius.xl },
  wrapUsed: { opacity: 0.72 },
  pressable: { borderRadius: radius.xl, overflow: 'hidden' },
  card: { padding: spacing.md + 2, borderRadius: radius.xl, gap: spacing.sm + 4 },
  head: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm + 4 },
  logoBadge: {
    width: 38,
    height: 38,
    borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.16)',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  logo: { width: 30, height: 30 },
  logoFallback: { backgroundColor: 'rgba(255,255,255,0.16)' },
  logoFallbackText: { fontFamily: fonts.extrabold, fontSize: 17, color: '#FFFFFF' },
  headText: { flex: 1 },
  brand: { fontFamily: fonts.bold, fontSize: 15, color: '#FFFFFF' },
  date: { marginTop: 1, fontFamily: fonts.regular, fontSize: 12, color: 'rgba(255,255,255,0.65)' },
  usedTag: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: radius.pill, backgroundColor: 'rgba(255,255,255,0.18)' },
  usedTagText: { fontFamily: fonts.bold, fontSize: 11, letterSpacing: 0.3, color: '#FFFFFF' },
  balanceBlock: { gap: 2 },
  balanceValue: { fontFamily: fonts.extrabold, fontSize: 28, letterSpacing: -0.5, color: '#FFFFFF' },
  paid: { fontFamily: fonts.medium, fontSize: 13, color: 'rgba(255,255,255,0.7)' },
  codeBox: {
    paddingHorizontal: spacing.md,
    paddingVertical: 14,
    borderRadius: radius.md - 2,
    backgroundColor: 'rgba(255,255,255,0.12)',
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.28)',
    borderStyle: 'dashed',
  },
  code: { fontFamily: fonts.bold, fontSize: 17, letterSpacing: 1.2, color: '#FFFFFF' },
  codeMasked: { color: 'rgba(255,255,255,0.75)', letterSpacing: 3 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  action: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: 38,
    paddingHorizontal: 12,
    borderRadius: 19,
    backgroundColor: 'rgba(255,255,255,0.14)',
  },
  actionPressed: { opacity: 0.7 },
  actionText: { fontFamily: fonts.semibold, fontSize: 13, color: '#FFFFFF' },
  usedWrap: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 8 },
  usedLabel: { fontFamily: fonts.semibold, fontSize: 13, color: 'rgba(255,255,255,0.85)' },
});
