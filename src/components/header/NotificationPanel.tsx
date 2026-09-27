import { router } from 'expo-router';
import { useEffect, useRef } from 'react';
import { Modal, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { FeatherIcon } from '../art/FeatherIcon';
import { FadeScrollView } from '../ui/FadeScrollView';
import { useT } from '../../lib/i18n';
import { useNotifications } from '../../lib/notifications';
import {
  SEEN_AFTER_MS,
  idsToMarkSeen,
  notificationAction,
  notificationIcon,
  notificationTarget,
  notificationText,
  relativeAge,
  type AppNotification,
} from '../../lib/notificationsLogic';
import { colors, fonts, shadow, spacing } from '../../lib/theme';

const HEADER_HEIGHT = 56;

/** A fresh token per tap: the destination highlights once for it, and never again on a later visit. */
let taps = 0;
const tapToken = () => `${Date.now()}-${++taps}`;
const CARD_WIDTH = 320;
/**
 * The panel never grows past this: 60% of the screen (it hangs from the header, so it must end well above the tab
 * bar on a short phone), and never more than 480pt on a tall one, where a longer dropdown just reads as a page.
 */
const MAX_HEIGHT_SHARE = 0.6;
const MAX_HEIGHT = 480;
const BADGE = 32;

type Props = {
  visible: boolean;
  onClose: () => void;
  /** When the panel was opened; relative times ("5m") are counted from here. */
  openedAt: number;
};

/**
 * The bell's dropdown: the same Modal + dimmed backdrop + top-right card as WalletMenu, a plain list inside.
 *
 * Seen rule: once the panel has stayed open for SEEN_AFTER_MS (2 s) continuously, everything it has loaded and not
 * seen yet is marked seen -- one timer for the whole panel, no per-row tracking. Closing earlier cancels the timer,
 * so nothing is marked.
 *
 * Tapping a row closes the panel and opens what it is about (notificationTarget): an "on sale" pack on its product
 * page, a money notification's row in the profile's Transactions list. The destination scrolls to it and glows it
 * once (useScrollToHighlight). A row with nothing to open -- an old-format one -- only closes the panel.
 *
 * How a row LOOKS follows notificationAction: a row with somewhere real to go gets a trailing chevron, a pressed
 * tint (the same pair SettingsRow uses) and a label saying where it goes; any other row is plain text.
 */
export function NotificationPanel({ visible, onClose, openedAt }: Props) {
  const t = useT();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const { items, markSeen, availability, checkTargets } = useNotifications();
  // Read at the moment the timer fires, so a list that finished loading after opening is included.
  const itemsRef = useRef(items);
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  // A pack may have gone off sale (or been removed) since the list loaded: check again whenever the panel opens.
  useEffect(() => {
    if (visible) checkTargets();
  }, [visible, checkTargets]);

  useEffect(() => {
    if (!visible) return;
    const timer = setTimeout(() => {
      markSeen(idsToMarkSeen(itemsRef.current));
    }, SEEN_AFTER_MS);
    return () => clearTimeout(timer);
  }, [visible, markSeen]);

  function open(item: AppNotification) {
    onClose();
    if (!item.seen) markSeen([item.id]);
    const target = notificationTarget(item);
    const hl = tapToken();
    if (target?.kind === 'pack') {
      router.push({ pathname: '/product/[id]', params: { id: target.productId, highlight: target.optionId, hl } });
    } else if (target?.kind === 'transaction') {
      router.navigate({ pathname: '/profile', params: { highlight: target.transactionId, hl } });
    }
  }

  const age = (item: AppNotification) => {
    const a = relativeAge(item.createdAt, openedAt);
    return a.unit === 'now' ? t('notif.now') : t(a.unit === 'm' ? 'notif.minutes' : a.unit === 'h' ? 'notif.hours' : 'notif.days', { n: String(a.n) });
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      {/* The backdrop is a layer BEHIND the card, not around it: the rows are buttons of their own, and a button
          may not sit inside another one (web refuses nested <button>s). */}
      <View style={styles.fill}>
        <Pressable style={[StyleSheet.absoluteFill, styles.backdrop]} onPress={onClose} accessibilityRole="button" accessibilityLabel={t('common.cancel')} />
        <View style={[styles.anchor, { top: insets.top + HEADER_HEIGHT + 6 }]} pointerEvents="box-none">
          <View style={[styles.card, { maxHeight: Math.min(Math.round(height * MAX_HEIGHT_SHARE), MAX_HEIGHT) }]}>
            <Text style={styles.heading} accessibilityRole="header">
              {t('notif.title')}
            </Text>
            {items.length === 0 ? (
              <View style={styles.empty}>
                <View style={styles.badge}>
                  <FeatherIcon name="bell" size={16} color={colors.textMuted} />
                </View>
                <Text style={styles.emptyTitle}>{t('notif.empty')}</Text>
                <Text style={styles.emptyHint}>{t('notif.emptyHint')}</Text>
              </View>
            ) : (
              <FadeScrollView indicator={false}>
                {items.map((item, i) => {
                  const text = notificationText(item, t);
                  const action = notificationAction(item, availability);
                  const summary = `${item.seen ? '' : `${t('notif.unreadRow')}. `}${text.title}. ${text.body}. ${age(item)}`;
                  return (
                    <Pressable
                      key={item.id}
                      onPress={() => open(item)}
                      style={({ pressed }) => [styles.row, i > 0 && styles.rowDivider, action && pressed && styles.rowPressed]}
                      accessibilityRole={action ? 'button' : 'text'}
                      accessibilityLabel={action ? `${summary}. ${t(action.opens, action.vars)}` : summary}
                    >
                      {/* The glyph says what it is about; unread is the dot on its corner, nothing more. An inert row's
                          glyph is faded, like the row has no chevron: it is information, not a way in. */}
                      <View style={styles.badgeSlot}>
                        <View style={[styles.badge, !action && styles.badgeInert]}>
                          <FeatherIcon name={notificationIcon(item.type)} size={16} color={colors.text} />
                        </View>
                        {!item.seen && <View style={styles.unread} testID="notif-unread" />}
                      </View>
                      <View style={styles.rowText}>
                        <Text style={styles.title} numberOfLines={1}>
                          {text.title}
                        </Text>
                        <Text style={styles.body} numberOfLines={3}>
                          {text.body}
                        </Text>
                      </View>
                      <View style={styles.trail}>
                        <Text style={styles.age}>{age(item)}</Text>
                        {action && (
                          <View style={styles.chevron} testID="notif-chevron">
                            <FeatherIcon name="chevron-right" size={16} color={colors.textFaint} />
                          </View>
                        )}
                      </View>
                    </Pressable>
                  );
                })}
              </FadeScrollView>
            )}
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  backdrop: { backgroundColor: 'rgba(20, 26, 18, 0.35)' },
  anchor: { position: 'absolute', right: spacing.md, left: spacing.md, alignItems: 'flex-end' },
  card: { width: CARD_WIDTH, maxWidth: '100%', paddingVertical: 12, borderRadius: 18, backgroundColor: colors.bg, ...shadow.lift },
  // A hairline under the heading (the same one between rows): once the list scrolls, rows slide under a clear edge
  // instead of up against the heading's text.
  heading: {
    paddingHorizontal: 14,
    paddingBottom: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderStrong,
    fontFamily: fonts.bold,
    fontSize: 11,
    letterSpacing: 0.4,
    textTransform: 'uppercase',
    color: colors.textMuted,
  },
  empty: { alignItems: 'center', paddingHorizontal: spacing.lg, paddingTop: spacing.md, paddingBottom: spacing.sm, gap: 6 },
  emptyTitle: { marginTop: 4, fontFamily: fonts.bold, fontSize: 14, color: colors.text, textAlign: 'center' },
  emptyHint: { fontFamily: fonts.regular, fontSize: 13, lineHeight: 18, color: colors.textMuted, textAlign: 'center' },
  row: { flexDirection: 'row', alignItems: 'stretch', gap: 10, paddingHorizontal: 14, paddingVertical: 10 },
  rowPressed: { backgroundColor: colors.border },
  rowDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.borderStrong },
  // The same neutral circle as the Transactions list's icons, one tint for every type.
  badgeSlot: { width: BADGE, height: BADGE },
  badge: { width: BADGE, height: BADGE, borderRadius: BADGE / 2, backgroundColor: colors.border, alignItems: 'center', justifyContent: 'center' },
  badgeInert: { opacity: 0.45 },
  unread: {
    position: 'absolute',
    top: -1,
    right: -1,
    width: 10,
    height: 10,
    borderRadius: 5,
    borderWidth: 2,
    borderColor: colors.bg,
    backgroundColor: colors.danger,
  },
  rowText: { flex: 1, minWidth: 0 },
  title: { fontFamily: fonts.bold, fontSize: 14, color: colors.text },
  body: { marginTop: 2, fontFamily: fonts.regular, fontSize: 13.5, lineHeight: 19, color: colors.textMuted },
  age: { marginTop: 2, fontFamily: fonts.medium, fontSize: 12, color: colors.textFaint },
  // The time on top, the chevron centred in the space below it: rows with and without one keep the time in the
  // same place, and a long text wraps in its own column instead of pushing either of them off the row.
  trail: { flexShrink: 0, alignItems: 'flex-end' },
  chevron: { flex: 1, minHeight: 16, justifyContent: 'center' },
});
