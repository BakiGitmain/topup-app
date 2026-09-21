import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { AppState } from 'react-native';

import { useAuth } from './auth';
import { fetchOpenOrderCount } from './orders';
import { fetchLatestCodeTime, fetchNewCodeCount } from './vault';

const POLL_MS = 30_000;
const seenKey = (userId: string) => `topup.vaultSeen.${userId}`;

type Counts = { userId: string | null; openOrders: number; newCodes: number };

type BadgesValue = {
  /** Orders still pending or processing. */
  openOrders: number;
  /** Vault codes delivered since the customer last opened the Vault. */
  newCodes: number;
  /** Re-count now, e.g. right after buying something. */
  refresh: () => void;
  /** Call when the Vault is on screen: clears the dot. */
  markVaultSeen: () => void;
};

const BadgesContext = createContext<BadgesValue>({
  openOrders: 0,
  newCodes: 0,
  refresh: () => {},
  markVaultSeen: () => {},
});

/**
 * Real counts behind the customer tab dots. Nothing is faked: if a query
 * fails the dot simply doesn't show. Refreshes every 30s and when the app
 * returns to the foreground.
 */
export function CustomerBadgesProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const [counts, setCounts] = useState<Counts>({ userId: null, openOrders: 0, newCodes: 0 });

  const refresh = useCallback(() => {
    if (!userId) return Promise.resolve();
    return AsyncStorage.getItem(seenKey(userId))
      .then((since) =>
        Promise.all([fetchOpenOrderCount(userId), fetchNewCodeCount(userId, since)])
      )
      .then(([openOrders, newCodes]) => setCounts({ userId, openOrders, newCodes }))
      .catch(() => {
        // Leave the last known counts in place.
      });
  }, [userId]);

  const markVaultSeen = useCallback(async () => {
    if (!userId) return;
    try {
      const latest = await fetchLatestCodeTime(userId);
      if (latest) await AsyncStorage.setItem(seenKey(userId), latest);
      setCounts((c) => (c.userId === userId ? { ...c, newCodes: 0 } : c));
    } catch {
      // Not critical: the dot just stays until the next successful visit.
    }
  }, [userId]);

  useEffect(() => {
    if (!userId) return;
    refresh();
    const timer = setInterval(refresh, POLL_MS);
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') refresh();
    });
    return () => {
      clearInterval(timer);
      sub.remove();
    };
  }, [userId, refresh]);

  // Counts that belong to a previous account must never show for the next one.
  const current = counts.userId === userId ? counts : { openOrders: 0, newCodes: 0 };

  const value = useMemo(
    () => ({
      openOrders: current.openOrders,
      newCodes: current.newCodes,
      refresh: () => void refresh(),
      markVaultSeen: () => void markVaultSeen(),
    }),
    [current.openOrders, current.newCodes, refresh, markVaultSeen]
  );

  return <BadgesContext.Provider value={value}>{children}</BadgesContext.Provider>;
}

export function useCustomerBadges() {
  return useContext(BadgesContext);
}
