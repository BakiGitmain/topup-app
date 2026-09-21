import { supabase } from './supabase';
import { parseValidateResponse, type ValidateResult } from './validateResponse';

export type { ValidateResult } from './validateResponse';

/**
 * Asks the validate-id Edge Function to check a player ID. The supplier is never called from the
 * app, and the app only ever hears the player's name, the account's region and a record id.
 * Never throws: every failure is an "unavailable".
 */
export async function validateId(regionId: string, fields: Record<string, string>): Promise<ValidateResult> {
  try {
    const { data, error } = await supabase.functions.invoke('validate-id', {
      body: { region_id: regionId, fields },
    });

    if (error) {
      const status = (error as { context?: { status?: number } }).context?.status;
      return { status: 'unavailable', reason: status === 429 ? 'busy' : 'error' };
    }
    return parseValidateResponse(data);
  } catch {
    return { status: 'unavailable', reason: 'error' };
  }
}
