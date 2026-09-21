/** Reading the validate-id function's answer. Pure functions with no imports. */

export type ValidateResult =
  | {
      status: 'valid';
      validationId: string;
      /** Epoch ms on THIS device's clock, worked out from how long the server says it lasts. */
      expiresAt: number;
      /** The player's name exactly as the supplier sent it. */
      playerName: string | null;
      accountRegion: string | null;
    }
  | { status: 'invalid' }
  | { status: 'unavailable'; reason: 'error' | 'busy' };

/** Anything unexpected is "unavailable", never "valid". */
export function parseValidateResponse(data: unknown, now: number = Date.now()): ValidateResult {
  if (data === null || typeof data !== 'object') return { status: 'unavailable', reason: 'error' };
  const d = data as Record<string, unknown>;

  if (d.status === 'invalid') return { status: 'invalid' };
  if (
    d.status === 'valid' &&
    typeof d.validation_id === 'string' &&
    d.validation_id !== '' &&
    typeof d.expires_in === 'number' &&
    Number.isFinite(d.expires_in) &&
    d.expires_in > 0
  ) {
    return {
      status: 'valid',
      validationId: d.validation_id,
      expiresAt: now + d.expires_in * 1000,
      playerName: typeof d.player_name === 'string' ? d.player_name : null,
      accountRegion: typeof d.account_region === 'string' && d.account_region.trim() !== '' ? d.account_region : null,
    };
  }
  return { status: 'unavailable', reason: 'error' };
}
