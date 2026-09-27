import { router } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Avatar } from '../../components/market/Avatar';
import { AccountSwitcher } from '../../components/profile/AccountSwitcher';
import { Button } from '../../components/ui/Button';
import { Column, TabScroll } from '../../components/ui/TabScroll';
import { useAuth } from '../../lib/auth';
import { colors, fonts, radius, spacing } from '../../lib/theme';

export default function AdminMeScreen() {
  const { user, profile, signOut } = useAuth();
  const [signingOut, setSigningOut] = useState(false);

  async function handleSignOut() {
    setSigningOut(true);
    try {
      await signOut();
      router.replace('/splash');
    } finally {
      setSigningOut(false);
    }
  }

  return (
    <TabScroll>
      <Column>
        <View style={styles.identity}>
          <Avatar name={profile?.display_name} uri={profile?.avatar_url} size={64} />
          <View style={styles.identityText}>
            <Text style={styles.name} numberOfLines={1}>
              {profile?.display_name || 'Admin'}
            </Text>
            <Text style={styles.email} numberOfLines={1}>
              {user?.email ?? ''}
            </Text>
          </View>
          <View style={styles.badge}>
            <Text style={styles.badgeText}>ADMIN</Text>
          </View>
        </View>

        <Text style={styles.body}>
          You manage the catalog and prices, work the order queue, and credit customer balances.
        </Text>

        {/* Same switcher as the customer Profile: an admin account must be able to switch back too. */}
        <View style={styles.accounts}>
          <AccountSwitcher />
        </View>

        <Button
          label="Payment settings"
          variant="outline"
          icon="credit-card"
          onPress={() => router.push('/payment-settings')}
          style={styles.switch}
        />
        <Button
          label="Discount codes"
          variant="outline"
          icon="tag"
          onPress={() => router.push('/discount-codes')}
          style={styles.switch}
        />
        <Button
          label="Wheel prizes"
          variant="outline"
          icon="gift"
          onPress={() => router.push('/wheel-prizes')}
          style={styles.switch}
        />
        <Button
          label="Spin packages"
          variant="outline"
          icon="zap"
          onPress={() => router.push('/wheel-spin-packages')}
          style={styles.switch}
        />
        <Button
          label="Switch to customer view"
          icon="repeat"
          onPress={() => router.replace('/shop')}
          style={styles.switch}
        />
        <Button
          label="Sign out"
          variant="outline"
          icon="log-out"
          onPress={handleSignOut}
          loading={signingOut}
          style={styles.signOut}
        />
      </Column>
    </TabScroll>
  );
}

const styles = StyleSheet.create({
  accounts: { marginBottom: spacing.md },
  identity: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingTop: spacing.md,
    marginBottom: spacing.lg,
  },
  identityText: { flex: 1 },
  name: { fontFamily: fonts.extrabold, fontSize: 24, color: colors.text, letterSpacing: -0.6 },
  email: { marginTop: 2, fontFamily: fonts.regular, fontSize: 14, color: colors.textMuted },
  badge: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: radius.pill,
    backgroundColor: colors.primary,
  },
  badgeText: { fontFamily: fonts.bold, fontSize: 11, letterSpacing: 1, color: colors.lime },
  body: { fontFamily: fonts.regular, fontSize: 15, lineHeight: 23, color: colors.textMuted },
  switch: { marginTop: spacing.lg },
  signOut: { marginTop: spacing.sm + 4 },
});
