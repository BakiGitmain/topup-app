import { useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

/** The floating bar never gets wider than this, even on tablets. */
export const BAR_MAX_WIDTH = 480;

/** Breathing room kept between the last piece of content and the bar. */
const CONTENT_GAP = 16;

const clamp = (min: number, value: number, max: number) => Math.min(max, Math.max(min, value));

/** Every size the bar uses, derived from the current window so rotation and split-screen just work. */
export function getBarMetrics(width: number, insetBottom: number) {
  const narrow = width <= 360; // small phones: SE, Galaxy A-series
  return {
    narrow,
    height: narrow ? 54 : 58,
    iconSize: narrow ? 24 : 26,
    avatarSize: narrow ? 28 : 30,
    horizontalMargin: clamp(16, width * 0.05, 28),
    // Never flush with the gesture bar / home indicator.
    bottomOffset: insetBottom > 0 ? insetBottom : 12,
  };
}

/**
 * Space taken by the floating bar (bar + gap below it + a little room above).
 * Add this as bottom padding to scrollable screens so the last item clears it.
 */
export function useTabBarHeight() {
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const m = getBarMetrics(width, insets.bottom);
  return m.height + m.bottomOffset + CONTENT_GAP;
}
