/**
 * Crash recovery for an unpaid order. The app stores the new order's UUID the instant checkout returns it, BEFORE any
 * payment screen shows; on the next launch this decides which order (if any) to go back to. The database has the last
 * word: an order that is no longer awaiting payment is never resumed, and a stored id that is gone is cleared.
 * Pure functions with no imports.
 */

export const pendingOrderKey = (userId: string) => `pendingOrder:v1:${userId}`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A stored value is only ever used if it is a UUID. */
export function parseStoredOrderId(raw: unknown): string | null {
  return typeof raw === 'string' && UUID.test(raw.trim()) ? raw.trim().toLowerCase() : null;
}

export type Resume = { orderId: string | null; clearStored: boolean };

/**
 * `stored`: what the device remembered. `awaiting`: this customer's orders that are still 'pending_payment' in the
 * database (there is at most one). The order to go back to is the one the database says is still awaiting payment.
 */
export function pickResumeOrder(stored: string | null, awaiting: readonly { id: string }[]): Resume {
  const ids = awaiting.map((o) => o.id.toLowerCase());
  const storedId = stored === null ? null : stored.toLowerCase();
  if (storedId !== null && ids.includes(storedId)) return { orderId: storedId, clearStored: false };
  // A stored id the database no longer awaits (paid, cancelled, under review, gone) is stale: forget it.
  // An awaiting order we never stored (a crash right after checkout) is still resumed.
  return { orderId: ids[0] ?? null, clearStored: storedId !== null };
}
