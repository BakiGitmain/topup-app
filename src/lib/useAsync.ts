import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';

type Status = 'loading' | 'ready' | 'error';
type Tagged<T> = { key: string | number; status: Status; data: T | null };

/**
 * Runs `load` on mount, and again whenever `key` changes or `reload` is
 * called. Old data stays visible while refreshing, but data loaded for a
 * different `key` (say, another filter) is never shown. A late response from
 * a stale request is ignored.
 *
 * `enabled` holds the first request back (status stays 'loading') until it is true, then
 * runs it. Screens that can open before sign-in has finished use it so they never fetch
 * with a missing user or route param.
 */
export function useAsync<T>(load: () => Promise<T>, key: string | number = 0, enabled = true) {
  const [state, setState] = useState<Tagged<T>>({ key, status: 'loading', data: null });
  const loadRef = useRef(load);
  const keyRef = useRef(key);
  const requestId = useRef(0);

  useEffect(() => {
    loadRef.current = load;
    keyRef.current = key;
  });

  const reload = useCallback(async () => {
    const id = ++requestId.current;
    const forKey = keyRef.current;
    try {
      const data = await loadRef.current();
      if (id === requestId.current) setState({ key: forKey, status: 'ready', data });
    } catch {
      if (id === requestId.current) {
        setState((prev) => ({
          key: forKey,
          status: 'error',
          data: prev.key === forKey ? prev.data : null,
        }));
      }
    }
  }, []);

  useEffect(() => {
    if (enabled) reload();
  }, [reload, key, enabled]);

  useEffect(() => {
    const requests = requestId;
    return () => {
      requests.current++;
    };
  }, []);

  const current = state.key === key ? state : null;
  return {
    status: (current?.status ?? 'loading') as Status,
    data: current?.data ?? null,
    reload,
  };
}

/**
 * Re-runs `reload` when the screen comes back into focus (e.g. after
 * buying something), but not on the first focus, which `useAsync` covers.
 */
export function useRefreshOnFocus(reload: () => void) {
  const first = useRef(true);
  useFocusEffect(
    useCallback(() => {
      if (first.current) {
        first.current = false;
        return;
      }
      reload();
    }, [reload])
  );
}
