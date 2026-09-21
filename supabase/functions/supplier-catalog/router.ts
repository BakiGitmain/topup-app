// Picks WHICH supplier's catalog a supplier-catalog request is about, then hands the request to that supplier's handler.
// The body says `"supplier": "fazercards" | "shop2topup"`; a body that doesn't say defaults to FazerCards, so everything that
// existed before keeps working exactly as it did. Authentication and the admin check stay inside each handler.
import { CORS_HEADERS } from '../_shared/validation.ts';

export const SUPPLIERS = ['fazercards', 'shop2topup'] as const;
export type SupplierName = (typeof SUPPLIERS)[number];

export function createRouter(handlers: Record<SupplierName, (req: Request) => Promise<Response>>) {
  return async function route(req: Request): Promise<Response> {
    if (req.method !== 'POST') return handlers.fazercards(req); // OPTIONS and wrong methods are answered the same way as ever

    let supplier: unknown = 'fazercards';
    try {
      const body = await req.clone().json();
      if (body !== null && typeof body === 'object' && 'supplier' in body) supplier = (body as { supplier?: unknown }).supplier;
    } catch {
      // Unreadable body: the handler answers "bad_request" itself.
    }
    if (typeof supplier !== 'string' || !(SUPPLIERS as readonly string[]).includes(supplier)) {
      return new Response(JSON.stringify({ error: 'bad_request' }), { status: 400, headers: { ...CORS_HEADERS, 'content-type': 'application/json' } });
    }
    return handlers[supplier as SupplierName](req);
  };
}
