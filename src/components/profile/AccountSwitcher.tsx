import { router } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { useAccounts } from '../../lib/accounts';
import type { SavedAccount } from '../../lib/accountsLogic';
import { confirmDestructive } from '../../lib/confirm';
import { useT } from '../../lib/i18n';
import { colors, fonts, radius } from '../../lib/theme';
import { useToast } from '../../lib/toast';
import { FeatherIcon } from '../art/FeatherIcon';
import { Avatar } from '../market/Avatar';
import { SettingsGroup, SettingsRow } from './SettingsMenu';

function ActivePill({ label }: { label: string }) {
  return (
    <View style={styles.pill}>
      <FeatherIcon name="check" size={12} color={colors.limeInk} strokeWidth={3} />
      <Text style={styles.pillText}>{label}</Text>
    </View>
  );
}

/** After a switch or an add, the app starts over from the index route, which sends each account to its own home
 * (admin queue or shop) -- the same routing every sign-in already uses. Anything stacked on top is dropped first. */
export function goHomeForActiveAccount() {
  if (router.canDismiss()) router.dismissAll();
  router.replace('/');
}

/**
 * The saved accounts on this device as one card: every account (the active one marked), then "Add account".
 * Tap another account to switch to it; long-press any account to remove it from this device. Renders nothing where
 * multi-account isn't offered (the web; see accountStore.ts).
 */
export function AccountSwitcher() {
  const { enabled, accounts, activeId, canAdd, switchTo, remove } = useAccounts();
  const t = useT();
  const toast = useToast();
  const [switching, setSwitching] = useState<string | null>(null);

  if (!enabled) return null;

  const nameOf = (a: SavedAccount) => a.displayName || a.email || '—';

  async function open(a: SavedAccount) {
    if (switching) return;
    if (a.needsSignIn) return signInAgain(a);
    setSwitching(a.id);
    const result = await switchTo(a.id);
    setSwitching(null);
    if (result === 'ok') return goHomeForActiveAccount();
    if (result === 'needs_sign_in') {
      const again = await confirmDestructive(t('accounts.expiredTitle'), t('accounts.expiredBody', { name: nameOf(a) }), t('accounts.signInAgain'), 'primary');
      if (again) signInAgain(a);
      return;
    }
    if (result !== 'same') toast(t(result === 'network' ? 'account.network' : 'accounts.switchFailed'));
  }

  function signInAgain(a: SavedAccount) {
    router.push({ pathname: '/sign-in', params: { add: '1', ...(a.email ? { email: a.email } : {}) } });
  }

  async function confirmRemove(a: SavedAccount) {
    const isActive = a.id === activeId;
    const ok = await confirmDestructive(
      t('accounts.removeTitle'),
      t(isActive ? 'accounts.removeActiveBody' : 'accounts.removeBody', { name: nameOf(a) }),
      t('accounts.remove')
    );
    if (!ok) return;
    await remove(a.id);
    if (isActive) router.replace('/splash');
  }

  function add() {
    if (!canAdd) return toast(t('accounts.limitBody'));
    router.push({ pathname: '/sign-in', params: { add: '1' } });
  }

  return (
    <SettingsGroup>
      {accounts.map((a) => {
        const isActive = a.id === activeId;
        return (
          <SettingsRow
            key={a.id}
            iconNode={<Avatar name={nameOf(a)} uri={a.avatarUrl} size={40} />}
            label={nameOf(a)}
            value={a.needsSignIn ? t('accounts.needsSignIn') : (a.email ?? undefined)}
            right={
              isActive ? <ActivePill label={t('accounts.active')} /> : switching === a.id ? <ActivityIndicator color={colors.limeInk} /> : undefined
            }
            onPress={isActive ? undefined : () => open(a)}
            onLongPress={() => confirmRemove(a)}
            accessibilityHint={t('accounts.removeHint')}
            busy={switching !== null}
          />
        );
      })}
      <SettingsRow
        icon="plus"
        label={t('accounts.add')}
        tone="accent"
        value={canAdd ? undefined : t('accounts.limitHint')}
        onPress={add}
        noChevron
      />
    </SettingsGroup>
  );
}

const styles = StyleSheet.create({
  pill: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, height: 26, borderRadius: radius.pill, backgroundColor: colors.limeSoft },
  pillText: { fontFamily: fonts.bold, fontSize: 11.5, color: colors.limeInk },
});
