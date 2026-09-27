import Ionicons from '@expo/vector-icons/Ionicons';
import { BlurView } from 'expo-blur';
import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';
import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import type { BottomTabBarProps } from 'expo-router/tabs';
import { useEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import { Keyboard, Platform, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  interpolateColor,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAuth } from '../../lib/auth';
import { initialsOf } from '../../lib/initials';
import { colors, fonts, shadow } from '../../lib/theme';
import { useReducedMotion } from '../../lib/useReducedMotion';
import { BAR_MAX_WIDTH, getBarMetrics } from './tabBarMetrics';

type IoniconName = ComponentProps<typeof Ionicons>['name'];

export type TabItem = {
  /** Route name in the tab group, e.g. "orders". */
  route: string;
  /** Spoken name. The bar shows no text, so this is the only label a screen reader gets. */
  label: string;
  /** Outline when inactive, filled when active. Omit for the avatar tab. */
  icon?: { outline: IoniconName; filled: IoniconName };
  /** Shows the signed-in user's photo (or a default user picture) instead of an icon. */
  avatar?: boolean;
  /** What a badge dot means, for screen readers: (3) => "3 pending orders". */
  badgeHint?: (count: number) => string;
};

/**
 * Real Apple Liquid Glass where the device has it (iOS 26+). Otherwise a live
 * blur on iOS and web. Android can only blur with a wrapper around the content
 * *behind* the bar (expo-blur's BlurTargetView), which the navigator's screens
 * don't allow, so Android gets a near-opaque frosted surface.
 */
const LIQUID_GLASS = (() => {
  try {
    return Platform.OS === 'ios' && isLiquidGlassAvailable();
  } catch {
    return false;
  }
})();
const LIVE_BLUR = Platform.OS !== 'android';

const GLASS = {
  sheenTop: LIVE_BLUR ? 'rgba(255,255,255,0.62)' : 'rgba(255,255,255,0.94)',
  sheenBottom: LIVE_BLUR ? 'rgba(255,255,255,0.30)' : 'rgba(255,255,255,0.90)',
  border: 'rgba(255,255,255,0.85)',
  indicator: 'rgba(20,22,18,0.08)',
  indicatorHeld: 'rgba(255,255,255,0.80)',
  badgeRing: '#F7F8F5',
};

const BADGE_RED = '#FF3B30';
// The edge the pill is moving toward snaps ahead; the trailing edge follows more
// slowly. That gap is what makes the pill stretch like liquid while it travels.
const LEAD_SPRING = { damping: 20, stiffness: 320, mass: 0.6 };
const TRAIL_SPRING = { damping: 22, stiffness: 150, mass: 0.7 };
const PAD = 4;

function useKeyboardOpen() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    // Android pushes the window up when the keyboard opens, which would float the bar over the form.
    if (Platform.OS !== 'android') return;
    const show = Keyboard.addListener('keyboardDidShow', () => setOpen(true));
    const hide = Keyboard.addListener('keyboardDidHide', () => setOpen(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return open;
}

type Props = BottomTabBarProps & { items: TabItem[] };

/** Floating frosted-glass pill. Tap a tab, or press and drag the pill to one. Icons only. */
export function GlassTabBar({ state, descriptors, navigation, items }: Props) {
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const reduced = useReducedMotion();
  const keyboardOpen = useKeyboardOpen();

  const m = getBarMetrics(width, insets.bottom);
  const count = state.routes.length;
  const radius = m.height / 2;

  // The slot width comes from the measured row, not a constant, so it is right on every screen.
  const [rowWidth, setRowWidth] = useState(0);
  const slot = rowWidth / count;

  // The two edges of the pill, and how "lifted" it is while held.
  const edgeL = useSharedValue(0);
  const edgeR = useSharedValue(0);
  const lift = useSharedValue(0);
  const placed = useRef(false);
  // Tab the pill is hovering over while dragging (null when not dragging).
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    if (slot === 0) return;
    const left = slot * state.index + PAD;
    const right = slot * (state.index + 1) - PAD;
    if (!placed.current || reduced) {
      edgeL.set(left);
      edgeR.set(right);
      placed.current = true;
      return;
    }
    const movingRight = left > edgeL.get();
    edgeR.set(withSpring(right, movingRight ? LEAD_SPRING : TRAIL_SPRING));
    edgeL.set(withSpring(left, movingRight ? TRAIL_SPRING : LEAD_SPRING));
  }, [state.index, slot, reduced, edgeL, edgeR]);

  const indicatorStyle = useAnimatedStyle(() => ({
    left: edgeL.get(),
    width: Math.max(0, edgeR.get() - edgeL.get()),
    transform: [{ scale: 1 + 0.07 * lift.get() }],
    backgroundColor: interpolateColor(lift.get(), [0, 1], [GLASS.indicator, GLASS.indicatorHeld]),
    shadowOpacity: 0.2 * lift.get(),
  }));

  // What a tap (or a screen reader activation) does for tab `index`.
  const pressIndex = (index: number) => {
    const route = state.routes[index];
    // Tapping the tab you're already on emits tabPress too, which scrolls that screen to the top.
    const event = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
    if (state.index !== index && !event.defaultPrevented) {
      if (Platform.OS !== 'web') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
      navigation.navigate(route.name, route.params);
    }
  };

  // The gestures are built once (re-creating them mid-drag would restart the
  // drag, and the drag itself re-renders the bar), so they read the latest
  // sizes and navigation through a ref.
  const live = useRef({ slot, rowWidth, count, pressIndex });
  useEffect(() => {
    live.current = { slot, rowWidth, count, pressIndex };
  });
  const [pressed, setPressed] = useState<number | null>(null);

  // One transparent layer owns every touch: a tap selects a tab, a press-and-drag
  // carries the pill along the bar and selects the tab it is over when let go.
  // (Mixing this with Pressable's own touch handling made drags unreliable, so
  // the buttons underneath only serve screen readers.)
  /* eslint-disable react-hooks/refs -- the callbacks only run later, on touch */
  const gesture = useMemo(() => {
    const centerOf = (x: number) => {
      const { slot: sl, rowWidth: rw } = live.current;
      return Math.min(Math.max(x, sl / 2), rw - sl / 2);
    };
    const indexOf = (x: number) => {
      const { slot: sl, count: n } = live.current;
      return Math.min(n - 1, Math.max(0, Math.floor(centerOf(x) / sl)));
    };
    const moveTo = (x: number) => {
      const w = live.current.slot - 2 * PAD;
      const center = centerOf(x);
      edgeL.set(center - w / 2);
      edgeR.set(center + w / 2);
      return indexOf(x);
    };

    const pan = Gesture.Pan()
      .runOnJS(true)
      .activeOffsetX([-6, 6])
      .onStart((e) => {
        lift.set(withSpring(1, { damping: 14, stiffness: 220 }));
        setHover(moveTo(e.x));
      })
      .onUpdate((e) => setHover(moveTo(e.x)))
      .onEnd((e) => {
        const index = indexOf(e.x);
        const sl = live.current.slot;
        edgeL.set(withSpring(sl * index + PAD, LEAD_SPRING));
        edgeR.set(withSpring(sl * (index + 1) - PAD, LEAD_SPRING));
        live.current.pressIndex(index);
      })
      .onFinalize(() => {
        lift.set(withTiming(0, { duration: 180 }));
        setHover(null);
      });

    const tap = Gesture.Tap()
      .runOnJS(true)
      .maxDuration(600)
      .onBegin((e) => setPressed(indexOf(e.x)))
      .onEnd((e, success) => {
        if (success) live.current.pressIndex(indexOf(e.x));
      })
      .onFinalize(() => setPressed(null));

    return Gesture.Exclusive(pan, tap);
  }, [edgeL, edgeR, lift]);
  /* eslint-enable react-hooks/refs */

  // Buzz each time the dragged pill crosses onto a new tab.
  const lastHover = useRef<number | null>(null);
  useEffect(() => {
    if (
      Platform.OS !== 'web' &&
      hover !== null &&
      lastHover.current !== null &&
      hover !== lastHover.current
    ) {
      Haptics.selectionAsync().catch(() => {});
    }
    lastHover.current = hover;
  }, [hover]);

  if (Platform.OS === 'android' && keyboardOpen) return null;

  const shownIndex = hover ?? state.index;

  return (
    <View
      style={[
        styles.anchor,
        {
          bottom: m.bottomOffset,
          paddingLeft: m.horizontalMargin + insets.left,
          paddingRight: m.horizontalMargin + insets.right,
          pointerEvents: 'box-none',
        },
      ]}
    >
      <View
        style={[
          styles.shadowWrap,
          shadow.lift,
          { height: m.height, borderRadius: radius, backgroundColor: 'rgba(255,255,255,0.5)' },
        ]}
      >
        <View style={[styles.clip, { borderRadius: radius, borderColor: GLASS.border }]}>
          {LIQUID_GLASS ? (
            <GlassView glassEffectStyle="regular" isInteractive style={StyleSheet.absoluteFill} />
          ) : (
            <>
              {LIVE_BLUR ? <BlurView intensity={70} tint="light" style={StyleSheet.absoluteFill} /> : null}
              {/* Sheen: brighter along the top edge, like light catching the glass. */}
              <LinearGradient
                colors={[GLASS.sheenTop, GLASS.sheenBottom]}
                start={{ x: 0.5, y: 0 }}
                end={{ x: 0.5, y: 1 }}
                style={StyleSheet.absoluteFill}
              />
            </>
          )}

          <GestureDetector gesture={gesture}>
            <View
              style={[styles.row, { height: m.height - 2 }]}
              onLayout={(e) => setRowWidth(e.nativeEvent.layout.width)}
            >
              {slot > 0 && (
                <Animated.View
                  style={[
                    styles.indicator,
                    { pointerEvents: 'none' },
                    { top: 5, height: m.height - 12, borderRadius: (m.height - 12) / 2 },
                    indicatorStyle,
                  ]}
                />
              )}

              {state.routes.map((route, index) => {
                const item = items.find((i) => i.route === route.name);
                const badge = descriptors[route.key]?.options.tabBarBadge;
                const badgeCount = typeof badge === 'number' ? badge : badge ? Number(badge) || 1 : 0;
                const active = shownIndex === index;
                const label = item?.label ?? route.name;
                const hint = badgeCount > 0 ? item?.badgeHint?.(badgeCount) : undefined;

                return (
                  <TabButton
                    key={route.key}
                    focused={state.index === index}
                    active={active}
                    pressed={pressed === index}
                    label={label}
                    hint={hint}
                    showDot={badgeCount > 0}
                    onPress={() => pressIndex(index)}
                    testID={descriptors[route.key]?.options.tabBarButtonTestID}
                  >
                    {item?.avatar ? (
                      <TabAvatar size={m.avatarSize} active={active} />
                    ) : (
                      <Ionicons
                        name={
                          item?.icon ? (active ? item.icon.filled : item.icon.outline) : 'ellipse-outline'
                        }
                        size={m.iconSize}
                        color={colors.text}
                      />
                    )}
                  </TabButton>
                );
              })}
              {/* Touch layer: sits above the buttons and takes every touch. */}
              <View style={StyleSheet.absoluteFill} />
            </View>
          </GestureDetector>
        </View>
      </View>
    </View>
  );
}

type ButtonProps = {
  focused: boolean;
  active: boolean;
  pressed: boolean;
  label: string;
  hint?: string;
  showDot: boolean;
  /** Fired by screen-reader activation; touches go through the gesture layer instead. */
  onPress: () => void;
  testID?: string;
  children: ReactNode;
};

function TabButton({ focused, active, pressed, label, hint, showDot, onPress, testID, children }: ButtonProps) {
  const scale = useSharedValue(1);
  useEffect(() => {
    scale.set(pressed ? withTiming(0.92, { duration: 80 }) : withSpring(1, { damping: 12, stiffness: 240 }));
  }, [pressed, scale]);
  const pressStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.get() }] }));

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="tab"
      accessibilityState={{ selected: focused }}
      accessibilityLabel={label}
      accessibilityHint={hint}
      testID={testID}
      style={styles.button}
    >
      <Animated.View style={[styles.iconWrap, { opacity: active ? 1 : 0.72 }, pressStyle]}>
        {children}
        {showDot && <View style={[styles.dot, { borderColor: GLASS.badgeRing }]} />}
      </Animated.View>
    </Pressable>
  );
}

/** The user's photo, or their initials on a lime circle. Never a broken-image box. */
function TabAvatar({ size, active }: { size: number; active: boolean }) {
  const { profile } = useAuth();
  const uri = profile?.avatar_url ?? null;
  const [failedUri, setFailedUri] = useState<string | null>(null);
  const showPhoto = !!uri && failedUri !== uri;
  const initials = initialsOf(profile?.display_name, profile?.email);
  const outer = size + 6; // 2px ring + 1px gap on each side

  return (
    <View
      style={[
        styles.avatarRing,
        {
          width: outer,
          height: outer,
          borderRadius: outer / 2,
          borderColor: active ? colors.limeDeep : 'transparent',
        },
      ]}
    >
      {showPhoto ? (
        <Image
          source={{ uri }}
          style={{ width: size, height: size, borderRadius: size / 2 }}
          contentFit="cover"
          cachePolicy="memory-disk"
          onError={() => setFailedUri(uri)}
        />
      ) : (
        <View style={[styles.initialsCircle, { width: size, height: size, borderRadius: size / 2 }]}>
          {initials ? (
            <Text
              style={[styles.initials, { fontSize: Math.round(size * (initials.length > 1 ? 0.4 : 0.5)) }]}
              numberOfLines={1}
              allowFontScaling={false}
            >
              {initials}
            </Text>
          ) : (
            <Ionicons name="person" size={Math.round(size * 0.58)} color={colors.text} />
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  // Fills the width so the pill can be centered and capped, without taking layout space.
  anchor: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  shadowWrap: { width: '100%', maxWidth: BAR_MAX_WIDTH },
  clip: { flex: 1, overflow: 'hidden', borderWidth: StyleSheet.hairlineWidth * 2 },
  row: { flexDirection: 'row', alignItems: 'center' },
  indicator: {
    position: 'absolute',
    shadowColor: '#2A3320',
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
  },
  // Both are pressed/animated (a Reanimated `transform: scale`, driven by our own press state, never a native
  // ripple -- android_ripple is never set, so Android installs no touch-feedback drawable at all). Without an
  // explicit backgroundColor, Android can promote a view that animates `transform` to its own hardware layer and
  // rasterize the empty layer as solid black for the first composited frame, which reads as an inverted tab.
  // 'transparent' keeps the real backdrop (the glass/blur behind it) showing through, on every platform.
  button: { flex: 1, height: '100%', alignItems: 'center', justifyContent: 'center', backgroundColor: 'transparent' },
  iconWrap: { alignItems: 'center', justifyContent: 'center', backgroundColor: 'transparent' },
  dot: {
    position: 'absolute',
    top: -2,
    right: -4,
    width: 9,
    height: 9,
    borderRadius: 4.5,
    borderWidth: 1.5,
    backgroundColor: BADGE_RED,
  },
  avatarRing: { borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  initialsCircle: { backgroundColor: colors.lime, alignItems: 'center', justifyContent: 'center' },
  initials: {
    fontFamily: fonts.extrabold,
    color: colors.text,
    letterSpacing: -0.2,
    textAlign: 'center',
    includeFontPadding: false,
    textAlignVertical: 'center',
  },
});
