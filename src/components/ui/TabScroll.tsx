import { useScrollToTop } from 'expo-router';
import { useRef, type ReactNode } from 'react';
import { RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { colors, spacing } from '../../lib/theme';
import { useTabBarHeight } from '../nav/tabBarMetrics';

export const MAX_COLUMN_WIDTH = 480;

type Props = {
  children: ReactNode;
  refreshing?: boolean;
  onRefresh?: () => void;
  /** Indices of children that stick to the top while scrolling. */
  stickyHeaderIndices?: number[];
};

/**
 * Scrolling body for a tab screen: safe area on top, bottom padding so the
 * last item clears the floating tab bar, pull-to-refresh, and scroll-to-top
 * when the active tab is tapped again. Put each section in a <Column> so
 * content stays centered on wide screens.
 */
export function TabScroll({ children, refreshing = false, onRefresh, stickyHeaderIndices }: Props) {
  const scrollRef = useRef<ScrollView>(null);
  useScrollToTop(scrollRef);
  const barHeight = useTabBarHeight();

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView
        ref={scrollRef}
        style={styles.flex}
        contentContainerStyle={[styles.content, { paddingBottom: barHeight + spacing.md }]}
        stickyHeaderIndices={stickyHeaderIndices}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        showsVerticalScrollIndicator={false}
        refreshControl={
          onRefresh ? (
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={colors.limeDeep}
              colors={[colors.limeDeep]}
            />
          ) : undefined
        }
      >
        {children}
      </ScrollView>
    </SafeAreaView>
  );
}

/** Centered, width-limited column. Not centered via the scroll container: see the note in shop.tsx. */
export function Column({ children, style }: { children: ReactNode; style?: object }) {
  return <View style={[styles.column, style]}>{children}</View>;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  flex: { flex: 1 },
  content: { flexGrow: 1 },
  column: {
    width: '100%',
    maxWidth: MAX_COLUMN_WIDTH,
    alignSelf: 'center',
    paddingHorizontal: spacing.lg,
  },
});
