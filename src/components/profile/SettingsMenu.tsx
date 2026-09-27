import { Children, createContext, Fragment, useContext, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

import { colors, fonts, radius, spacing } from '../../lib/theme';
import { useReducedMotion } from '../../lib/useReducedMotion';
import { FeatherIcon, type FeatherName } from '../art/FeatherIcon';

export type SettingsItem = { key: string; icon: FeatherName; label: string; onPress: () => void };

const TIMING = { duration: 220, easing: Easing.out(Easing.cubic) };
const ROW_PAD = spacing.md - 2;
const ICON = 40;
const ROW_GAP = spacing.md - 2;
/** One radius for every settings card, on the Profile screen and inside Settings. */
export const CARD_RADIUS = radius.lg;

/** True inside a SettingsGroup: rows then leave the background and rounding to the group's card. */
const InGroup = createContext(false);

/**
 * A rounded card holding related rows, with a thin divider between them (the grouped-settings pattern: one card
 * per group, not one card per row). The divider is inset to start after the row icons, so it reads as a separation
 * between items, not a hard rule across the card.
 */
export function SettingsGroup({ children }: { children: ReactNode }) {
  const rows = Children.toArray(children);
  return (
    <View style={styles.group}>
      <InGroup.Provider value={true}>
        {rows.map((row, i) => (
          <Fragment key={i}>
            {i > 0 && <GroupDivider />}
            {row}
          </Fragment>
        ))}
      </InGroup.Provider>
    </View>
  );
}

export function GroupDivider() {
  return <View style={styles.divider} />;
}

type RowProps = {
  label: string;
  /** A Feather icon, or `iconNode` for anything else (a brand mark). */
  icon?: FeatherName;
  iconNode?: ReactNode;
  /** A second line under the label, e.g. the email address or "Not set". */
  value?: string;
  valueLines?: number;
  /** Replaces the chevron, e.g. a "Connected" pill or a spinner. */
  right?: ReactNode;
  /** Without it the row is plain information: not pressable, no chevron. */
  onPress?: () => void;
  /** A secondary action (e.g. "remove from this device"); makes the row pressable even without onPress. */
  onLongPress?: () => void;
  /** An action that happens right here (no screen to go to): no chevron. */
  noChevron?: boolean;
  /** Point the chevron down instead of right (a row that expands in place). */
  chevronDown?: boolean;
  /** 'accent' for a primary in-place action, 'danger' for one like signing out. */
  tone?: 'accent' | 'danger';
  /** Set false when the row holds its own controls, so a screen reader can still reach them one by one. */
  accessibleGroup?: boolean;
  accessibilityHint?: string;
  busy?: boolean;
};

/** One settings row: round icon, label (+ value), then a chevron or a right-hand element. Inside a SettingsGroup it
 * is a flat row of the group's card; on its own it is its own rounded card. The same row everywhere in Settings. */
export function SettingsRow({
  label,
  icon,
  iconNode,
  value,
  valueLines = 1,
  right,
  onPress,
  onLongPress,
  noChevron,
  chevronDown,
  tone,
  accessibleGroup = true,
  accessibilityHint,
  busy,
}: RowProps) {
  const grouped = useContext(InGroup);
  const inkColor = tone === 'danger' ? colors.danger : tone === 'accent' ? colors.limeInk : colors.text;
  const chevron = onPress && !noChevron ? (
    <FeatherIcon name={chevronDown ? 'chevron-down' : 'chevron-right'} size={18} color={colors.textFaint} />
  ) : null;
  const body = (
    <>
      <View style={[styles.icon, tone === 'danger' && styles.iconDanger, tone === 'accent' && styles.iconAccent]}>
        {iconNode ?? (icon ? <FeatherIcon name={icon} size={18} color={inkColor} /> : null)}
      </View>
      <View style={styles.rowText}>
        <Text style={[styles.rowLabel, { color: inkColor }]} numberOfLines={1}>
          {label}
        </Text>
        {value ? (
          <Text style={styles.rowValue} numberOfLines={valueLines} selectable={!onPress}>
            {value}
          </Text>
        ) : null}
      </View>
      {right !== undefined ? right : chevron}
    </>
  );
  const base = grouped ? styles.rowGrouped : styles.row;
  if (!onPress && !onLongPress) {
    return (
      <View style={base} accessible={accessibleGroup} accessibilityLabel={accessibleGroup ? (value ? `${label}, ${value}` : label) : undefined}>
        {body}
      </View>
    );
  }
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={450}
      // A screen reader can't guess a long-press exists: offer it as a named action (announced via the hint).
      accessibilityActions={onLongPress ? [{ name: 'longpress' }] : undefined}
      onAccessibilityAction={onLongPress ? (e) => e.nativeEvent.actionName === 'longpress' && onLongPress() : undefined}
      disabled={busy}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ busy: !!busy, disabled: !!busy }}
      style={({ pressed }) => [base, pressed && styles.rowPressed]}
    >
      {body}
    </Pressable>
  );
}

/**
 * A "Settings" row that expands to its own rows and collapses on a second tap. Put it in a SettingsGroup and the
 * rows unfold inside the same card, each behind a divider. The list is measured at its natural height and the
 * container animates between 0 and that height, so everything below slides rather than jumps; with reduce-motion
 * on it simply opens and closes.
 */
export function SettingsMenu({ title, items }: { title: string; items: readonly SettingsItem[] }) {
  const reduced = useReducedMotion();
  const [open, setOpen] = useState(false);
  const [contentHeight, setContentHeight] = useState(0);
  const progress = useSharedValue(0);

  function toggle() {
    const next = !open;
    setOpen(next);
    progress.value = reduced ? (next ? 1 : 0) : withTiming(next ? 1 : 0, TIMING);
  }

  const bodyStyle = useAnimatedStyle(() => ({ height: progress.value * contentHeight, opacity: progress.value }));
  const chevronStyle = useAnimatedStyle(() => ({ transform: [{ rotate: `${progress.value * 180}deg` }] }));

  return (
    <View accessibilityState={{ expanded: open }}>
      <SettingsRow
        icon="settings"
        label={title}
        onPress={toggle}
        right={
          <Animated.View style={chevronStyle}>
            <FeatherIcon name="chevron-down" size={18} color={colors.textMuted} />
          </Animated.View>
        }
      />
      <Animated.View style={[styles.body, bodyStyle]} pointerEvents={open ? 'auto' : 'none'} accessibilityElementsHidden={!open}>
        {/* Laid out at its natural height even while the container is 0 tall, which is what makes it measurable. */}
        <View style={styles.list} onLayout={(e) => setContentHeight(e.nativeEvent.layout.height)}>
          {items.map(({ key, ...item }) => (
            <View key={key} style={styles.subRow}>
              <GroupDivider />
              <SettingsRow {...item} />
            </View>
          ))}
        </View>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  group: { borderRadius: CARD_RADIUS, backgroundColor: colors.surface, overflow: 'hidden' },
  divider: {
    height: StyleSheet.hairlineWidth,
    marginLeft: ROW_PAD + ICON + ROW_GAP,
    backgroundColor: colors.borderStrong,
  },
  body: { overflow: 'hidden' },
  list: { position: 'absolute', left: 0, right: 0, top: 0 },
  // Rows revealed under Settings sit a step in, so they read as belonging to it.
  subRow: { paddingLeft: spacing.md },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: ROW_GAP,
    padding: ROW_PAD,
    borderRadius: CARD_RADIUS,
    backgroundColor: colors.surface,
  },
  rowGrouped: { flexDirection: 'row', alignItems: 'center', gap: ROW_GAP, padding: ROW_PAD },
  rowPressed: { backgroundColor: colors.border },
  icon: {
    width: ICON,
    height: ICON,
    borderRadius: ICON / 2,
    backgroundColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconAccent: { backgroundColor: colors.limeSoft },
  iconDanger: { backgroundColor: colors.dangerBg },
  rowText: { flex: 1, minHeight: ICON, justifyContent: 'center' },
  rowLabel: { fontFamily: fonts.bold, fontSize: 14.5 },
  rowValue: { marginTop: 1, fontFamily: fonts.regular, fontSize: 13, color: colors.textMuted },
});
