// Gift checkout, part 2: gift mode as it travels between screens, the small pure helpers, and source guards for the
// rules that live in screens (no player ID at purchase, gift orders never in the admin queue, one reused catalog).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';

import { giftParams, groupCode, looksLikeEmail, readGiftParams } from './giftMode.ts';

const src = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
const ID = '11111111-2222-4333-8444-555555555555';

describe('gift mode params', () => {
  it('a gift carries its recipient; a redeem code carries nothing else; not gifting carries nothing', () => {
    assert.deepEqual(giftParams({ kind: 'gift', to: ID, toName: 'Bruk' }), { giftKind: 'gift', giftTo: ID, giftToName: 'Bruk' });
    assert.deepEqual(giftParams({ kind: 'redeem_code', to: null, toName: null }), { giftKind: 'redeem_code' });
    assert.deepEqual(giftParams(null), {});
  });
  it('reads back exactly what was sent', () => {
    for (const target of [{ kind: 'gift', to: ID, toName: 'Bruk' }, { kind: 'redeem_code', to: null, toName: null }]) {
      assert.deepEqual(readGiftParams(giftParams(target)), target);
    }
  });
  it('anything else is not gift mode (no half-configured gift reaches checkout)', () => {
    assert.equal(readGiftParams({}), null);
    assert.equal(readGiftParams({ giftKind: 'gift' }), null, 'a gift with no recipient');
    assert.equal(readGiftParams({ giftKind: 'gift', giftTo: 'not-an-id' }), null);
    assert.equal(readGiftParams({ giftKind: 'present', giftTo: ID }), null);
  });
});

describe('helpers', () => {
  it('a code reads in two halves', () => {
    assert.equal(groupCode('ABCDE12345'), 'ABCDE 12345');
    assert.equal(groupCode('SHORT'), 'SHORT');
  });
  it('only a full email is sent to the lookup', () => {
    assert.ok(looksLikeEmail(' friend@gmail.com '));
    for (const bad of ['friend', 'friend@', '@gmail.com', 'friend@gmail', 'a b@gmail.com']) assert.ok(!looksLikeEmail(bad), bad);
  });
});

describe('the rules that live in screens', () => {
  const product = src('../app/product/[id].tsx');
  const shop = src('../app/(customer)/shop.tsx');
  const admin = src('./admin.ts');
  const gift = src('./gift.ts');
  it('gift mode never asks for a player ID and never sends one: no fields, no supplier check, no cart', () => {
    assert.match(product, /const buyerFields: BuyerField\[\] = gift\s*\?\s*\[\]/);
    assert.match(product, /const idMode: 'supplier' \| 'tick' \| 'none' = gift\s*\?\s*'none'/);
    assert.match(product, /checkoutGift\(selected\.id, gift\.kind, gift\.kind === 'gift' \? gift\.to : null\)/);
    assert.match(gift, /rpc\('checkout_gift', \{ p_option_id: optionId, p_kind: kind, p_recipient: recipientId \}\)/, 'no delivery/fields argument exists');
    assert.match(src('../components/product/ActionBar.tsx'), /\{!giftLabel && \(/, 'no add-to-cart while gifting');
  });
  it('the admin queue and its badge never list a gift or redeem-code order', () => {
    assert.match(admin, /supabase\.from\('orders'\)\.select\(QUEUE_COLUMNS\)\.is\('gift_kind', null\)/);
    assert.match(admin, /\.is\('gift_kind', null\)\s*\.in\('status', \['pending', 'paid'\]\)/);
  });
  it('the gift flow reuses the real shop catalog, not a second product browser', () => {
    assert.match(shop, /export function ShopCatalog\(\{ gift \}: \{ gift\?: GiftTarget \}\)/);
    assert.match(shop, /export default function ShopScreen\(\) \{\s*return <ShopCatalog \/>;/);
    assert.match(src('../app/gift/shop.tsx'), /return <ShopCatalog gift=\{gift\} \/>;/);
    assert.match(shop, /\{!gift && \(buyAgain\.data/, '"Buy again" is for yourself');
  });
  it('the code is never put in a route (it would end up in navigation history)', () => {
    const done = src('../app/gift/done/[id].tsx');
    assert.match(done, /fetchGiftSummary\(id\)/);
    assert.doesNotMatch(product + src('../app/pay/[id].tsx'), /params: \{[^}]*code/);
  });
  it('every gift string exists in English and Amharic', () => {
    const strings = src('./strings.ts');
    const keys = [...new Set([...strings.matchAll(/'(gift\.[a-zA-Z.]+)':/g)].map((m) => m[1]))];
    assert.ok(keys.length >= 30, String(keys.length));
    for (const key of keys) assert.equal(strings.split(`'${key}':`).length - 1, 2, key);
  });
});
