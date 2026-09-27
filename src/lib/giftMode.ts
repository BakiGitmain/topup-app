/**
 * Gift mode as it travels between screens: the shop, a category's "see all" and the product page read the same three
 * route params, so one catalog serves both normal buying and gifting. Pure, no runtime imports (Node tests it).
 */
export type GiftTarget =
  | { kind: 'gift'; to: string; toName: string }
  | { kind: 'redeem_code'; to: null; toName: null };

export type GiftRouteParams = { giftKind?: string; giftTo?: string; giftToName?: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The params to carry along; {} when not gifting. */
export function giftParams(target: GiftTarget | null | undefined): Record<string, string> {
  if (!target) return {};
  if (target.kind === 'gift') return { giftKind: 'gift', giftTo: target.to, giftToName: target.toName };
  return { giftKind: 'redeem_code' };
}

/** Gift mode from route params, or null. A gift without a proper recipient id is not gift mode (nothing to send to). */
export function readGiftParams(params: GiftRouteParams): GiftTarget | null {
  if (params.giftKind === 'redeem_code') return { kind: 'redeem_code', to: null, toName: null };
  if (params.giftKind === 'gift' && typeof params.giftTo === 'string' && UUID.test(params.giftTo)) {
    return { kind: 'gift', to: params.giftTo, toName: (params.giftToName ?? '').trim() };
  }
  return null;
}

/** "ABCDE FGHIJ": easier to read out and type back; redeem_code ignores the space. */
export const groupCode = (code: string) => (code.length === 10 ? `${code.slice(0, 5)} ${code.slice(5)}` : code);

/** A plausible email before asking the server (the server is the real check). */
export const looksLikeEmail = (value: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value.trim());

/**
 * What the buyer must know before paying for a gift or redeem code (owner's decision: no refunds). Always: it can't
 * be refunded and expires unused after 90 days. For a region-locked pack also: only an account in those regions can
 * claim it -- the recipient's region is only checked at claim time, and a mismatch there can't be undone.
 */
export type GiftTerm =
  | { key: 'gift.terms.noRefund' }
  | { key: 'gift.terms.regionGift' | 'gift.terms.regionCode'; regions: string };

export function giftTerms(kind: GiftTarget['kind'], pack: { regionLocked: boolean; accountRegionCodes: string[] } | null): GiftTerm[] {
  const terms: GiftTerm[] = [{ key: 'gift.terms.noRefund' }];
  if (pack?.regionLocked && pack.accountRegionCodes.length > 0) {
    terms.push({ key: kind === 'gift' ? 'gift.terms.regionGift' : 'gift.terms.regionCode', regions: pack.accountRegionCodes.join(', ') });
  }
  return terms;
}
