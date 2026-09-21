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

import { fetchPendingCount } from './admin';

const POLL_MS = 30_000;

type PendingValue = { count: number; refresh: () => void };

const PendingContext = createContext<PendingValue>({ count: 0, refresh: () => {} });

/**
 * Number of orders waiting for an admin, for the badge on the Queue tab.
 * Refreshes every 30s, whenever the app comes back to the foreground, and on
 * demand after an admin acts on an order.
 */
export function PendingProvider({ children }: { children: ReactNode }) {
  const [count, setCount] = useState(0);

  const refresh = useCallback(() => {
    fetchPendingCount()
      .then(setCount)
      .catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, POLL_MS);
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') refresh();
    });
    return () => {
      clearInterval(timer);
      sub.remove();
    };
  }, [refresh]);

  const value = useMemo(() => ({ count, refresh }), [count, refresh]);
  return <PendingContext.Provider value={value}>{children}</PendingContext.Provider>;
}

export function usePending() {
  return useContext(PendingContext);
}
