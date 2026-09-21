// Pure rules for talking to ShegerPay's verify API. No imports, so Node can test them and Deno can run them.
//
// What is confirmed about the API (from the official SDK source, the org's staff-app repo, and live probes of
// api.shegerpay.com; their docs page is a JavaScript shell and the OpenAPI schema is disabled in production):
//   POST https://api.shegerpay.com/api/v1/verify      header  X-API-Key: sk_test_... | sk_live_...
//   body   { provider: "telebirr" | "cbe", transaction_id, amount (OPTIONAL), merchant_name }
//   error  { "error_code": "AUTH_REQUIRED", "message": "..." }      (snake_case; 401 for a bad key)
//   test keys (sk_test_) simulate; live keys (sk_live_) really verify.
// What is NOT confirmed: the exact JSON of a SUCCESSFUL verification. The two official SDKs disagree on its field
// spelling (Python reads snake_case, the JS types say camelCase), so parseVerification accepts both and the raw body
// of every attempt is stored (payment_attempts.response) so the real shape can be read after the first live call.

export const PROVIDERS = ['telebirr', 'cbe'] as const;
export type Provider = (typeof PROVIDERS)[number];

export const isProvider = (value: unknown): value is Provider => typeof value === 'string' && (PROVIDERS as readonly string[]).includes(value);

/** "ft24 352" -> "FT24352". Null unless it is 4-64 letters, digits, "_" or "-" once spaces are gone. */
export function normalizeReference(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const ref = input.replace(/\s+/g, '').toUpperCase();
  return /^[A-Z0-9_-]{4,64}$/.test(ref) ? ref : null;
}

/** Money is compared in whole cents so 0.1 + 0.2 style float noise can never decide a payment. */
export const amountsEqual = (a: number, b: number) => Number.isFinite(a) && Number.isFinite(b) && Math.round(a * 100) === Math.round(b * 100);

export type Verification = {
  verified: boolean;
  status: string | null;
  /** What the provider says was transferred, if it says. */
  amount: number | null;
  mode: 'test' | 'live' | null;
  reason: string | null;
  errorCode: string | null;
};

const SUCCESS_STATUSES = new Set(['verified', 'success', 'completed', 'paid']);

const pick = (o: Record<string, unknown>, ...keys: string[]) => {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k];
  return undefined;
};

/**
 * Reads a verification response. Strict about success (only a real boolean true, and a status that isn't a failure),
 * tolerant about spelling (snake_case and camelCase). Null when it isn't a JSON object at all.
 */
export function parseVerification(body: unknown): Verification | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  const o = body as Record<string, unknown>;

  const flag = pick(o, 'verified', 'valid');
  const status = typeof o.status === 'string' ? o.status.toLowerCase() : null;
  const verified = flag === true && (status === null || SUCCESS_STATUSES.has(status));

  const rawAmount = pick(o, 'amount', 'amount_paid', 'amountPaid');
  const amount = typeof rawAmount === 'number' ? rawAmount : typeof rawAmount === 'string' && rawAmount.trim() !== '' ? Number(rawAmount) : NaN;

  const mode = o.mode === 'test' || o.mode === 'live' ? o.mode : null;
  const reason = pick(o, 'reason', 'message', 'detail');
  const errorCode = pick(o, 'error_code', 'errorCode');

  return {
    verified,
    status,
    amount: Number.isFinite(amount) ? amount : null,
    mode,
    reason: typeof reason === 'string' ? reason.slice(0, 300) : null,
    errorCode: typeof errorCode === 'string' ? errorCode.slice(0, 60) : null,
  };
}

export type HttpClass = 'ok' | 'rejected' | 'unavailable';

/**
 * 2xx = an answer. 400/404/422 = ShegerPay understood the request and says it doesn't verify (or it is malformed).
 * Everything else (401/403 our key is wrong, 402 quota, 429, 5xx) is NOT an answer about the payment.
 */
export function classifyHttp(status: number): HttpClass {
  if (status >= 200 && status < 300) return 'ok';
  if (status === 400 || status === 404 || status === 422) return 'rejected';
  return 'unavailable';
}

export type Reason = 'not_found' | 'provider_mismatch' | 'pending' | 'invalid_request' | 'unknown';

/** A safe category for the customer. The provider's own wording is never passed on. */
export function reasonCategory(text: string | null | undefined, status: string | null = null): Reason {
  if (status === 'pending' || status === 'processing') return 'pending';
  const t = (text ?? '').toLowerCase();
  if (/provider|wrong bank|different bank|not a (cbe|telebirr)|receiver|merchant/.test(t)) return 'provider_mismatch';
  // A complaint about the FORMAT wins over "invalid transaction", which would otherwise read as "not found".
  if (/malformed|format|required/.test(t)) return 'invalid_request';
  if (/not found|no transaction|does not exist|doesn't exist|unknown transaction|invalid|not exist/.test(t)) return 'not_found';
  return 'unknown';
}

export type CallResult = { http: number; body: unknown };
export type Decision = {
  outcome: 'paid' | 'mismatch' | 'not_verified' | 'unavailable';
  /** Paid: the order total. Mismatch: what the provider reported (null if it didn't say). */
  amount: number | null;
  mode: 'test' | 'live' | null;
  http: number | null;
  /** Everything ShegerPay said, kept for audit. */
  raw: { with_amount?: unknown; lookup?: unknown; error?: string };
  reason: Reason | null;
};

const unavailable = (raw: Decision['raw'], http: number | null): Decision => ({ outcome: 'unavailable', amount: null, mode: null, http, raw, reason: null });

/**
 * Decides what a payment is worth, using `call(amount)` to ask ShegerPay. It NEVER returns 'paid' unless
 * ShegerPay verified the transfer and the amount is exactly the order total:
 *
 *  1. Ask with the order total. Verified: if it also reports an amount, that must equal the total (else mismatch).
 *  2. Not verified: it may be "no such transfer" or "wrong amount", and the answer looks the same. Ask again with
 *     NO amount (a lookup): if the transfer exists but the amount-checked call refused it, that is a mismatch
 *     for a person to look at. If it doesn't exist, the customer just has the wrong reference.
 *  3. Any doubt (a timeout, an auth problem, an odd answer) is 'unavailable' or a mismatch, never paid.
 */
export async function decidePayment(call: (amount: number | null) => Promise<CallResult>, total: number): Promise<Decision> {
  let first: CallResult;
  try {
    first = await call(total);
  } catch (error) {
    return unavailable({ error: String((error as Error)?.message ?? error).slice(0, 120) }, null);
  }
  const raw: Decision['raw'] = { with_amount: first.body };
  const class1 = classifyHttp(first.http);
  if (class1 === 'unavailable') return unavailable(raw, first.http);

  const v1 = class1 === 'ok' ? parseVerification(first.body) : null;
  if (v1?.verified) {
    if (v1.amount !== null && !amountsEqual(v1.amount, total)) {
      return { outcome: 'mismatch', amount: v1.amount, mode: v1.mode, http: first.http, raw, reason: null };
    }
    return { outcome: 'paid', amount: total, mode: v1.mode, http: first.http, raw, reason: null };
  }

  const parsed1 = parseVerification(first.body);
  if (parsed1 && (parsed1.status === 'pending' || parsed1.status === 'processing')) {
    return { outcome: 'not_verified', amount: null, mode: parsed1.mode, http: first.http, raw, reason: 'pending' };
  }

  let second: CallResult;
  try {
    second = await call(null);
  } catch (error) {
    return unavailable({ ...raw, error: String((error as Error)?.message ?? error).slice(0, 120) }, first.http);
  }
  raw.lookup = second.body;
  const class2 = classifyHttp(second.http);
  if (class2 === 'unavailable') return unavailable(raw, second.http);

  const v2 = class2 === 'ok' ? parseVerification(second.body) : null;
  if (v2?.verified) {
    // The transfer is real but the amount-checked call refused it: a person must look, whatever the amount says.
    return { outcome: 'mismatch', amount: v2.amount, mode: v2.mode, http: second.http, raw, reason: null };
  }

  return {
    outcome: 'not_verified',
    amount: null,
    mode: parsed1?.mode ?? v2?.mode ?? null,
    http: first.http,
    raw,
    reason: reasonCategory(parsed1?.reason ?? v2?.reason ?? null, parsed1?.status ?? null),
  };
}
