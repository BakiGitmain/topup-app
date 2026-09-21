/** Cart maths and the checkout gate. Pure functions with no imports. */

export const MAX_QUANTITY = 20;
export const MAX_LINES = 30;

export const clampQuantity = (n: number) => (Number.isFinite(n) ? Math.min(MAX_QUANTITY, Math.max(1, Math.floor(n))) : 1);

export type PricedLine = { unitPrice: number; quantity: number; available: boolean };

/** What the customer would pay, in birr, for the lines that can be bought. Cents are kept exact. */
export function cartTotal(lines: readonly PricedLine[]): number {
  const cents = lines.reduce((sum, l) => (l.available ? sum + Math.round(l.unitPrice * 100) * l.quantity : sum), 0);
  return cents / 100;
}

/** Badge number: every unit in the cart. */
export const cartCount = (lines: readonly { quantity: number }[]) => lines.reduce((n, l) => n + l.quantity, 0);

export type GateLine = {
  id: string;
  /** "Free Fire · 110 Diamonds": how the line is named to the customer. */
  name: string;
  available: boolean;
  /** From continueBlocker() for THIS line's own ID and check: null = ready. */
  blocker: string | null;
};

export type CheckoutGate = {
  canCheckout: boolean;
  /** Lines that block checkout, in cart order, each with what is wrong. */
  problems: { lineId: string; name: string; problem: 'unavailable' | string }[];
};

/**
 * Checkout is allowed only when the cart has something in it and EVERY line is available and has passed its own
 * ID gate. A line with an unchecked, invalid or expired ID blocks it and is named. The database re-checks all of
 * this at checkout; this only decides whether the button is on.
 */
export function checkoutGate(lines: readonly GateLine[]): CheckoutGate {
  const problems = lines
    .filter((l) => !l.available || l.blocker !== null)
    .map((l) => ({ lineId: l.id, name: l.name, problem: l.available ? (l.blocker as string) : 'unavailable' }));
  return { canCheckout: lines.length > 0 && problems.length === 0, problems };
}

/** The first line that needs attention, to scroll to. */
export const firstProblem = (gate: CheckoutGate) => gate.problems[0] ?? null;

/** After the database refuses some lines: the ids of lines to drop from the cart. */
export function idsToDrop(failures: readonly { itemId: string; unavailable: boolean }[]): string[] {
  return failures.filter((f) => f.unavailable).map((f) => f.itemId);
}
