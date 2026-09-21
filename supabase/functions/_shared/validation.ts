// Pure rules for the validate-id function. No imports, so Node can test them and Deno can run them.

export type BuyerField = {
  key: string;
  label?: string;
  type?: string;
  options?: { label?: string; value: string }[];
};

export type FieldCheck =
  | { ok: true; fields: Record<string, string> }
  | { ok: false; reason: 'unknown' | 'required' | 'invalid'; key: string };

const MAX_VALUE = 128;

/**
 * The same rules the database applies (unknown key, missing/blank value, too long, bad dropdown
 * value), so a bad request is refused early with a clear reason. The database re-checks anyway.
 */
export function checkFields(buyerFields: BuyerField[], input: unknown): FieldCheck {
  const given = input !== null && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};

  for (const key of Object.keys(given)) {
    if (!buyerFields.some((f) => f.key === key)) return { ok: false, reason: 'unknown', key: key.slice(0, 60) };
  }

  const fields: Record<string, string> = {};
  for (const field of buyerFields) {
    const raw = given[field.key];
    if (typeof raw !== 'string' && typeof raw !== 'number') return { ok: false, reason: 'required', key: field.key };
    const value = String(raw).trim();
    if (value === '') return { ok: false, reason: 'required', key: field.key };
    if (value.length > MAX_VALUE) return { ok: false, reason: 'invalid', key: field.key };
    if ((field.type ?? 'text') === 'select' && !(field.options ?? []).some((o) => o.value === value)) {
      return { ok: false, reason: 'invalid', key: field.key };
    }
    fields[field.key] = value;
  }
  return { ok: true, fields };
}

/**
 * Purchase field keys -> the keys the supplier's validation expects. Mobile Legends buys with
 * `server_id` but validates with `zone_id`: {"server_id": "zone_id"}.
 */
export function toSupplierFields(fields: Record<string, string>, fieldMap: unknown): Record<string, string> {
  const map = fieldMap !== null && typeof fieldMap === 'object' && !Array.isArray(fieldMap) ? (fieldMap as Record<string, unknown>) : {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(fields)) {
    const mapped = map[key];
    out[typeof mapped === 'string' && mapped !== '' ? mapped : key] = value;
  }
  return out;
}

export type Outcome = 'invalid' | 'unavailable';

/**
 * A supplier error is either "that ID is not valid" (the supplier said so) or "we couldn't
 * check" (anything else: it is down, slow, rate-limiting us, or our own key is wrong).
 * Only the first must ever be shown to the customer as a bad ID.
 */
export function classifySupplierError(error: unknown): { outcome: Outcome; status: number | null } {
  const status = typeof (error as { status?: unknown } | null)?.status === 'number' ? ((error as { status: number }).status) : null;
  if (status === 400 || status === 404 || status === 422) return { outcome: 'invalid', status };
  return { outcome: 'unavailable', status };
}

export type SupplierResult =
  | { valid: true; playerName: string | null; accountRegion: string | null }
  | { valid: false };

/** Only `valid === true` counts. Anything else, including a shape we don't recognise, is not valid. */
export function parseSupplierResult(result: unknown): SupplierResult {
  if (result === null || typeof result !== 'object') return { valid: false };
  const r = result as Record<string, unknown>;
  if (r.valid !== true) return { valid: false };
  const name = typeof r.player_name === 'string' && r.player_name.trim() !== '' ? r.player_name : null;
  const region = typeof r.region === 'string' && r.region.trim() !== '' ? r.region : null;
  return { valid: true, playerName: name, accountRegion: region };
}

export const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type',
  'access-control-allow-methods': 'POST, OPTIONS',
};

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
