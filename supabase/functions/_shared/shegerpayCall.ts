// The ONE place that makes an HTTP call to ShegerPay. verify-payment (orders) and verify-deposit (wallet deposits) both use it,
// so there is a single copy of the request shape, the auth header and the timeout. The key is passed in by the function that
// owns the secret; it never appears in an error, a log or a return value here.
//
// What is sent (from ShegerPay's SDK; see CLAUDE.md "ShegerPay contract"): POST {base}/api/v1/verify with header X-API-Key and
// body { provider, transaction_id, amount, merchant_name }. amount null = lookup only.
import type { CallResult } from './shegerpay.ts';

export type CallerConfig = {
  /** SHEGER_PAY_KEY. Empty means "not configured": every call then fails as unavailable (503), never as a payment result. */
  key: string;
  baseUrl?: string;
  timeoutMs?: number;
  userAgent?: string;
  /** Injected in tests; defaults to the global fetch. */
  fetchFn?: typeof fetch;
};

export type CallArgs = { provider: string; reference: string; amount: number | null; merchantName: string | null };

export function createShegerPayCaller(config: CallerConfig) {
  const base = (config.baseUrl ?? 'https://api.shegerpay.com').replace(/\/$/, '');
  const timeoutMs = config.timeoutMs ?? 20_000;
  const doFetch = config.fetchFn ?? fetch;

  return async function callShegerPay({ provider, reference, amount, merchantName }: CallArgs): Promise<CallResult> {
    if (!config.key) throw Object.assign(new Error('payment key is not configured'), { status: 503 });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await doFetch(`${base}/api/v1/verify`, {
        method: 'POST',
        headers: {
          'X-API-Key': config.key,
          'Content-Type': 'application/json',
          'User-Agent': config.userAgent ?? 'topup-verify/1.0',
        },
        body: JSON.stringify({
          provider,
          transaction_id: reference,
          amount,
          merchant_name: merchantName ?? 'ShegerPay Verification',
        }),
        signal: controller.signal,
      });
      const text = await res.text();
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        body = { raw: text.slice(0, 500) };
      }
      return { http: res.status, body };
    } finally {
      clearTimeout(timer);
    }
  };
}
