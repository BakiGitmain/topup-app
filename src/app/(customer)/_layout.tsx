import { Redirect, Tabs } from 'expo-router';
import { ActivityIndicator, View } from 'react-native';

import { GlassTabBar, type TabItem } from '../../components/nav/GlassTabBar';
import { useAuth } from '../../lib/auth';
import { useCustomerBadges } from '../../lib/badges';
import { useT } from '../../lib/i18n';
import { useResumePendingPayment } from '../../lib/useResumePendingPayment';
import { colors } from '../../lib/theme';

export default function CustomerTabsLayout() {
  const { session, user, initializing } = useAuth();
  const { openOrders, newCodes } = useCustomerBadges();
  const t = useT();
  // An order was made but not paid for (app closed or crashed): go back to "enter your payment reference".
  useResumePendingPayment(session ? (user?.id ?? null) : null);

  if (initializing) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg }}>
        <ActivityIndicator size="large" color={colors.limeDeep} />
      </View>
    );
  }
  if (!session) return <Redirect href="/sign-in" />;
  // Any signed-in user may be here: admins open the customer app on purpose
  // (Me > Switch to customer view). The role wall is the *admin* group, which
  // sends customers out.

  const items: TabItem[] = [
    { route: 'shop', label: t('tab.shop'), icon: { outline: 'home-outline', filled: 'home' } },
    {
      route: 'orders',
      label: t('tab.orders'),
      icon: { outline: 'receipt-outline', filled: 'receipt' },
      badgeHint: (n) => t('a11y.openOrders', { n }),
    },
    {
      route: 'vault',
      label: t('tab.vault'),
      icon: { outline: 'file-tray-full-outline', filled: 'file-tray-full' },
      badgeHint: (n) => t('a11y.newCodes', { n }),
    },
    { route: 'profile', label: t('tab.profile'), avatar: true },
  ];

  return (
    <Tabs
      tabBar={(props) => <GlassTabBar {...props} items={items} />}
      screenOptions={{ headerShown: false, sceneStyle: { backgroundColor: colors.bg } }}
    >
      <Tabs.Screen name="shop" options={{ title: t('tab.shop') }} />
      <Tabs.Screen
        name="orders"
        options={{ title: t('tab.orders'), tabBarBadge: openOrders > 0 ? openOrders : undefined }}
      />
      <Tabs.Screen
        name="vault"
        options={{ title: t('tab.vault'), tabBarBadge: newCodes > 0 ? newCodes : undefined }}
      />
      <Tabs.Screen name="profile" options={{ title: t('tab.profile') }} />
    </Tabs>
  );
}
