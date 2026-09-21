/** Player-ID form and validation state. Pure functions with no imports. */

export const DEBOUNCE_MS = 600;
/** How long "Checking…" may run before we stop waiting and offer Retry. */
export const CHECK_TIMEOUT_MS = 15_000;
/** A record is treated as gone this long before the server's expiry, so we never send a purchase that is about to be refused. */
export const EXPIRY_MARGIN_MS = 5_000;

export type BuyerField = {
  key: string;
  label: string;
  type: 'text' | 'select';
  options?: { label: string; value: string }[];
};

/** Only the declared fields, trimmed. Anything else the form happens to hold is dropped. */
export function normalizeFields(fields: readonly BuyerField[], values: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of fields) out[field.key] = (values[field.key] ?? '').trim();
  return out;
}

/** Every declared field filled in (and, for dropdowns, one of the offered values). */
export function isFieldsComplete(fields: readonly BuyerField[], values: Record<string, string>): boolean {
  const clean = normalizeFields(fields, values);
  return fields.every((f) => {
    const value = clean[f.key];
    if (value === '' || value.length > 128) return false;
    return f.type !== 'select' || (f.options ?? []).some((o) => o.value === value);
  });
}

/** Identifies "this region with exactly these fields". A result for a different key is never used. */
export function fieldsKey(regionId: string | null, fields: readonly BuyerField[], values: Record<string, string>): string {
  const clean = normalizeFields(fields, values);
  return JSON.stringify([regionId, Object.keys(clean).sort().map((k) => [k, clean[k]])]);
}

export type IdCheck =
  | { kind: 'idle' }
  | { kind: 'checking'; key: string }
  | {
      kind: 'valid';
      key: string;
      validationId: string;
      /** The player's name exactly as the supplier sent it. */
      playerName: string | null;
      accountRegion: string | null;
      /** Epoch ms. */
      expiresAt: number;
    }
  | { kind: 'invalid'; key: string }
  | { kind: 'unavailable'; key: string; reason: 'timeout' | 'error' | 'busy' }
  /** Was valid, but the server's window has run out: check again. */
  | { kind: 'expired'; key: string };

/** What the screen should treat the check as, right now, for these exact inputs. */
export function currentCheck(state: IdCheck, key: string, now: number): IdCheck {
  if (state.kind === 'idle' || state.key !== key) return { kind: 'idle' };
  if (state.kind === 'valid' && now >= state.expiresAt - EXPIRY_MARGIN_MS) return { kind: 'expired', key };
  return state;
}

/** The only state in which a region that validates IDs may proceed. */
export function isValidNow(state: IdCheck, key: string, now: number): boolean {
  return currentCheck(state, key, now).kind === 'valid';
}

export type Blocker =
  | 'choose_package'
  | 'fill_fields'
  | 'checking'
  | 'invalid_id'
  | 'check_failed'
  | 'check_expired'
  | 'confirm_id'
  | 'wrong_region'
  | 'region_unknown'
  | 'package_unavailable';

export type ContinueInput = {
  hasPackage: boolean;
  packageState: 'pending' | 'ok' | 'wrong_region' | 'region_unknown' | 'unavailable';
  fieldsComplete: boolean;
  /** 'supplier' = the server checks the ID; 'tick' = the customer confirms; 'none' = nothing to check. */
  idMode: 'supplier' | 'tick' | 'none';
  check: IdCheck;
  ticked: boolean;
};

/**
 * Why Continue is off, or null when it may be on. A timeout, an error, an invalid ID and an
 * expired check ALL keep it off: the database will not sell without a matching record.
 */
export function continueBlocker(input: ContinueInput): Blocker | null {
  // The ID comes first on the page, so it is also what is asked for first: fields, then (where the server checks) the check,
  // and only then the pack.
  if (!input.fieldsComplete) return 'fill_fields';

  if (input.idMode === 'supplier') {
    switch (input.check.kind) {
      case 'valid':
        break;
      case 'checking':
      case 'idle':
        return 'checking';
      case 'invalid':
        return 'invalid_id';
      case 'unavailable':
        return 'check_failed';
      case 'expired':
        return 'check_expired';
    }
  }

  if (!input.hasPackage) return 'choose_package';
  if (input.packageState === 'unavailable') return 'package_unavailable';

  if (input.idMode === 'supplier') {
    if (input.packageState === 'wrong_region') return 'wrong_region';
    if (input.packageState === 'region_unknown') return 'region_unknown';
    if (input.packageState !== 'ok') return 'checking';
  } else if (input.idMode === 'tick') {
    if (!input.ticked) return 'confirm_id';
    if (input.packageState !== 'ok' && input.packageState !== 'pending') return 'package_unavailable';
  }
  return null;
}
