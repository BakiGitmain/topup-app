// Redeem codes as people type and paste them, and what redeem_code's reply means. Pure: no Supabase, no React.

export const CODE_LENGTH = 10;

/**
 * What was typed or pasted -> the code, as the server will read it (upper case, letters and digits only, at most 10).
 * Typing (and a paste of just the code, grouped or not) is taken as is. A pasted message ("Your code: ABCDE-FGHIJ,
 * enjoy!") yields the code, not the words around it: the 10-character runs in it (optionally split 5 + 5 by a space
 * or dash) are the candidates, one with a digit preferred (words have none), else the first.
 */
export function normalizeRedeemInput(raw: string): string {
  const upper = raw.toUpperCase();
  const plain = upper.replace(/[\s-]/g, '');
  if (/^[A-Z0-9]*$/.test(plain) && plain.length <= CODE_LENGTH) return plain;
  const runs = [...upper.matchAll(/(?<![A-Z0-9])([A-Z0-9]{5})[\s-]?([A-Z0-9]{5})(?![A-Z0-9])/g)].map((m) => m[1] + m[2]);
  const pick = runs.find((r) => /\d/.test(r)) ?? runs[0];
  if (pick) return pick;
  return plain.replace(/[^A-Z0-9]/g, '').slice(0, CODE_LENGTH);
}

/** The code as it is shown while typing: ABCDE FGHIJ (the same grouping as the done screen). */
export function displayRedeemInput(code: string): string {
  return code.length > 5 ? `${code.slice(0, 5)} ${code.slice(5)}` : code;
}

export type RedeemReply =
  | { kind: 'ok'; giftId: string }
  /** Not found, expired, or someone else's: one answer, so a guess learns nothing. */
  | { kind: 'invalid' }
  /** This same account already redeemed it: it is in their Vault. */
  | { kind: 'already_mine' }
  | { kind: 'too_many' }
  | { kind: 'signed_out' }
  /** No usable reply (network, server): nothing is known, so nothing is claimed. */
  | { kind: 'error' };

/** Reads redeem_code's jsonb reply. Anything unexpected is 'error', never 'ok'. */
export function readRedeemReply(data: unknown): RedeemReply {
  const d = (data ?? {}) as { ok?: unknown; gift_id?: unknown; error?: unknown };
  if (d.ok === true && typeof d.gift_id === 'string' && d.gift_id.length > 0) return { kind: 'ok', giftId: d.gift_id };
  switch (d.error) {
    case 'invalid_code':
      return { kind: 'invalid' };
    case 'already_redeemed':
      return { kind: 'already_mine' };
    case 'too_many_attempts':
      return { kind: 'too_many' };
    case 'not_authenticated':
      return { kind: 'signed_out' };
    default:
      return { kind: 'error' };
  }
}
