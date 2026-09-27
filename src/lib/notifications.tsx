import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import { useAuth } from './auth';
import { markSeenLocally, targetIdsOf, type AppNotification, type TargetAvailability, type TargetStatus } from './notificationsLogic';
import { priceDisplay } from './pricing';
import { supabase } from './supabase';

/** unreadTotal comes from the server and counts every unread notification, not only the ones in `items` (at most 100). */
type Loaded = { userId: string | null; items: AppNotification[]; unreadTotal: number };

type NotificationsValue = {
  items: AppNotification[];
  unread: number;
  reload: () => Promise<void>;
  markSeen: (ids: readonly string[]) => Promise<void>;
  /** Which tap targets still exist (see notificationAction); a target not checked yet is absent. */
  availability: TargetAvailability;
  /** Re-checks the targets (the panel calls it when it opens: a pack may have gone off sale since). */
  checkTargets: () => Promise<void>;
};

const NO_AVAILABILITY: TargetAvailability = new Map();

/**
 * Whether each target is still there, as this customer sees it: RLS already hides a pack that is switched off (or
 * whose product or region is), and every transaction but their own. Anything the query can't settle (an error)
 * stays unknown rather than being called gone.
 */
async function fetchTargetAvailability(items: readonly AppNotification[]): Promise<Map<string, TargetStatus>> {
  const { optionIds, transactionIds } = targetIdsOf(items);
  const result = new Map<string, TargetStatus>();
  const [packs, txs] = await Promise.all([
    optionIds.length
      ? supabase.from('product_options').select('id, price, old_price, region_id, product_regions ( id )').in('id', optionIds)
      : Promise.resolve({ data: [], error: null }),
    transactionIds.length
      ? supabase.from('wallet_transactions').select('id').in('id', transactionIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (!packs.error) {
    const rows = (packs.data ?? []) as unknown as {
      id: string;
      price: number | string;
      old_price: number | string | null;
      region_id: string | null;
      product_regions: { id: string } | null;
    }[];
    for (const id of optionIds) {
      const row = rows.find((r) => r.id === id);
      // A pack whose region is hidden can't be shown on its product page either.
      if (!row || (row.region_id !== null && !row.product_regions)) result.set(id, { live: false });
      else {
        const onSale = priceDisplay(Number(row.price), row.old_price === null ? null : Number(row.old_price)).discountPct !== null;
        result.set(id, { live: true, onSale });
      }
    }
  }
  if (!txs.error) {
    const found = new Set(((txs.data ?? []) as { id: string }[]).map((r) => r.id));
    for (const id of transactionIds) result.set(id, found.has(id) ? { live: true } : { live: false });
  }
  return result;
}

const NotificationsContext = createContext<NotificationsValue | undefined>(undefined);

async function fetchMyNotifications(): Promise<{ items: AppNotification[]; unreadTotal: number }> {
  const { data, error } = await supabase.rpc('my_notifications');
  if (error) throw error;
  const rows = (data ?? []) as {
    id: string;
    type: string;
    title: string;
    body: string;
    data: Record<string, unknown> | null;
    created_at: string;
    seen: boolean;
    unread_total: number | string;
  }[];
  return {
    items: rows.map((r) => ({ id: r.id, type: r.type, title: r.title, body: r.body, data: r.data ?? {}, createdAt: r.created_at, seen: r.seen })),
    unreadTotal: rows.length ? Number(rows[0].unread_total) : 0,
  };
}

/**
 * The signed-in user's notifications and unread count, kept live.
 *
 * - The list comes only from my_notifications() (the server applies visibility, the 3-day expiry and cleanup), so
 *   there is one source of truth for both the list and the badge.
 * - Supabase Realtime pushes every new notifications row this user is allowed to read (the same RLS policy as a
 *   plain select); an insert just triggers a reload. No per-type code here: a new notification type shows up
 *   through the same path.
 * - Keyed by user: another account's list is never shown (an account switch starts empty and reloads).
 */
export function NotificationsProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const [state, setState] = useState<Loaded>({ userId: null, items: [], unreadTotal: 0 });
  const [checked, setChecked] = useState<{ userId: string | null; map: TargetAvailability }>({ userId: null, map: NO_AVAILABILITY });

  const reload = useCallback(async () => {
    if (!userId) return;
    try {
      const loaded = await fetchMyNotifications();
      setState({ userId, ...loaded });
    } catch {
      // Keep what's shown; the next insert or open retries.
    }
  }, [userId]);

  useEffect(() => {
    if (!userId) return;
    let live = true;
    const load = () =>
      fetchMyNotifications()
        .then((loaded) => {
          if (live) setState({ userId, ...loaded });
        })
        .catch(() => {});
    load();
    const channel = supabase
      .channel(`notifications-${userId}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notifications' }, load)
      .subscribe();
    return () => {
      live = false;
      supabase.removeChannel(channel);
    };
  }, [userId]);

  const markSeen = useCallback(
    async (ids: readonly string[]) => {
      if (!userId || ids.length === 0) return;
      const { error } = await supabase.rpc('mark_notifications_seen', { p_ids: [...ids] });
      if (error) return;
      setState((s) => {
        if (s.userId !== userId) return s;
        const newlySeen = s.items.filter((item) => !item.seen && ids.includes(item.id)).length;
        return { userId, items: markSeenLocally(s.items, ids), unreadTotal: Math.max(0, s.unreadTotal - newlySeen) };
      });
      // Then re-read: with more unread than one list holds, the rest come up next (unread are listed first).
      await reload();
    },
    [userId, reload]
  );

  const checkTargets = useCallback(async () => {
    if (!userId || state.userId !== userId || state.items.length === 0) return;
    try {
      const map = await fetchTargetAvailability(state.items);
      setChecked({ userId, map });
    } catch {
      // Unknown targets keep their chevron; the next open checks again.
    }
  }, [userId, state]);

  // Every time the list changes (first load, a new notification), check what it points at.
  useEffect(() => {
    if (!userId || state.userId !== userId || state.items.length === 0) return;
    let live = true;
    fetchTargetAvailability(state.items)
      .then((map) => {
        if (live) setChecked({ userId, map });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [userId, state]);

  const mineNow = state.userId === userId;
  const items = useMemo(() => (mineNow ? state.items : []), [mineNow, state.items]);
  const unread = mineNow ? state.unreadTotal : 0;
  const availability = checked.userId === userId ? checked.map : NO_AVAILABILITY;
  const value = useMemo<NotificationsValue>(
    () => ({ items, unread, reload, markSeen, availability, checkTargets }),
    [items, unread, reload, markSeen, availability, checkTargets]
  );

  return <NotificationsContext.Provider value={value}>{children}</NotificationsContext.Provider>;
}

export function useNotifications(): NotificationsValue {
  const value = useContext(NotificationsContext);
  if (!value) throw new Error('useNotifications must be used inside NotificationsProvider');
  return value;
}
