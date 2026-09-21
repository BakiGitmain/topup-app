import { useEffect, useState } from 'react';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';

import { colors, fonts, spacing } from '../../lib/theme';
import { BoltIcon } from '../art/Icons';
import { useTabBarHeight } from '../nav/tabBarMetrics';

type Props = { message: string; visible: boolean };

export function Toast({ message, visible }: Props) {
  // Sits above the floating tab bar (a little higher than needed on screens without one).
  const bottom = useTabBarHeight();
  const [show] = useState(() => new Animated.Value(0));

  useEffect(() => {
    Animated.timing(show, {
      toValue: visible ? 1 : 0,
      duration: visible ? 240 : 180,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [visible, show]);

  return (
    <View
      style={[styles.wrap, { bottom, pointerEvents: 'none' }]}
    >
      <Animated.View
        accessibilityLiveRegion="polite"
        style={[
          styles.toast,
          {
            opacity: show,
            transform: [
              {
                translateY: show.interpolate({
                  inputRange: [0, 1],
                  outputRange: [16, 0],
                }),
              },
            ],
          },
        ]}
      >
        <BoltIcon size={16} color={colors.lime} />
        <Text style={styles.text}>{message}</Text>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: spacing.lg,
    right: spacing.lg,
    alignItems: 'center',
  },
  toast: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm + 2,
    maxWidth: 420,
    paddingHorizontal: spacing.md,
    paddingVertical: 14,
    borderRadius: 18,
    backgroundColor: colors.primary,
  },
  text: {
    flexShrink: 1,
    fontFamily: fonts.semibold,
    fontSize: 14,
    lineHeight: 19,
    color: colors.primaryText,
  },
});
