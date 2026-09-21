// wallet-request: how the app creates a deposit request or a withdrawal request.
//
// Why an Edge Function and not a straight database call from the app: creating a request must ALSO tell the admin on
// Telegram, and only server-side code may do that (the app never holds the bot token or the service key). The database
// does the real work: this function calls create_deposit_request / create_withdrawal_request AS THE SIGNED-IN CUSTOMER
// (their own token, so auth.uid() and row security apply exactly as if the app had called them), then sends the queued
// notification in-process (_shared/notifyOutbox.ts). The notification text was already written by SQL inside the same transaction as the request.
//
// It adds no rules of its own: amounts, balances, limits and account formats are all enforced in the database.
import { CORS_HEADERS } from '../_shared/validation.ts';

export type RpcResult = { data: unknown } | { error: { message?: string; details?: string | null } };

export type Deps = {
  getUserId: (token: string) => Promise<string | null>;
  /** Calls the SQL function with the customer's own token. */
  createDeposit: (token: string, amount: number) => Promise<RpcResult>;
  createWithdrawal: (token: string, args: { amount: number; provider: string; account: string }) => Promise<RpcResult>;
  /** Flush the Telegram outbox. Best effort: failure never changes the answer. */
  notify: () => Promise<void>;
  log: (event: Record<string, unknown>) => void;
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, 'content-type': 'application/json' } });

/** The database's refusals, in words the app understands. Anything else is a generic failure: no internals leak. */
const REFUSALS: [RegExp, number, string][] = [
  [/invalid_amount/, 400, 'invalid_amount'],
  [/invalid_provider/, 400, 'invalid_provider'],
  [/invalid_account/, 400, 'invalid_account'],
  [/insufficient_balance/, 409, 'insufficient_balance'],
  [/deposit_open/, 409, 'deposit_open'],
  [/too_many_pending/, 409, 'too_many_pending'],
  [/not_authenticated/, 401, 'unauthorized'],
];

function refusal(error: { message?: string; details?: string | null }): Response | null {
  const message = String(error.message ?? '');
  for (const [pattern, status, code] of REFUSALS) {
    if (pattern.test(message)) {
      const detail = code === 'deposit_open' && /^[0-9a-f-]{36}$/i.test(String(error.details ?? '')) ? { deposit_id: String(error.details) } : {};
      return json({ error: code, ...detail }, status);
    }
  }
  return null;
}

const asAmount = (value: unknown): number | null => {
  const n = typeof value === 'string' && /^[0-9]+(\.[0-9]{1,2})?$/.test(value.trim()) ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 && n <= 10_000_000 ? n : null;
};

export function createHandler(deps: Deps) {
  return async function handle(req: Request): Promise<Response> {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
    if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

    const token = /^Bearer\s+(\S+)$/i.exec(req.headers.get('authorization') ?? '')?.[1];
    const userId = token ? await deps.getUserId(token).catch(() => null) : null;
    if (!token || !userId) return json({ error: 'unauthorized' }, 401);

    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'bad_request' }, 400);
    }

    try {
      let result: RpcResult;
      if (body?.action === 'deposit') {
        const amount = asAmount(body.amount);
        if (amount === null) return json({ error: 'invalid_amount' }, 400);
        result = await deps.createDeposit(token, amount);
      } else if (body?.action === 'withdraw') {
        const amount = asAmount(body.amount);
        if (amount === null) return json({ error: 'invalid_amount' }, 400);
        if (typeof body.provider !== 'string' || body.provider.length > 20) return json({ error: 'invalid_provider' }, 400);
        if (typeof body.account !== 'string' || body.account.length > 40) return json({ error: 'invalid_account' }, 400);
        result = await deps.createWithdrawal(token, { amount, provider: body.provider, account: body.account });
      } else {
        return json({ error: 'bad_request' }, 400);
      }

      if ('error' in result) {
        const known = refusal(result.error);
        if (known) {
          deps.log({ event: 'wallet_request', action: body.action, outcome: 'refused' });
          return known;
        }
        throw new Error('rpc_failed');
      }

      deps.log({ event: 'wallet_request', action: body.action, outcome: 'created' });
      await deps.notify().catch(() => {});
      return json({ ok: true, ...(result.data as Record<string, unknown>) });
    } catch (error) {
      deps.log({ event: 'error', message: String((error as Error)?.message ?? '').slice(0, 80) });
      return json({ error: 'server_error' }, 500);
    }
  };
}
