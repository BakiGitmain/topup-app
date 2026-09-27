// Gifts part 3: how the Vault arranges its three kinds of entry, how gift orders read in the Orders list, that every
// claim refusal has its own message, and that the new cards are built from the app's existing parts.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';

import { giftOrderView } from './orderView.ts';
import { daysLeft, liveCount, vaultSections } from './vaultView.ts';

const src = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
const card = (id, used, at) => ({ id, is_used: used, created_at: at });
const gift = (id, status, at) => ({ id, status, createdAt: at });
const code = (id, status, at) => ({ id, status, createdAt: at });
const data = {
  cards: [card('c1', false, '2026-09-20'), card('c2', true, '2026-09-21')],
  gifts: [gift('g1', 'claimed', '2026-09-22'), gift('g2', 'pending', '2026-09-19'), gift('g3', 'pending', '2026-09-23'), gift('g4', 'expired', '2026-09-18')],
  codes: [code('r1', 'active', '2026-09-24'), code('r2', 'redeemed', '2026-09-25')],
};
const ids = (list) => list.map((e) => e.item.id);

describe('vault filter', () => {
  it('All: gifts to claim first (newest first), then unused gift cards, then unused redeem codes; everything done below', () => {
    const { live, done } = vaultSections('all', data);
    assert.deepEqual(ids(live), ['g3', 'g2', 'c1', 'r1']);
    assert.deepEqual(ids(done), ['r2', 'g1', 'c2', 'g4']);
  });
  it('each filter shows only its own kind', () => {
    assert.deepEqual(ids(vaultSections('cards', data).live), ['c1']);
    assert.deepEqual(ids(vaultSections('gifts', data).live), ['g3', 'g2']);
    assert.deepEqual(ids(vaultSections('gifts', data).done), ['g1', 'g4']);
    assert.deepEqual(ids(vaultSections('codes', data).live), ['r1']);
    assert.deepEqual(ids(vaultSections('codes', data).done), ['r2']);
  });
  it("a chip's number is what still wants attention", () => {
    assert.equal(liveCount('all', data), 4);
    assert.equal(liveCount('gifts', data), 2);
    assert.equal(liveCount('codes', { cards: [], gifts: [], codes: [] }), 0);
  });
  it('days left to claim, never negative', () => {
    const now = Date.parse('2026-09-27T12:00:00Z');
    assert.equal(daysLeft('2026-10-07T12:00:00Z', now), 10);
    assert.equal(daysLeft('2026-09-27T18:00:00Z', now), 1);
    assert.equal(daysLeft('2026-09-26T12:00:00Z', now), 0);
  });
});

describe('gift orders in the Orders list', () => {
  it("the buyer's gift order shows the gift's own state, not a stalled 'paid'", () => {
    assert.deepEqual(giftOrderView({ status: 'paid', gift_kind: 'gift', gift_state: 'pending' }), { label: 'orders.gift.sent', state: 'pending', tone: 'processing' });
    assert.deepEqual(giftOrderView({ status: 'paid', gift_kind: 'gift', gift_state: 'claimed' }), { label: 'orders.gift.sent', state: 'claimed', tone: 'completed' });
    assert.deepEqual(giftOrderView({ status: 'paid', gift_kind: 'redeem_code', gift_state: 'active' }), { label: 'orders.gift.code', state: 'active', tone: 'processing' });
    assert.deepEqual(giftOrderView({ status: 'paid', gift_kind: 'redeem_code', gift_state: 'redeemed' }), { label: 'orders.gift.code', state: 'redeemed', tone: 'completed' });
    assert.deepEqual(giftOrderView({ status: 'paid', gift_kind: 'gift', gift_state: 'expired' }), { label: 'orders.gift.sent', state: 'expired', tone: 'cancelled' });
  });
  it('an unpaid gift order keeps its own status; the recipient\'s delivery order is "gift received"; a normal order is untouched', () => {
    assert.deepEqual(giftOrderView({ status: 'pending_payment', gift_kind: 'gift', gift_state: null }), { label: 'orders.gift.sent', state: null, tone: null });
    assert.deepEqual(giftOrderView({ status: 'completed', gift_id: 'x' }), { label: 'orders.gift.received', state: null, tone: null });
    assert.equal(giftOrderView({ status: 'paid' }), null);
  });
  it('every state and label has a string in both languages', () => {
    const strings = src('./strings.ts');
    for (const key of ['orders.gift.sent', 'orders.gift.code', 'orders.gift.received', ...['pending', 'claimed', 'expired', 'active', 'redeemed'].map((s) => `orders.gift.state.${s}`)]) {
      assert.equal(strings.split(`'${key}':`).length - 1, 2, key);
    }
  });
});

describe('claim refusals', () => {
  it("every reason claim_gift can raise has its own message, in English and Amharic (plus 'unknown')", () => {
    const migration = src('../../supabase/migrations/20261016090000_gifts_and_redeem_codes.sql');
    const body = migration.slice(migration.indexOf('create or replace function public.claim_gift'));
    const raised = [...new Set([...body.matchAll(/raise exception '([a-z_]+)'/g)].map((m) => m[1]))];
    assert.ok(raised.length >= 12, raised.join());
    const claim = src('./giftClaim.ts');
    const strings = src('./strings.ts');
    for (const reason of [...raised, 'unknown']) {
      if (reason !== 'unknown') assert.match(claim, new RegExp(`'${reason}'`), `${reason} is in CLAIM_ERRORS`);
      assert.equal(strings.split(`'vault.claimErr.${reason}':`).length - 1, 2, reason);
    }
  });
});

describe('built from the existing parts', () => {
  const giftCard = src('../components/gift/GiftCard.tsx');
  const codeCard = src('../components/gift/RedeemCodeCard.tsx');
  it("one product-art rule: the shop tile and both new cards draw ProductArt", () => {
    for (const [name, text] of [['ProductTile', src('../components/market/ProductTile.tsx')], ['GiftCard', giftCard], ['RedeemCodeCard', codeCard]]) {
      assert.match(text, /<ProductArt /, name);
      assert.doesNotMatch(text, /tileLetter\(/, `${name} draws no letter tile of its own`);
    }
  });
  it("the claim card uses the product page's own ID form and check, and the normal order screen afterwards", () => {
    assert.match(giftCard, /<IdForm/);
    assert.match(giftCard, /useIdValidation\(\{/);
    assert.match(giftCard, /packageState\(/);
    assert.match(giftCard, /router\.push\(\{ pathname: '\/order\/\[id\]', params: \{ id: result\.deliveryOrderId \} \}\)/);
  });
  it('the code card copies with the shared CopyButton; the vault filters with the shared Chips', () => {
    assert.match(codeCard, /<CopyButton /);
    assert.match(src('../app/(customer)/vault.tsx'), /<Chips/);
  });
  it('delivery on claim is the ordinary delivery step, awaited: fulfill-order, never a supplier call of its own', () => {
    const claim = src('./giftClaim.ts');
    assert.match(claim, /rpc\('claim_gift'/);
    assert.match(claim, /functions\.invoke\('fulfill-order', \{ body: \{ order_id: orderId \} \}\)/);
  });
});
