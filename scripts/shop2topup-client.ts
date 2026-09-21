/**
 * The one way scripts talk to Shop2Topup: a tiny client that can only READ.
 * GET requests, plus POST /player/validate (an ID check: it changes nothing). Anything under /orders is refused, so a script can
 * never place an order or spend wallet money. The key comes from the environment and is never printed.
 * API: https://shop2topup.com/en/reseller-api  (Authorization: Bearer <keyId>.<secret>)
 */
const BASE = 'https://shop2topup.com/api/endpoints/v1';
const apiKey = process.env.SHOP2TOPUP_API_KEY;
if (!apiKey) {
  console.error('SHOP2TOPUP_API_KEY is not set. Run with: node --env-file=.env scripts/<script>.ts');
  process.exit(1);
}

export type S2Result = { http: number; body: any; retryAfter: number | null };

async function call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<S2Result> {
  if (/^\/orders(\/|$|\?)/.test(path)) throw new Error(`BLOCKED: ${path} could place or read orders`);
  if (method === 'POST' && path !== '/player/validate') throw new Error(`BLOCKED: POST ${path} is not read-only`);
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text.slice(0, 300) };
  }
  const retry = Number(res.headers.get('retry-after'));
  return { http: res.status, body: parsed, retryAfter: Number.isFinite(retry) && retry > 0 ? retry : null };
}

export const s2 = {
  get: (path: string) => call('GET', path),
  validate: (input: { sub_category_id: number; player_id: string; zone_id?: string; server?: string }) => call('POST', '/player/validate', input),
};
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
