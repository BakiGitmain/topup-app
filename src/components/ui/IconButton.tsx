import { ActivityIndicator, Pressable, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';

import { colors } from '../../lib/theme';
import { FeatherIcon, type FeatherName } from '../art/FeatherIcon';

type Props = {
  icon: FeatherName;
  /** Read out by screen readers. REQUIRED: an icon alone says nothing to someone who can't see it. */
  label: string;
  onPress: () => void;
  /** "danger" for delete-type actions (red icon). */
  tone?: 'default' | 'danger';
  disabled?: boolean;
  loading?: boolean;
  size?: number;
  style?: StyleProp<ViewStyle>;
};

/**
 * An icon-only round button (pencil, trash, arrows...) for places where a text button would not fit. 44pt to tap by default,
 * with the accessibility label doing the talking. Use this everywhere an edit / delete / move action is an icon.
 */
export function IconButton({ icon, label, onPress, tone = 'default', disabled, loading, size = 44, style }: Props) {
  const color = tone === 'danger' ? colors.danger : colors.text;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || loading}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled, busy: !!loading }}
      hitSlop={4}
      style={({ pressed }) => [
        styles.button,
        { width: size, height: size, borderRadius: size / 2 },
        tone === 'danger' && styles.danger,
        disabled && styles.disabled,
        pressed && { opacity: 0.7 },
        style,
      ]}
    >
      {loading ? <ActivityIndicator size="small" color={color} /> : <FeatherIcon name={icon} size={Math.round(size * 0.42)} color={color} />}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: { alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  danger: { backgroundColor: colors.dangerBg, borderColor: colors.dangerBorder },
  disabled: { opacity: 0.4 },
});
