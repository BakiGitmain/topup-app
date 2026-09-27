import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring, withTiming } from 'react-native-reanimated';

import { FeatherIcon } from '../art/FeatherIcon';
import { colors, fonts, radius, wheel as W } from '../../lib/theme';

const PRESS_IN = { duration: 90 };
const SETTLE = { damping: 14, stiffness: 220 };
const HEIGHT = 64;
const DEPTH = 5;

/**
 * The wheel screen's primary action, in the wheel's own palette: an amber pill (the rim's gradient) sitting on a
 * darker rim-coloured base, so it reads as a physical carnival button. A press sinks the face onto the base rather
 * than just scaling. The icon sits in a lime "peg", the same mark the wheel's rim uses. Not the shared `Button`:
 * nothing else in the app looks like this, on purpose.
 */
export function SpinButton({ label, onPress, loading = false, disabled = false }: { label: string; onPress: () => void; loading?: boolean; disabled?: boolean }) {
  const sink = useSharedValue(0);
  const blocked = disabled || loading;

  function pressIn() {
    if (blocked) return;
    sink.value = withTiming(1, PRESS_IN);
  }
  function pressOut() {
    sink.value = withSpring(0, SETTLE);
  }
  function handlePress() {
    if (blocked) return;
    if (Platform.OS !== 'web') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    onPress();
  }

  const faceStyle = useAnimatedStyle(() => ({ transform: [{ translateY: sink.value * (DEPTH - 1) }] }));

  return (
    <View style={[styles.wrap, blocked && styles.blocked]}>
      <View style={styles.base} />
      <Pressable
        onPress={handlePress}
        onPressIn={pressIn}
        onPressOut={pressOut}
        disabled={blocked}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ disabled: blocked, busy: loading }}
      >
        <Animated.View style={faceStyle}>
          <LinearGradient colors={[W.rim[0], W.rim[1]]} start={{ x: 0, y: 0 }} end={{ x: 0, y: 1 }} style={styles.face}>
            <View style={styles.sheen} pointerEvents="none" />
            {loading ? (
              <ActivityIndicator color={colors.text} />
            ) : (
              <View style={styles.row}>
                <View style={styles.peg}>
                  <FeatherIcon name="zap" size={15} color={colors.text} strokeWidth={2.6} />
                </View>
                <Text style={styles.label}>{label}</Text>
              </View>
            )}
          </LinearGradient>
        </Animated.View>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { height: HEIGHT + DEPTH },
  base: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: DEPTH,
    height: HEIGHT,
    borderRadius: radius.pill,
    backgroundColor: W.rimLine,
  },
  face: {
    height: HEIGHT,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 28,
    borderWidth: 1.5,
    borderColor: W.rim[2],
    overflow: 'hidden',
  },
  sheen: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: HEIGHT * 0.45,
    backgroundColor: 'rgba(255,255,255,0.22)',
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  peg: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.lime,
    borderWidth: 2.5,
    borderColor: '#FFFFFF',
  },
  label: { fontFamily: fonts.extrabold, fontSize: 19, color: colors.text, letterSpacing: -0.3 },
  blocked: { opacity: 0.5 },
});
