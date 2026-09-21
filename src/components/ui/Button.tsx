import * as Haptics from 'expo-haptics';
import { useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { colors, fonts, radius } from '../../lib/theme';

type Props = {
  label: string;
  onPress: () => void;
  loading?: boolean;
  disabled?: boolean;
  variant?: 'solid' | 'dark' | 'outline';
  style?: StyleProp<ViewStyle>;
};

export function Button({
  label,
  onPress,
  loading = false,
  disabled = false,
  variant = 'solid',
  style,
}: Props) {
  const [scale] = useState(() => new Animated.Value(1));
  const isBlocked = disabled || loading;

  function pressIn() {
    Animated.spring(scale, {
      toValue: 0.97,
      useNativeDriver: true,
      speed: 40,
      bounciness: 0,
    }).start();
  }

  function pressOut() {
    Animated.spring(scale, {
      toValue: 1,
      useNativeDriver: true,
      speed: 30,
      bounciness: 6,
    }).start();
  }

  function handlePress() {
    if (isBlocked) return;
    if (Platform.OS !== 'web') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    }
    onPress();
  }

  return (
    <Animated.View style={[{ transform: [{ scale }] }, style]}>
      <Pressable
        onPress={handlePress}
        onPressIn={pressIn}
        onPressOut={pressOut}
        disabled={isBlocked}
        accessibilityRole="button"
        accessibilityState={{ disabled: isBlocked, busy: loading }}
        accessibilityLabel={label}
        style={isBlocked ? styles.blocked : undefined}
      >
        <View style={[styles.base, styles[variant]]}>
          {loading ? (
            <ActivityIndicator
              color={variant === 'dark' ? colors.primaryText : colors.text}
            />
          ) : (
            <Text style={[styles.label, variant === 'dark' && styles.labelDark]}>
              {label}
            </Text>
          )}
        </View>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  base: {
    height: 56,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 20,
  },
  solid: {
    backgroundColor: colors.lime,
  },
  dark: {
    backgroundColor: colors.primary,
  },
  outline: {
    backgroundColor: colors.bg,
    borderWidth: 1.5,
    borderColor: colors.borderStrong,
  },
  label: {
    fontFamily: fonts.bold,
    fontSize: 16,
    color: colors.text,
    letterSpacing: 0.1,
  },
  labelDark: {
    color: colors.primaryText,
  },
  blocked: {
    opacity: 0.45,
  },
});
