import { LinearGradient } from 'expo-linear-gradient';
import { useState, type ReactNode } from 'react';
import {
  Platform,
  ScrollView,
  StyleSheet,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { colors } from '../../lib/theme';
import type { ScrollContainer } from '../../lib/useScrollToHighlight';

// Web only: stop a scroll that reaches the list's end from carrying on into the page (native keeps its own nesting).
const CONTAIN_SCROLL = Platform.OS === 'web' ? ({ overscrollBehavior: 'contain' } as object) : null;

type Props = {
  children: ReactNode;
  /** The box: give it the cap (maxHeight) and anything else about its frame. */
  style?: StyleProp<ViewStyle>;
  contentContainerStyle?: StyleProp<ViewStyle>;
  /** Lets useScrollToHighlight scroll this list too. */
  container?: ScrollContainer;
  /**
   * Native scrollbar while the list overflows. Never on web: a desktop browser's scrollbar would steal width from
   * the rows; the cut-off row and the fade are the hint there.
   */
  indicator?: boolean;
};

/**
 * A capped list that scrolls inside itself instead of growing: a short list takes the height it needs, a long one
 * stops at the box's maxHeight. While there's more below, a soft fade sits on the bottom edge; it goes once the end
 * is reached. Used by the profile's Transactions box and the notification panel.
 */
export function FadeScrollView({ children, style, contentContainerStyle, container, indicator = true }: Props) {
  const [boxHeight, setBoxHeight] = useState(0);
  const [contentHeight, setContentHeight] = useState(0);
  const [atEnd, setAtEnd] = useState(false);
  const overflows = contentHeight > boxHeight + 1;

  function onScroll(e: NativeSyntheticEvent<NativeScrollEvent>) {
    container?.onScroll(e);
    const { contentOffset, layoutMeasurement, contentSize } = e.nativeEvent;
    setAtEnd(contentOffset.y + layoutMeasurement.height >= contentSize.height - 4);
  }

  return (
    <View style={[styles.box, style]}>
      <ScrollView
        {...container?.props}
        style={[styles.scroll, CONTAIN_SCROLL]}
        contentContainerStyle={contentContainerStyle}
        nestedScrollEnabled
        showsVerticalScrollIndicator={indicator && overflows && Platform.OS !== 'web'}
        scrollEventThrottle={32}
        onScroll={onScroll}
        onLayout={(e) => setBoxHeight(e.nativeEvent.layout.height)}
        onContentSizeChange={(w, h) => {
          container?.onContentSizeChange(w, h);
          setContentHeight(h);
        }}
      >
        {children}
      </ScrollView>
      {overflows && !atEnd && (
        <LinearGradient pointerEvents="none" colors={['rgba(255,255,255,0)', colors.bg]} style={styles.fade} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  // Shrinks inside a capped parent too (React Native's default is not to shrink, which lets a list overflow it).
  box: { flexShrink: 1, minHeight: 0 },
  scroll: { flexGrow: 0, flexShrink: 1 },
  fade: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 36 },
});
