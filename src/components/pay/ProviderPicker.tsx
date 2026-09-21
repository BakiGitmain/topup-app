import { Image } from 'expo-image';
import * as Haptics from 'expo-haptics';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { useT } from '../../lib/i18n';
import type { ProviderId } from '../../lib/paymentView';
import { colors, fonts, radius, spacing } from '../../lib/theme';
import { FeatherIcon } from '../art/FeatherIcon';

// Official marks, taken from each provider's own website (see assets/payments): Telebirr's logo from ethiotelecom.et, CBE's
// emblem from combanketh.et. Shown small, next to the choice, the way any payment-method selector does.
const TELEBIRR = require('../../../assets/payments/telebirr.png');
const CBE = require('../../../assets/payments/cbe.png');

/** The provider's mark at a small size. Telebirr's is a wide wordmark (it already says "telebirr"); CBE's is a square emblem. */
export function ProviderMark({ provider, height = 28 }: { provider: ProviderId; height?: number }) {
  return provider === 'telebirr' ? (
    <Image source={TELEBIRR} style={{ width: Math.round(height * 2.57), height }} contentFit="contain" accessibilityIgnoresInvertColors />
  ) : (
    <Image source={CBE} style={{ width: height, height }} contentFit="contain" accessibilityIgnoresInvertColors />
  );
}

type Props = {
  value: ProviderId;
  onChange: (provider: ProviderId) => void;
  label: string;
};

/**
 * Choose how to pay: two cards side by side, Telebirr first, then CBE, each with its real logo. No "recommended" tag on either.
 * Telebirr's wordmark stands alone; CBE's emblem is followed by "CBE" so it reads without knowing the emblem.
 */
export function ProviderPicker({ value, onChange, label }: Props) {
  const t = useT();
  const options: ProviderId[] = ['telebirr', 'cbe'];

  return (
    <View style={styles.row} accessibilityRole="radiogroup" accessibilityLabel={label}>
      {options.map((id) => {
        const selected = id === value;
        return (
          <Pressable
            key={id}
            onPress={() => {
              if (selected) return;
              if (Platform.OS !== 'web') Haptics.selectionAsync().catch(() => {});
              onChange(id);
            }}
            accessibilityRole="radio"
            accessibilityState={{ selected }}
            accessibilityLabel={t(id === 'telebirr' ? 'pay.telebirr' : 'pay.cbe')}
            style={({ pressed }) => [styles.card, selected && styles.cardOn, pressed && { opacity: 0.85 }]}
          >
            <View style={styles.logo}>
              <ProviderMark provider={id} height={id === 'telebirr' ? 30 : 30} />
              {id === 'cbe' && <Text style={styles.name}>CBE</Text>}
            </View>
            {selected && (
              <View style={styles.check} pointerEvents="none">
                <FeatherIcon name="check" size={12} color="#FFFFFF" strokeWidth={3.4} />
              </View>
            )}
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: spacing.sm + 2 },
  card: {
    flex: 1,
    minHeight: 60,
    borderRadius: radius.md,
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: colors.bg,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.sm,
  },
  cardOn: { borderColor: colors.limeDeep, backgroundColor: colors.limeSoft },
  logo: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  name: { fontFamily: fonts.extrabold, fontSize: 18, color: colors.text, letterSpacing: -0.2 },
  check: {
    position: 'absolute',
    top: 6,
    right: 6,
    width: 18,
    height: 18,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.limeDeep,
  },
});
