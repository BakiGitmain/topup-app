import { router } from 'expo-router';
import { useEffect, useRef } from 'react';

import { findOrderToResume } from './checkout';

/**
 * Once per sign-in, after the app opens: if this customer has an order that was created but not paid, open its payment
 * screen ("enter your payment reference") instead of leaving them on the shop. The same order every time, never a new one.
 * Not repeated while the app stays open, so backing out of the payment screen doesn't bounce them straight back.
 */
export function useResumePendingPayment(userId: string | null) {
  const checkedFor = useRef<string | null>(null);

  useEffect(() => {
    if (!userId || checkedFor.current === userId) return;
    checkedFor.current = userId;
    let active = true;
    findOrderToResume(userId)
      .then((orderId) => {
        if (active && orderId) router.push({ pathname: '/pay/[id]', params: { id: orderId } });
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [userId]);
}
