import { Redirect } from 'expo-router';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { useAuth } from '../lib/auth';
import { colors } from '../lib/theme';

export default function Index() {
  const { session, isAdmin, initializing } = useAuth();

  if (initializing) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={colors.limeDeep} />
      </View>
    );
  }

  if (!session) return <Redirect href="/splash" />;
  return <Redirect href={isAdmin ? '/queue' : '/shop'} />;
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bg,
  },
});