import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import { useAuth } from './auth';
import { addToCart, fetchCart, loadCachedCart, removeLines, saveCachedCart, setIdChecked, setQuantity, type CartLine } from './cartApi';
import { cartCount, clampQuantity } from './cartLogic';

type Loaded = { userId: string | null; lines: CartLine[]; status: 'loading' | 'ready' | 'error' };

type CartValue = {
  lines: CartLine[];
  /** Every unit in the cart, for the badge. */
  count: number;
  status: Loaded['status'];
  reload: () => Promise<void>;
  /** Throw on failure (read the message with cartErrorText). */
  add: (input: { optionId: string; fields: Record<string, string>; idChecked: boolean }) => Promise<void>;
  setQty: (lineId: string, quantity: number) => Promise<void>;
  setChecked: (lineId: string, checked: boolean) => Promise<void>;
  remove: (lineIds: readonly string[]) => Promise<void>;
};

const CartContext = createContext<CartValue>({
  lines: [],
  count: 0,
  status: 'loading',
  reload: async () => {},
  add: async () => {},
  setQty: async () => {},
  setChecked: async () => {},
  remove: async () => {},
});

export const useCart = () => useContext(CartContext);

/** "Cart is full" and friends, in words. */
export function cartErrorText(error: unknown): string {
  const message = String((error as { message?: unknown } | null)?.message ?? '');
  if (message.includes('cart_full')) return 'Your cart is full (30 items). Remove something first.';
  if (message.includes('cart_items_line_unique') || message.includes('duplicate')) return 'That is already in your cart.';
  return "Couldn't update your cart. Check your connection and try again.";
}

/**
 * The signed-in customer's cart. It lives in the database, so it survives closing (or reinstalling) the app, and a copy
 * is kept per customer on the device so it appears at once. One customer's cart is never shown to another.
 */
export function CartProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const [state, setState] = useState<Loaded>({ userId: null, lines: [], status: 'loading' });

  const reload = useCallback(async () => {
    if (!userId) return;
    try {
      const lines = await fetchCart(userId);
      setState({ userId, lines, status: 'ready' });
      await saveCachedCart(userId, lines);
    } catch {
      setState((current) => ({ userId, lines: current.userId === userId ? current.lines : [], status: 'error' }));
    }
  }, [userId]);

  useEffect(() => {
    if (!userId) return;
    let live = true;
    // The device copy first (instant, works offline), then the database.
    loadCachedCart(userId).then((cached) => {
      if (live && cached) setState((current) => (current.userId === userId && current.status === 'ready' ? current : { userId, lines: cached, status: 'loading' }));
    });
    fetchCart(userId)
      .then((fresh) => {
        if (!live) return;
        setState({ userId, lines: fresh, status: 'ready' });
        saveCachedCart(userId, fresh);
      })
      .catch(() => {
        if (live) setState((current) => ({ userId, lines: current.userId === userId ? current.lines : [], status: 'error' }));
      });
    return () => {
      live = false;
    };
  }, [userId]);

  // Only ever this customer's lines: another account signing in on the same phone starts empty.
  const lines = useMemo(() => (state.userId === userId ? state.lines : []), [state, userId]);
  const status: Loaded['status'] = state.userId === userId ? state.status : 'loading';

  const value = useMemo<CartValue>(
    () => ({
      lines,
      count: cartCount(lines),
      status,
      reload,
      add: async (input) => {
        if (!userId) throw new Error('not_authenticated');
        await addToCart(userId, input);
        await reload();
      },
      setQty: async (lineId, quantity) => {
        const q = clampQuantity(quantity);
        setState((s) => ({ ...s, lines: s.lines.map((l) => (l.id === lineId ? { ...l, quantity: q } : l)) }));
        try {
          await setQuantity(lineId, q);
        } finally {
          await reload();
        }
      },
      setChecked: async (lineId, checked) => {
        setState((s) => ({ ...s, lines: s.lines.map((l) => (l.id === lineId ? { ...l, idChecked: checked } : l)) }));
        try {
          await setIdChecked(lineId, checked);
        } finally {
          await reload();
        }
      },
      remove: async (lineIds) => {
        setState((s) => ({ ...s, lines: s.lines.filter((l) => !lineIds.includes(l.id)) }));
        try {
          await removeLines(lineIds);
        } finally {
          await reload();
        }
      },
    }),
    [lines, status, reload, userId]
  );

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}
