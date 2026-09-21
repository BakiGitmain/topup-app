// Run with: npm run test:unit
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';

import { SEARCH_IDLE_MS, SHOP_SEARCH_IDLE_MS, normalizeSearchText, searchProducts, searchTokens } from './searchLogic.ts';

const P = (name, category, tagline = '') => ({ name, category, tagline });
const CATALOG = [
  P('Free Fire', 'games', 'Diamonds and memberships'),
  P('PUBG Mobile', 'games', 'UC and Prime'),
  P('Mobile Legends', 'games', 'Diamonds'),
  P('Steam Wallet', 'gift-cards', 'Wallet codes'),
  P('Google Play', 'gift-cards', 'Play Store credit'),
  P('Elden Ring', 'game-keys', 'PC game key'),
  P('Telegram Premium', 'subscriptions', 'Three whole months'),
  P('Airtime Top-up', 'airtime', 'Ethio Telecom'),
];
const names = (q) => searchProducts(CATALOG, q).map((p) => p.name);

describe('the delay', () => {
  it('server searches wait 1.5 s after the last key', () => assert.equal(SEARCH_IDLE_MS, 1500));
  it('the shop filters what is already on the phone, so it does not wait', () => assert.equal(SHOP_SEARCH_IDLE_MS, 0));
});

describe('normalizing and splitting', () => {
  it('lower-cases, strips accents and punctuation', () => {
    assert.equal(normalizeSearchText('  Free-Fire! '), 'free fire');
    assert.equal(normalizeSearchText('Café  Ñandú'), 'cafe nandu');
    assert.equal(normalizeSearchText(null), '');
  });
  it('keeps letters of other scripts', () => assert.equal(normalizeSearchText('ፍሪ ፋየር'), 'ፍሪ ፋየር'));
  it('tokens: repeats dropped, at most 5', () => {
    assert.deepEqual(searchTokens('  Fire  free FIRE '), ['fire', 'free']);
    assert.equal(searchTokens('a b c d e f g').length, 5);
    assert.deepEqual(searchTokens('   '), []);
  });
});

describe('searching every kind of product', () => {
  it('finds by name, by part of a word, in any word order', () => {
    assert.deepEqual(names('free fire'), ['Free Fire']);
    assert.deepEqual(names('fire free'), ['Free Fire']);
    assert.deepEqual(names('fir'), ['Free Fire']);
    assert.deepEqual(names('MOBILE'), ['Mobile Legends', 'PUBG Mobile']);
  });
  it('finds by the kind of product: gift cards, keys, subscriptions, games', () => {
    assert.deepEqual(names('gift card').sort(), ['Google Play', 'Steam Wallet']);
    assert.deepEqual(names('key'), ['Elden Ring']);
    assert.deepEqual(names('subscription'), ['Telegram Premium']);
    assert.deepEqual(names('game').sort(), ['Elden Ring', 'Free Fire', 'Mobile Legends', 'PUBG Mobile'].sort());
  });
  it('finds by tagline', () => {
    assert.deepEqual(names('play store'), ['Google Play']);
    assert.deepEqual(names('three months'), ['Telegram Premium']);
  });
  it('EVERY word must match: an extra unrelated word finds nothing', () => {
    assert.deepEqual(names('free fire banana'), []);
    assert.deepEqual(names('steam diamonds'), []);
  });
  it('a name match ranks above a tagline match', () => {
    const list = [P('Wallet Pro', 'games', ''), P('Steam Wallet', 'gift-cards', ''), P('Other', 'games', 'a wallet thing')];
    assert.deepEqual(searchProducts(list, 'wallet').map((p) => p.name), ['Wallet Pro', 'Steam Wallet', 'Other']);
  });
  it('airtime is never returned, an empty query returns nothing, and the input is not modified', () => {
    assert.deepEqual(names('airtime'), []);
    assert.deepEqual(names('ethio'), []);
    assert.deepEqual(names(''), []);
    assert.deepEqual(names('   '), []);
    assert.equal(CATALOG.length, 8);
  });
  it('is fast on a large catalog', () => {
    const big = Array.from({ length: 5000 }, (_, i) => P(`Game ${i} Mobile`, 'games', 'Diamonds'));
    const t0 = performance.now();
    const out = searchProducts(big, 'game 42 mobile');
    assert.ok(out.length > 0);
    assert.ok(performance.now() - t0 < 200, 'a 5,000-product search should take well under 200 ms');
  });
});

describe('wiring guards (source checks)', () => {
  const root = new URL('../../', import.meta.url);
  const read = (p) => fs.readFileSync(new URL(p, root), 'utf8');
  it('the two searches that ask the server wait for the pause, use the shared hook, and search at once on Enter', () => {
    for (const f of ['src/app/import-product.tsx', 'src/app/(admin)/customers.tsx']) {
      const text = read(f);
      assert.match(text, /useDebouncedSearch\(.*SEARCH_IDLE_MS\)/, f);
      assert.match(text, /onSubmit=\{search\.flush\}/, f);
      assert.ok(!/DEBOUNCE_MS\s*=\s*300/.test(text) && !/useDebounced\(query\.trim\(\), 300\)/.test(text), `${f} must not keep its own short debounce`);
    }
  });
  it('the shop filters locally with the shared search, and the delay is one constant', () => {
    const shop = read('src/app/(customer)/shop.tsx');
    assert.match(shop, /searchProducts\(/);
    assert.match(shop, /useDebouncedSearch\(query, SHOP_SEARCH_IDLE_MS\)/);
    assert.ok(!/supabase/.test(shop), 'the shop search makes no request');
  });
  it('the catalog search sends one request per pause: at least 2 letters, and every word must match', () => {
    const api = read('src/lib/supplierCatalog.ts');
    assert.match(api, /tokens\.join\(' '\)\.length < 2/);
    assert.match(api, /for \(const t of tokens\)/);
  });
});
