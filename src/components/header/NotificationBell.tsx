import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useT } from '../../lib/i18n';
import { useNotifications } from '../../lib/notifications';
import { badgeLabel } from '../../lib/notificationsLogic';
import { colors, fonts } from '../../lib/theme';
import { FeatherIcon } from '../art/FeatherIcon';
import { NotificationPanel } from './NotificationPanel';

const SIZE = 40;

/** The header bell: same 40x40 button as the cart. Badge: a red dot for one unread, the number for more, "99+" past 99. */
export function NotificationBell() {
  const { unread, reload } = useNotifications();
  const t = useT();
  const [open, setOpen] = useState(false);
  const [openedAt, setOpenedAt] = useState(0);
  const badge = badgeLabel(unread);

  return (
    <>
      <Pressable
        onPress={() => {
          setOpenedAt(Date.now());
          setOpen(true);
          reload();
        }}
        hitSlop={4}
        accessibilityRole="button"
        accessibilityLabel={unread > 0 ? t('notif.bellUnread', { n: String(unread) }) : t('notif.title')}
        style={({ pressed }) => [styles.button, pressed && styles.pressed]}
      >
        <FeatherIcon name="bell" size={20} color={colors.text} strokeWidth={1.8} />
        {badge?.kind === 'dot' && <View style={styles.dot} pointerEvents="none" />}
        {badge?.kind === 'count' && (
          <View style={styles.count} pointerEvents="none">
            <Text style={styles.countText}>{badge.text}</Text>
          </View>
        )}
      </Pressable>
      <NotificationPanel visible={open} onClose={() => setOpen(false)} openedAt={openedAt} />
    </>
  );
}

const styles = StyleSheet.create({
  button: { width: SIZE, height: SIZE, alignItems: 'center', justifyContent: 'center' },
  pressed: { opacity: 0.6 },
  dot: { position: 'absolute', top: 9, right: 10, width: 8, height: 8, borderRadius: 4, backgroundColor: colors.danger, borderWidth: 1.5, borderColor: colors.bg },
  count: {
    position: 'absolute',
    top: 3,
    right: 1,
    minWidth: 16,
    height: 16,
    paddingHorizontal: 3,
    borderRadius: 8,
    backgroundColor: colors.danger,
    alignItems: 'center',
    justifyContent: 'center',
  },
  countText: { fontFamily: fonts.bold, fontSize: 9.5, color: '#FFFFFF' },
});
