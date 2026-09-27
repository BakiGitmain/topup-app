import { Redirect } from 'expo-router';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { useAuth } from '../lib/auth';
import { colors } from '../lib/theme';

/** The gap between the native splash hiding and the auth check resolving. No animation: navigates the instant
 * `initializing` clears, straight to the real destination. */
export default function Index() {
  const { session, profile, isAdmin, initializing } = useAuth();

  if (!initializing) {
    if (!session) return <Redirect href="/splash" />;
    // A first-time Google account (no real display_name chosen yet) finishes that step before anything else --
    // the same gate regardless of how they signed in, since it reads the profile, not the provider.
    if (profile?.needs_username) return <Redirect href="/choose-username" />;
    return <Redirect href={isAdmin ? '/queue' : '/shop'} />;
  }

  return (
    <View style={styles.center}>
      <ActivityIndicator color={colors.limeDeep} />
    </View>
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bg,
  },
});
