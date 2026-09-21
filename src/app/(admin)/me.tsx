import { router } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Avatar } from '../../components/market/Avatar';
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
      router.replace('/sign-in');
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

        <Button
          label="Payment settings"
          variant="outline"
          onPress={() => router.push('/payment-settings')}
          style={styles.switch}
        />
        <Button
          label="Switch to customer view"
          onPress={() => router.replace('/shop')}
          style={styles.switch}
        />
        <Button
          label="Sign out"
          variant="outline"
          onPress={handleSignOut}
          loading={signingOut}
          style={styles.signOut}
        />
      </Column>
    </TabScroll>
  );
}

const styles = StyleSheet.create({
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
