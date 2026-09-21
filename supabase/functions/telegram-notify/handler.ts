// telegram-notify: sends the admin's queued notifications (the `admin_notifications` outbox) to Telegram.
//
// The customer-facing functions (verify-deposit, wallet-request) send from the outbox in-process (_shared/notifyOutbox.ts).
// This endpoint is for retries and manual flushes, and it is SERVER-SIDE ONLY: it accepts one caller, presenting the
// project's service-role key. The app cannot call it (it never has that key; a customer's token is refused with 401).
// Nothing in the request is used as message content: the text comes from the database rows, which SQL functions wrote in the
// same transaction as the action they report. So even a caller with the key can only make it (re)send what is queued.
import { drainOutbox, type OutboxDeps } from '../_shared/notifyOutbox.ts';
import { CORS_HEADERS } from '../_shared/validation.ts';

export type Deps = OutboxDeps & {
  /** True only for the service-role key (constant-time comparison happens in here, not in the handler). */
  isServiceCaller: (token: string) => boolean;
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, 'content-type': 'application/json' } });

export function createHandler(deps: Deps) {
  return async function handle(req: Request): Promise<Response> {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
    if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

    const token = /^Bearer\s+(\S+)$/i.exec(req.headers.get('authorization') ?? '')?.[1];
    if (!token || !deps.isServiceCaller(token)) return json({ error: 'unauthorized' }, 401);

    try {
      const result = await drainOutbox(deps);
      if (!result.ok) return json({ error: result.error, queued: result.queued }, 503);
      return json({ sent: result.sent, failed: result.failed });
    } catch (error) {
      deps.log({ event: 'error', message: String((error as Error)?.message ?? '').slice(0, 80) });
      return json({ error: 'server_error' }, 500);
    }
  };
}
