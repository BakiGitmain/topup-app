/**
 * The one way scripts talk to GamesDrop: a tiny client that can only READ. GET requests, plus the two POST endpoints that
 * change nothing (/offers/sync, /offers/find-one, /offers/check-game-data). Anything under /orders (create-order, or any
 * other order path) is refused, so a script can never place an order or spend wallet money.
 * The key comes from the environment and is never printed. API: https://gamesdrop.io/en/docs/partner-api
 * Auth: a shop API token, sent as a bare `Authorization: <token>` header (no "Bearer " prefix needed; both work, plain is
 * what the docs' own examples use). Base URL: https://partner.gamesdrop.io
 * The docs say the balance check is GET /api/v1/partner/balance; the REAL path is GET /api/v1/balance (confirmed live,
 * 2026-09-22) -- the documented one 404s. Response fields are also camelCase (draftBalance, balanceProfile, partnerId),
 * not the snake_case the docs page shows.
 */
const BASE = 'https://partner.gamesdrop.io';
const apiKey = process.env.GAMESDROP_API_KEY;
if (!apiKey) {
  console.error('GAMESDROP_API_KEY is not set. Run with: node --env-file=.env scripts/<script>.ts');
  process.exit(1);
}

const READ_ONLY_POST = new Set(['/api/v1/offers/sync', '/api/v1/offers/find-one', '/api/v1/offers/check-game-data']);

export type GDResult = { http: number; body: any };

async function call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<GDResult> {
  if (/order/i.test(path)) throw new Error(`BLOCKED: ${path} could place or read orders`);
  if (method === 'POST' && !READ_ONLY_POST.has(path)) throw new Error(`BLOCKED: POST ${path} is not on the read-only allowlist`);
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: apiKey, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text.slice(0, 300) };
  }
  return { http: res.status, body: parsed };
}

export const gd = {
  get: (path: string) => call('GET', path),
  balance: () => call('GET', '/api/v1/balance'),
  sync: (input: { limit?: number; page?: number; category?: string; search?: string; countryCode?: string }) => call('POST', '/api/v1/offers/sync', input),
  findOne: (input: { offerId: number; countryCode?: string }) => call('POST', '/api/v1/offers/find-one', input),
  checkGameData: (input: { offerId: number; gameUserId: string; gameServerId?: string }) => call('POST', '/api/v1/offers/check-game-data', input),
};
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
