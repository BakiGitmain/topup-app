import { Redirect, Tabs } from 'expo-router';
import { ActivityIndicator, View } from 'react-native';

import { GlassTabBar, type TabItem } from '../../components/nav/GlassTabBar';
import { useAuth } from '../../lib/auth';
import { PendingProvider, usePending } from '../../lib/pending';
import { colors } from '../../lib/theme';

const ITEMS: TabItem[] = [
  {
    route: 'queue',
    label: 'Queue',
    icon: { outline: 'layers-outline', filled: 'layers' },
    badgeHint: (n) => `${n} pending orders`,
  },
  { route: 'catalog', label: 'Catalog', icon: { outline: 'pricetags-outline', filled: 'pricetags' } },
  { route: 'customers', label: 'Customers', icon: { outline: 'people-outline', filled: 'people' } },
  { route: 'me', label: 'Me', avatar: true },
];

function AdminTabs() {
  const { count } = usePending();

  return (
    <Tabs
      tabBar={(props) => <GlassTabBar {...props} items={ITEMS} />}
      screenOptions={{ headerShown: false, sceneStyle: { backgroundColor: colors.bg } }}
    >
      <Tabs.Screen name="queue" options={{ title: 'Queue', tabBarBadge: count > 0 ? count : undefined }} />
      <Tabs.Screen name="catalog" options={{ title: 'Catalog' }} />
      <Tabs.Screen name="customers" options={{ title: 'Customers' }} />
      <Tabs.Screen name="me" options={{ title: 'Me' }} />
    </Tabs>
  );
}

/**
 * Admin-only. This redirect is a convenience: the database refuses every
 * admin action from a non-admin, so it can't be bypassed from the client. It
 * also re-runs on every render, so an admin who loses the role is sent out.
 */
export default function AdminTabsLayout() {
  const { session, isAdmin, initializing } = useAuth();

  if (initializing) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg }}>
        <ActivityIndicator size="large" color={colors.limeDeep} />
      </View>
    );
  }
  if (!session) return <Redirect href="/sign-in" />;
  if (!isAdmin) return <Redirect href="/shop" />;

  return (
    <PendingProvider>
      <AdminTabs />
    </PendingProvider>
  );
}
