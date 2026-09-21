import * as Haptics from 'expo-haptics';
import { Platform, Pressable, StyleSheet, Switch } from 'react-native';

import { colors } from '../../lib/theme';

type Props = {
  value: boolean;
  onValueChange: (next: boolean) => void;
  /** Spoken name, e.g. "Free Fire visible in shop". */
  label: string;
  disabled?: boolean;
};

const TRACK = { false: colors.borderStrong, true: colors.limeDeep };

/**
 * A switch with a 44pt-tall tap area.
 *
 * The native Switch claims every touch on it, and on Android it ignores `pointerEvents`, so it can
 * NOT be made inert inside a Pressable: the tap would land on the Switch, flip it, and snap back
 * because nothing listens to it. So on phones the Switch itself is the control and always has an
 * onValueChange; the Pressable around it only catches taps on the space beside it. On the web the
 * Switch is a checkbox that does honour pointer-events, so the whole area is one button there.
 */
export function Toggle({ value, onValueChange, label, disabled }: Props) {
  function change(next: boolean) {
    if (Platform.OS !== 'web') Haptics.selectionAsync().catch(() => {});
    onValueChange(next);
  }

  if (Platform.OS === 'web') {
    return (
      <Pressable
        onPress={() => change(!value)}
        disabled={disabled}
        accessibilityRole="switch"
        accessibilityState={{ checked: value, disabled }}
        aria-checked={value}
        accessibilityLabel={label}
        style={styles.area}
      >
        <Switch
          value={value}
          pointerEvents="none"
          accessible={false}
          importantForAccessibility="no-hide-descendants"
          aria-hidden
          trackColor={TRACK}
          thumbColor="#FFFFFF"
          disabled={disabled}
        />
      </Pressable>
    );
  }

  return (
    <Pressable onPress={() => change(!value)} disabled={disabled} accessible={false} style={styles.area}>
      <Switch
        value={value}
        onValueChange={change}
        accessibilityLabel={label}
        trackColor={TRACK}
        thumbColor="#FFFFFF"
        disabled={disabled}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  area: { minWidth: 56, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
});
