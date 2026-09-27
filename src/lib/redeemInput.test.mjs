// Gifts part 4: typing/pasting a redeem code, reading redeem_code's reply, and source guards for the redeem screen and
// the gift purchase (the code never leaves the screen's state; a non-refundable purchase is confirmed first).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';

import { giftTerms } from './giftMode.ts';
import { CODE_LENGTH, displayRedeemInput, normalizeRedeemInput, readRedeemReply } from './redeemInput.ts';

const src = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');

describe('typing and pasting a code', () => {
  it('upper-cases and drops spaces and dashes, however it was grouped', () => {
    for (const typed of ['abcde2fghj', 'ABCDE 2FGHJ', 'abcde-2fghj', ' ab cd e2 fg hj ']) assert.equal(normalizeRedeemInput(typed), 'ABCDE2FGHJ', typed);
  });
  it('keeps a partial code as typed (no guessing while typing)', () => {
    assert.equal(normalizeRedeemInput('ab'), 'AB');
    assert.equal(normalizeRedeemInput('ABCDE F'), 'ABCDEF');
    assert.equal(normalizeRedeemInput(''), '');
  });
  it('never grows past 10 characters', () => {
    assert.equal(normalizeRedeemInput('ABCDE2FGHJK'), 'ABCDE2FGHJ');
    assert.equal(CODE_LENGTH, 10);
  });
  it('a pasted message yields the code, not the words around it', () => {
    assert.equal(normalizeRedeemInput('Your code: ABCDE-2FGHJ, enjoy!'), 'ABCDE2FGHJ');
    assert.equal(normalizeRedeemInput('Here you go -> abcde 2fghj <- use it in Portal'), 'ABCDE2FGHJ');
    assert.equal(normalizeRedeemInput('code\nKQ7PM3XZ9R\nthanks'), 'KQ7PM3XZ9R');
  });
  it('a pasted all-letter code is still found (codes without a digit exist)', () => {
    assert.equal(normalizeRedeemInput('Code: QWERTASDFG !!'), 'QWERTASDFG');
  });
  it('shows the code grouped like the done screen: ABCDE FGHIJ', () => {
    assert.equal(displayRedeemInput('ABCDE2FGHJ'), 'ABCDE 2FGHJ');
    assert.equal(displayRedeemInput('ABC'), 'ABC');
    // what is shown, typed back, is the same code
    assert.equal(normalizeRedeemInput(displayRedeemInput('ABCDE2FGHJ')), 'ABCDE2FGHJ');
  });
});

describe("reading redeem_code's reply", () => {
  it('only a real success with a gift id counts as redeemed', () => {
    assert.deepEqual(readRedeemReply({ ok: true, gift_id: 'g1' }), { kind: 'ok', giftId: 'g1' });
    assert.equal(readRedeemReply({ ok: true }).kind, 'error');
    assert.equal(readRedeemReply({ ok: true, gift_id: '' }).kind, 'error');
    assert.equal(readRedeemReply({ ok: 'true', gift_id: 'g1' }).kind, 'error');
  });
  it('each refusal reads as itself', () => {
    assert.equal(readRedeemReply({ ok: false, error: 'invalid_code' }).kind, 'invalid');
    assert.equal(readRedeemReply({ ok: false, error: 'already_redeemed' }).kind, 'already_mine');
    assert.equal(readRedeemReply({ ok: false, error: 'too_many_attempts' }).kind, 'too_many');
    assert.equal(readRedeemReply({ ok: false, error: 'not_authenticated' }).kind, 'signed_out');
  });
  it('nothing / garbage / an unknown error is "error", never success', () => {
    for (const d of [null, undefined, 'x', 42, {}, { ok: false, error: 'something_new' }]) assert.equal(readRedeemReply(d).kind, 'error');
  });
});

describe('what the gift buyer is told before paying (no refunds)', () => {
  it('always: no refunds, 90-day expiry', () => {
    assert.deepEqual(giftTerms('gift', null), [{ key: 'gift.terms.noRefund' }]);
    assert.deepEqual(giftTerms('redeem_code', { regionLocked: false, accountRegionCodes: [] }), [{ key: 'gift.terms.noRefund' }]);
  });
  it('a region-locked pack also names the regions that can claim it, worded for a gift or a code', () => {
    assert.deepEqual(giftTerms('gift', { regionLocked: true, accountRegionCodes: ['ME'] })[1], { key: 'gift.terms.regionGift', regions: 'ME' });
    assert.deepEqual(giftTerms('redeem_code', { regionLocked: true, accountRegionCodes: ['BR', 'NA'] })[1], { key: 'gift.terms.regionCode', regions: 'BR, NA' });
  });
});

describe('source guards', () => {
  const screen = src('../app/redeem.tsx');
  it('the redeem screen keeps the code in state only: no route params, no logging, no storage', () => {
    assert.ok(!/useLocalSearchParams|useGlobalSearchParams/.test(screen), 'reads no code from a route (a link could leak it)');
    assert.ok(!/params:\s*\{[^}]*code/.test(screen), 'puts no code into a route');
    assert.ok(!/console\.|AsyncStorage|SecureStore|localStorage/.test(screen), 'never logs or stores the code');
    assert.ok(/setCode\(''\)/.test(screen), 'clears the code once redeemed');
  });
  it('the redeem screen guards double taps synchronously (a ref, not only React state)', () => {
    assert.ok(/useRef\(false\)/.test(screen) && /inFlight\.current/.test(screen));
  });
  it('Profile links to it', () => {
    assert.ok(/router\.push\('\/redeem'\)/.test(src('../app/(customer)/profile.tsx')));
  });
  it('the gift purchase asks for confirmation BEFORE charging, and shows the terms', () => {
    const page = src('../app/product/[id].tsx');
    const body = page.slice(page.indexOf('async function onGift()'));
    assert.ok(body.indexOf('confirmDestructive(') > -1 && body.indexOf('confirmDestructive(') < body.indexOf('checkoutGift('), 'confirm comes first');
    assert.ok(/if \(!confirmed\) return;/.test(body), 'a cancel charges nothing');
    assert.ok(/<GiftTerms terms=\{giftTerms\(gift\.kind, selected\)\}/.test(page));
  });
});
