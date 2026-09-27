// Picks WHICH supplier's catalog a supplier-catalog request is about, then hands the request to that supplier's handler.
// The body says `"supplier": "shop2topup" | "gamesdrop"`; a body that doesn't say defaults to Shop2Topup. FazerCards'
// trial has ended and it is not one of the choices any more (see CLAUDE.md, 2026-09-22). The list stays a list, and the
// dispatch below stays generic, so bringing a supplier back (or adding a fourth) is "write its handler, add its name
// here" -- not a rewrite of this file. Authentication and the admin check stay inside each handler.
import { CORS_HEADERS } from '../_shared/validation.ts';

export const SUPPLIERS = ['shop2topup', 'gamesdrop'] as const;
export type SupplierName = (typeof SUPPLIERS)[number];
const DEFAULT_SUPPLIER: SupplierName = 'shop2topup';

export function createRouter(handlers: Record<SupplierName, (req: Request) => Promise<Response>>) {
  return async function route(req: Request): Promise<Response> {
    if (req.method !== 'POST') return handlers[DEFAULT_SUPPLIER](req); // OPTIONS and wrong methods are answered the same way as ever

    let supplier: unknown = DEFAULT_SUPPLIER;
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
