// The fulfill-order request handler, with every outside dependency injected so it can be tested without the network
// or the database. index.ts wires the real ones.
//
// Called two ways: (1) the client, right after checkout_cart()/pay_order_with_wallet() comes back paid -- the
// customer's own token, checked against the order's own user_id below; (2) verify-payment, in-process, right after
// a bank transfer is confirmed -- see verify-payment/index.ts, which calls attemptFulfillment directly rather than
// hitting this Edge Function over HTTP (the same reason notifyOutbox.ts is called in-process: a function-to-function
// call needs auth this function cannot verify for itself). A one-off backfill script can also call attemptFulfillment
// directly with the service role key, bypassing this HTTP handler entirely -- see scripts/backfill-fulfillment.ts.
import { attemptFulfillment, type FulfillmentDeps } from '../_shared/fulfillment.ts';
import { CORS_HEADERS } from '../_shared/validation.ts';

export type Deps = FulfillmentDeps & {
  /** The user behind a bearer token, or null if the token is not valid. */
  getUserId: (token: string) => Promise<string | null>;
  /** false = no such order, or it belongs to someone else. */
  ownsOrder: (userId: string, orderId: string) => Promise<boolean>;
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, 'content-type': 'application/json' } });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createHandler(deps: Deps) {
  return async function handle(req: Request): Promise<Response> {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
    if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

    const token = /^Bearer\s+(\S+)$/i.exec(req.headers.get('authorization') ?? '')?.[1];
    const userId = token ? await deps.getUserId(token).catch(() => null) : null;
    if (!userId) return json({ error: 'unauthorized' }, 401);

    let body: { order_id?: unknown };
    try {
      body = await req.json();
    } catch {
      return json({ error: 'bad_request' }, 400);
    }
    const orderId = typeof body?.order_id === 'string' && UUID.test(body.order_id) ? body.order_id : null;
    if (!orderId) return json({ error: 'bad_request' }, 400);

    if (!(await deps.ownsOrder(userId, orderId).catch(() => false))) return json({ error: 'forbidden' }, 403);

    // attemptFulfillment never throws (every failure path is caught inside it): a bad response here would mean
    // something is wrong with this handler itself, not with fulfillment failing, which is always a normal 200.
    const result = await attemptFulfillment(orderId, deps);
    return json(result);
  };
}
