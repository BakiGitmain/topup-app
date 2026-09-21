import { useCallback, useEffect, useRef, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';

import { registerConfirmHost, type ConfirmRequest } from '../../lib/confirm';
import { useT } from '../../lib/i18n';
import { colors, fonts, radius, spacing } from '../../lib/theme';
import { FeatherIcon } from '../art/FeatherIcon';

/**
 * The app's confirmation dialog: a rounded card in the app's palette over a dimmed screen, with a Cancel and a Confirm button.
 * Mount it ONCE (root layout). Screens never render it; they call confirmDestructive() from lib/confirm.
 * Cancel, tapping outside and the Android back button all mean "no".
 */
export function ConfirmHost() {
  const t = useT();
  const [request, setRequest] = useState<ConfirmRequest | null>(null);
  const current = useRef<ConfirmRequest | null>(null);

  const show = useCallback((next: ConfirmRequest) => {
    // A second question while one is open: the first one is answered "no".
    current.current?.resolve(false);
    current.current = next;
    setRequest(next);
  }, []);

  useEffect(() => registerConfirmHost(show), [show]);

  function answer(confirmed: boolean) {
    const active = current.current;
    current.current = null;
    setRequest(null);
    active?.resolve(confirmed);
  }

  const danger = request?.tone !== 'primary';

  return (
    <Modal visible={request !== null} transparent animationType="fade" onRequestClose={() => answer(false)} statusBarTranslucent>
      <Pressable style={styles.backdrop} onPress={() => answer(false)} accessibilityLabel={t('common.cancel')} accessibilityRole="button">
        {/* A press on the card itself must not fall through to the backdrop. */}
        <Pressable style={styles.card} onPress={() => {}} accessibilityRole="alert" accessible={false}>
          <View style={[styles.badge, danger ? styles.badgeDanger : styles.badgeOk]}>
            <FeatherIcon name={danger ? 'alert-triangle' : 'check-circle'} size={26} color={danger ? colors.danger : colors.limeDark} />
          </View>
          <Text style={styles.title} accessibilityRole="header">
            {request?.title}
          </Text>
          <Text style={styles.message}>{request?.message}</Text>
          <View style={styles.buttons}>
            <Pressable onPress={() => answer(false)} accessibilityRole="button" style={({ pressed }) => [styles.button, styles.cancel, pressed && styles.pressed]}>
              <Text style={styles.cancelText}>{t('common.cancel')}</Text>
            </Pressable>
            <Pressable
              onPress={() => answer(true)}
              accessibilityRole="button"
              style={({ pressed }) => [styles.button, danger ? styles.confirmDanger : styles.confirmPrimary, pressed && styles.pressed]}
            >
              <Text style={styles.confirmText} numberOfLines={1}>
                {request?.confirmLabel}
              </Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.lg, backgroundColor: 'rgba(20, 26, 18, 0.5)' },
  card: {
    width: '100%',
    maxWidth: 340,
    padding: spacing.lg,
    borderRadius: radius.xl - 4,
    backgroundColor: colors.bg,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 10 },
    elevation: 12,
  },
  badge: { width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center', marginBottom: spacing.md },
  badgeDanger: { backgroundColor: colors.dangerBg },
  badgeOk: { backgroundColor: colors.limeSoft },
  title: { fontFamily: fonts.extrabold, fontSize: 19, lineHeight: 25, color: colors.text, textAlign: 'center', letterSpacing: -0.3 },
  message: { marginTop: spacing.sm, fontFamily: fonts.medium, fontSize: 14.5, lineHeight: 21, color: colors.textMuted, textAlign: 'center' },
  buttons: { flexDirection: 'row', gap: spacing.sm + 2, marginTop: spacing.lg, alignSelf: 'stretch' },
  button: { flex: 1, minHeight: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.sm },
  pressed: { opacity: 0.8 },
  cancel: { backgroundColor: colors.bg, borderWidth: 1.5, borderColor: colors.borderStrong },
  cancelText: { fontFamily: fonts.bold, fontSize: 15, color: colors.text },
  confirmDanger: { backgroundColor: colors.danger },
  confirmPrimary: { backgroundColor: colors.primary },
  confirmText: { fontFamily: fonts.bold, fontSize: 15, color: colors.primaryText },
});
