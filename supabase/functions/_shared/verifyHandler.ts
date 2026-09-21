// The ONE request handler behind both verify-payment (an order) and verify-deposit (a wallet deposit), with every outside
// dependency injected so it can be tested without the network, the database or ShegerPay. Each function's index.ts wires the
// real ones. The ShegerPay logic (decidePayment) is shared by both: there is exactly one copy of it.
//
// Called by the app with { order_id | deposit_id, provider, reference } for the SIGNED-IN customer's own unpaid order or
// open deposit. The total (or requested amount), the state and the reference bookkeeping all live in the database
// (begin/finish_..._verification, which lock the row), so this file only orchestrates: it can never mark anything paid on
// its own authority.
import { CORS_HEADERS, UUID } from '../_shared/validation.ts';
import { decidePayment, isProvider, normalizeReference, type CallResult, type Decision, type Reason } from '../_shared/shegerpay.ts';

export type BeginResult =
  | { result: 'not_found' }
  | { result: 'closed'; status: string }
  | { result: 'in_progress' }
  | { result: 'reference_used' }
  | { result: 'go'; amount: number | string; account_name: string | null };

export type FinishResult = { result: 'paid' | 'mismatch' | 'not_verified' | 'unavailable' | 'not_found' } | { result: 'closed'; status: string };

/** What differs between an order and a deposit. Everything else is identical. */
export type Kind = {
  /** The body field that names the thing being paid for. */
  idField: 'order_id' | 'deposit_id';
  /** The status it stays in while the customer can still retry. */
  openStatus: string;
  /** The status a wrong-amount transfer puts it in. */
  mismatchStatus: string;
};
export const ORDER_KIND: Kind = { idField: 'order_id', openStatus: 'pending_payment', mismatchStatus: 'payment_mismatch' };
export const DEPOSIT_KIND: Kind = { idField: 'deposit_id', openStatus: 'pending_reference', mismatchStatus: 'mismatch' };

export type Deps = {
  getUserId: (token: string) => Promise<string | null>;
  /** Locks the order, answers idempotently, and claims (provider, reference) for it. Throws on a database error. */
  begin: (orderId: string, userId: string, provider: string, reference: string) => Promise<BeginResult>;
  /** Records the outcome. Throws on a database error. */
  finish: (orderId: string, decision: Decision) => Promise<FinishResult>;
  /** ONE HTTP call to ShegerPay's verify endpoint (amount null = lookup only). Throws on network failure or timeout. */
  callShegerPay: (args: { provider: string; reference: string; amount: number | null; merchantName: string | null }) => Promise<CallResult>;
  /** Structured events only. Never pass a reference, an amount, a name or a ShegerPay body. */
  log: (event: Record<string, unknown>) => void;
  /**
   * Optional: runs after the outcome is recorded (deposits use it to flush the Telegram outbox). Its failure is
   * swallowed: a notification problem must never change the answer to the customer.
   */
  afterFinish?: (outcome: FinishResult['result']) => Promise<void>;
};

/** What the app is told. `status` is the order's status after this call; `reason` is a safe category, never raw text. */
export type Answer = {
  result: 'paid' | 'already_paid' | 'closed' | 'mismatch' | 'not_verified' | 'reference_used' | 'in_progress' | 'unavailable' | 'not_found';
  status?: string;
  reason?: Reason;
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, 'content-type': 'application/json' } });

export function createVerifyHandler(deps: Deps, kind: Kind) {
  return async function handle(req: Request): Promise<Response> {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
    if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

    const token = /^Bearer\s+(\S+)$/i.exec(req.headers.get('authorization') ?? '')?.[1];
    const userId = token ? await deps.getUserId(token).catch(() => null) : null;
    if (!userId) return json({ error: 'unauthorized' }, 401);

    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'bad_request' }, 400);
    }
    const rawId = body?.[kind.idField];
    const orderId = typeof rawId === 'string' && UUID.test(rawId) ? rawId : null;
    if (!orderId) return json({ error: 'bad_request' }, 400);
    if (!isProvider(body.provider)) return json({ error: 'bad_provider' }, 400);
    const reference = normalizeReference(body.reference);
    if (reference === null) return json({ error: 'bad_reference' }, 400);
    const provider = body.provider;

    try {
      // 1. Lock the order and claim the reference. Everything idempotent is answered here, without touching ShegerPay.
      const begun = await deps.begin(orderId, userId, provider, reference);
      switch (begun.result) {
        case 'not_found':
          return json({ result: 'not_found' } satisfies Answer, 404);
        case 'closed':
          return json({ result: begun.status === 'paid' ? 'already_paid' : 'closed', status: begun.status } satisfies Answer);
        case 'in_progress':
          return json({ result: 'in_progress', status: kind.openStatus } satisfies Answer);
        case 'reference_used':
          deps.log({ event: 'verify', outcome: 'reference_used' });
          return json({ result: 'reference_used', status: kind.openStatus } satisfies Answer);
      }

      // 2. Ask ShegerPay, with the order's own total. It is never the client's number.
      const total = Number(begun.amount);
      const decision = await decidePayment(
        (amount) => deps.callShegerPay({ provider, reference, amount, merchantName: begun.account_name }),
        total
      );

      // 3. Record it. The database refuses 'paid' unless the amount equals the total exactly.
      const finished = await deps.finish(orderId, decision);
      deps.log({ event: 'verify', outcome: finished.result, http: decision.http, mode: decision.mode });
      if (deps.afterFinish) await deps.afterFinish(finished.result).catch(() => {});

      switch (finished.result) {
        case 'paid':
          return json({ result: 'paid', status: 'paid' } satisfies Answer);
        case 'mismatch':
          return json({ result: 'mismatch', status: kind.mismatchStatus } satisfies Answer);
        case 'not_verified':
          return json({ result: 'not_verified', status: kind.openStatus, reason: decision.reason ?? 'unknown' } satisfies Answer);
        case 'unavailable':
          return json({ result: 'unavailable', status: kind.openStatus } satisfies Answer);
        case 'closed':
          return json({ result: finished.status === 'paid' ? 'already_paid' : 'closed', status: finished.status } satisfies Answer);
        default:
          return json({ result: 'not_found' } satisfies Answer, 404);
      }
    } catch (error) {
      // A database error after a verified payment leaves the claim held for up to 90 seconds; a retry then verifies again.
      deps.log({ event: 'error', message: String((error as Error)?.message ?? '').slice(0, 80) });
      return json({ error: 'server_error' }, 500);
    }
  };
}
