import Ionicons from '@expo/vector-icons/Ionicons';
import {
  PlusJakartaSans_400Regular,
  PlusJakartaSans_500Medium,
  PlusJakartaSans_600SemiBold,
  PlusJakartaSans_700Bold,
  PlusJakartaSans_800ExtraBold,
  useFonts,
} from '@expo-google-fonts/plus-jakarta-sans';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { AccountsProvider } from '../lib/accounts';
import { AuthProvider } from '../lib/auth';
import { CustomerBadgesProvider } from '../lib/badges';
import { CartProvider } from '../lib/cart';
import { I18nProvider } from '../lib/i18n';
import { NotificationsProvider } from '../lib/notifications';
import { colors } from '../lib/theme';
import { ToastProvider } from '../lib/toast';
import { ConfirmHost } from '../components/ui/ConfirmHost';

SplashScreen.preventAutoHideAsync().catch(() => {});

// Screens listed in a layout come first, so without an anchor the first one (a modal) would
// be the default start screen whenever the launch URL doesn't pick a route.
export const unstable_settings = { anchor: 'index' };

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    PlusJakartaSans_400Regular,
    PlusJakartaSans_500Medium,
    PlusJakartaSans_600SemiBold,
    PlusJakartaSans_700Bold,
    PlusJakartaSans_800ExtraBold,
    // The tab bar icons: load them up front so they never pop in.
    ...Ionicons.font,
  });

  const ready = fontsLoaded || !!fontError;

  useEffect(() => {
    if (ready) {
      SplashScreen.hideAsync().catch(() => {});
    }
  }, [ready]);

  const onLayout = useCallback(() => {
    if (ready) {
      SplashScreen.hideAsync().catch(() => {});
    }
  }, [ready]);

  if (!ready) {
    return null;
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }} onLayout={onLayout}>
      <SafeAreaProvider>
        <AuthProvider>
          <AccountsProvider>
          <I18nProvider>
            <ToastProvider>
              <CartProvider>
              <CustomerBadgesProvider>
              <NotificationsProvider>
                <StatusBar style="dark" />
                <ConfirmHost />
                <Stack
                  screenOptions={{
                    headerShown: false,
                    contentStyle: { backgroundColor: colors.bg },
                    animation: 'slide_from_right',
                  }}
                >
                  <Stack.Screen name="index" />
                  <Stack.Screen
                    name="product/[id]"
                    options={{ presentation: 'modal', animation: 'slide_from_bottom' }}
                  />
                  <Stack.Screen
                    name="topup"
                    options={{ presentation: 'modal', animation: 'slide_from_bottom' }}
                  />
                </Stack>
              </NotificationsProvider>
              </CustomerBadgesProvider>
              </CartProvider>
            </ToastProvider>
          </I18nProvider>
          </AccountsProvider>
        </AuthProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
