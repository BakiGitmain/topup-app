// Run with: npm run test:unit. The network is faked; the fixtures are trimmed copies of REAL responses from the live
// service (2026-09-22), so the tests break if the mapping stops matching what GamesDrop actually sends.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';

import {
  GAMESDROP_VALIDATED_OFFERS, GDError, createGamesDropClient, gamesdropValidationOffer, normalizeGamesDropCategory, syncAll, toRawCategories, toRawOffers,
} from './gamesdrop.ts';

const reply = (http, body) => ({ status: http, text: async () => JSON.stringify(body) });
function fake(routes) {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : null });
    const path = url.replace('https://partner.gamesdrop.io', '');
    for (const [pattern, answer] of routes) if (path.startsWith(pattern)) return typeof answer === 'function' ? answer(init) : answer;
    return reply(404, { error: { code: 'NOT_FOUND' } });
  };
  return { calls, client: createGamesDropClient({ key: 'tok', fetchFn }) };
}

// ---- real shapes, trimmed from the live catalog (2026-09-22)
const BS_GLOBAL_51 = {
  offerId: 2733, offerGroupId: 2733, offerGroupName: 'bloodstrike 51', productId: 77, productName: 'Blood Strike',
  price: 0.39, currency: 'USD', inStock: true, isRequiredGameUserId: true, isRequiredGameServerId: false,
};
const BS_GLOBAL_105 = { ...BS_GLOBAL_51, offerId: 2737, offerGroupId: 2737, offerGroupName: 'bloodstrike 105', price: 0.78 };
const BS_MENA_51 = { ...BS_GLOBAL_51, offerId: 2749, offerGroupId: 2749, offerGroupName: 'bloodstrikeme 51', price: 0.43 };
const PS_VOUCHER = {
  offerId: 7, offerGroupId: 7, offerGroupName: 'USA $10', productId: 2, productName: 'Playstation Network US',
  price: 9.52, currency: 'USD', inStock: true, isRequiredGameUserId: false, isRequiredGameServerId: false,
};
const ML_TWO_FIELD = {
  offerId: 900, offerGroupId: 900, offerGroupName: '86 Diamonds', productId: 55, productName: 'Mobile Legends',
  price: 1.5, currency: 'USD', inStock: true, isRequiredGameUserId: true, isRequiredGameServerId: true,
};

describe('auth and the read-only client', () => {
  it('sends the token bare, no "Bearer " prefix', async () => {
    const { client, calls } = fake([['/api/v1/balance', reply(200, { balance: 500.25, currency: { code: 'USD' } })]]);
    await client.balance();
    assert.equal(calls[0].headers.Authorization, 'tok');
  });
  it('a wrong token is a clean 401, not a crash', async () => {
    const { client } = fake([['/api/v1/balance', reply(401, { error: { code: 'INVALID_TOKEN', message: 'INVALID_TOKEN (status=401)' } })]]);
    await assert.rejects(client.balance(), (e) => e instanceof GDError && e.status === 401 && e.code === 'INVALID_TOKEN');
  });
  it('balance() reads the real (camelCase) field names, not what the docs page shows', async () => {
    const { client } = fake([['/api/v1/balance', reply(200, { balance: 0, draftBalance: 20, balanceProfile: 'MIXED', currency: { id: 3, code: 'USD' }, partnerId: 277 })]]);
    assert.deepEqual(await client.balance(), { balance: 0, currencyCode: 'USD' });
  });
  it('never calls anything with "order" in the path', () => {
    const src = fs.readFileSync(new URL('./gamesdrop.ts', import.meta.url), 'utf8');
    assert.match(src, /if \(\/order\/i\.test\(path\)\)/);
  });
  it('with no key configured, every call refuses locally before any network request', async () => {
    let called = false;
    const client = createGamesDropClient({ key: '', fetchFn: async () => { called = true; return reply(200, {}); } });
    await assert.rejects(client.balance(), (e) => e instanceof GDError && e.code === 'NO_KEY');
    assert.equal(called, false);
  });
});

describe('sync (the flat catalog)', () => {
  it('sends the page params as the body, and returns count + rows', async () => {
    const { client, calls } = fake([['/api/v1/offers/sync', reply(200, { count: 46, rows: [BS_GLOBAL_51] })]]);
    const out = await client.sync({ limit: 50, page: 1, search: 'blood strike' });
    assert.deepEqual(calls[0].body, { limit: 50, page: 1, search: 'blood strike' });
    assert.deepEqual(out, { count: 46, rows: [BS_GLOBAL_51] });
  });
  it('a malformed reply (no rows array) is an error, not a silent empty catalog', async () => {
    const { client } = fake([['/api/v1/offers/sync', reply(200, { count: 5 })]]);
    await assert.rejects(client.sync({ limit: 10, page: 1 }), GDError);
  });
});

describe('syncAll: pages through the whole catalog', () => {
  it('fetches exactly ceil(count / pageSize) pages, in page order, and concatenates every row', async () => {
    const pages = { 1: [BS_GLOBAL_51, BS_GLOBAL_105], 2: [BS_MENA_51, PS_VOUCHER], 3: [ML_TWO_FIELD] };
    const seen = [];
    const client = { sync: async ({ page }) => { seen.push(page); return { count: 5, rows: pages[page] ?? [] }; } };
    const rows = await syncAll(client, {}, 2, 6);
    assert.deepEqual(seen.sort((a, b) => a - b), [1, 2, 3]);
    assert.deepEqual(rows, [BS_GLOBAL_51, BS_GLOBAL_105, BS_MENA_51, PS_VOUCHER, ML_TWO_FIELD]);
  });
  it('one page is enough when the count fits in it', async () => {
    const client = { sync: async () => ({ count: 2, rows: [BS_GLOBAL_51, BS_MENA_51] }) };
    assert.deepEqual(await syncAll(client, {}, 1000), [BS_GLOBAL_51, BS_MENA_51]);
  });
  it('an empty catalog asks for exactly one page, not zero and not a crash', async () => {
    let calls = 0;
    const client = { sync: async () => { calls++; return { count: 0, rows: [] }; } };
    assert.deepEqual(await syncAll(client, {}, 100), []);
    assert.equal(calls, 1);
  });
});

describe('check-game-data', () => {
  it('sends offerId and gameUserId, and gameServerId only when given', async () => {
    const { client, calls } = fake([['/api/v1/offers/check-game-data', reply(200, { status: 'VALID', gameUserLogin: 'x' })]]);
    await client.checkGameData({ offerId: 2733, gameUserId: '1' });
    assert.deepEqual(calls[0].body, { offerId: 2733, gameUserId: '1' });
    await client.checkGameData({ offerId: 900, gameUserId: '1', gameServerId: '2' });
    assert.deepEqual(calls[1].body, { offerId: 900, gameUserId: '1', gameServerId: '2' });
  });
  it('VALID returns the login name, verbatim, and no region (this endpoint never reports one)', async () => {
    const { client } = fake([['/api/v1/offers/check-game-data', reply(200, { status: 'VALID', gameUserLogin: 'BAKI神' })]]);
    assert.deepEqual(await client.checkGameData({ offerId: 2733, gameUserId: '568840231399' }), { valid: true, player_name: 'BAKI神', region: null });
  });
  it('INVALID (even for a real player id on the WRONG offer -- e.g. a MENA offer with a Global account) is status 400, never invented as valid', async () => {
    const { client } = fake([['/api/v1/offers/check-game-data', reply(200, { status: 'INVALID', message: 'Неверный ID игрока' })]]);
    await assert.rejects(client.checkGameData({ offerId: 2749, gameUserId: '568840231399' }), (e) => e instanceof GDError && e.status === 400 && e.code === 'INVALID');
  });
  it('a missing required field is a 5xx from GamesDrop\'s side, never mistaken for an invalid ID', async () => {
    const { client } = fake([['/api/v1/offers/check-game-data', reply(500, { error: { code: 'SERVICE_UNAVAILABLE', message: "Field validation for 'GameUserID' failed" } })]]);
    await assert.rejects(client.checkGameData({ offerId: 2733, gameUserId: '' }), (e) => e instanceof GDError && e.status === 500);
  });
  it('a nonexistent offerId ALSO answers INVALID -- there is no way to tell "wrong offer" from "wrong player" here, which is exactly why only a hand-proven offerId is ever used to validate', async () => {
    const { client } = fake([['/api/v1/offers/check-game-data', reply(200, { status: 'INVALID' })]]);
    await assert.rejects(client.checkGameData({ offerId: 999999999, gameUserId: '568840231399' }), (e) => e.status === 400);
  });
});

describe('grouping the flat catalog into categories (one product = one category)', () => {
  const rows = [BS_GLOBAL_51, BS_GLOBAL_105, BS_MENA_51, PS_VOUCHER];
  it('topups = needs a player id; a voucher (no fields at all) is never counted as one', () => {
    const cats = toRawCategories(rows, 'topups');
    assert.deepEqual(cats.map((c) => c.category_id), ['77']);
    assert.equal(cats[0].name, 'Blood Strike');
  });
  it('giftcards = the reverse: only offers that ask for nothing', () => {
    const cats = toRawCategories(rows, 'giftcards');
    assert.deepEqual(cats.map((c) => c.category_id), ['2']);
    assert.equal(cats[0].name, 'Playstation Network US');
  });
  it('requiresServerId is true only when at least one of the product\'s offers needs it', () => {
    assert.equal(toRawCategories(rows, 'topups')[0].requiresServerId, false);
    assert.equal(toRawCategories([...rows, ML_TWO_FIELD], 'topups').find((c) => c.category_id === '55').requiresServerId, true);
  });
});

const CTX = { blocklist: {}, listedAt: '2026-09-22T00:00:00Z' };

describe('normalizeGamesDropCategory', () => {
  const bloodRow = toRawCategories([BS_GLOBAL_51], 'topups')[0];
  const voucherRow = toRawCategories([PS_VOUCHER], 'giftcards')[0];

  it('is tagged with its supplier, so it can never be mistaken for another one', () => {
    assert.equal(normalizeGamesDropCategory('topups', bloodRow, CTX).supplier, 'gamesdrop');
  });
  it('a proven game (Blood Strike) gets the ID check, with the hand-picked offerId, never a guess', () => {
    const r = normalizeGamesDropCategory('topups', bloodRow, CTX);
    assert.equal(r.validation_category_id, '2733');
    assert.deepEqual(r.validation_fields, [{ key: 'gameUserId', label: 'Player ID', type: 'text' }]);
  });
  it('a game whose check has not been proven (Mobile Legends here) falls back to the customer\'s tick', () => {
    const mlRow = toRawCategories([ML_TWO_FIELD], 'topups')[0];
    const r = normalizeGamesDropCategory('topups', mlRow, CTX);
    assert.equal(r.validation_category_id, null);
    assert.equal(r.validation_fields, null);
  });
  it('a proven game that also needs a server id gets both fields', () => {
    const withServer = { ...ML_TWO_FIELD, productName: 'Blood Strike' }; // hypothetical: same game, needing a server id
    const row = toRawCategories([withServer], 'topups')[0];
    const r = normalizeGamesDropCategory('topups', row, CTX);
    assert.deepEqual(r.validation_fields.map((f) => f.key), ['gameUserId', 'gameServerId']);
  });
  it('region is never guessed: no note_region, no region_label (the region lives in each pack\'s own name instead)', () => {
    assert.deepEqual([normalizeGamesDropCategory('topups', bloodRow, CTX).region_label, normalizeGamesDropCategory('topups', bloodRow, CTX).note_region], [null, null]);
  });
  it('a giftcard (voucher) row is never ID-checked', () => {
    const r = normalizeGamesDropCategory('giftcards', voucherRow, CTX);
    assert.deepEqual([r.validation_category_id, r.validation_fields], [null, null]);
  });
  it('a blocked category (by the shared blocklist) is still flagged, the same mechanism as every other supplier', () => {
    const r = normalizeGamesDropCategory('topups', bloodRow, { blocklist: { 'topups/77': 'first-purchase only' }, listedAt: CTX.listedAt });
    assert.equal(r.blocked_reason, 'first-purchase only');
  });
  it('an unusable row becomes null, not a crash', () => {
    for (const bad of [{}, { category_id: '', name: 'x', game: 'g' }, { category_id: '1', name: ' ', game: 'g' }, { category_id: '1', name: 'x' }]) {
      assert.equal(normalizeGamesDropCategory('topups', bad, CTX), null);
    }
  });
});

describe('gamesdropValidationOffer', () => {
  it('is case-insensitive and trims whitespace', () => {
    assert.equal(gamesdropValidationOffer('Blood Strike'), '2733');
    assert.equal(gamesdropValidationOffer('  blood strike  '), '2733');
    assert.equal(gamesdropValidationOffer('BLOOD STRIKE'), '2733');
  });
  it('is null for anything not proven', () => {
    assert.equal(gamesdropValidationOffer('Free Fire'), null);
    assert.equal(gamesdropValidationOffer('Silver and Blood'), null); // contains "Blood" but is a different game
  });
  it('today the proven list is exactly Blood Strike and Delta Force', () => assert.deepEqual(GAMESDROP_VALIDATED_OFFERS, { 'blood strike': '2733', 'delta force': '2578' }));
});

describe('toRawOffers: one product\'s packs, in the shape normalizeOffers (catalog.ts) understands', () => {
  it('keeps only this product\'s offers, of the matching family, and drops out-of-stock ones', () => {
    const outOfStock = { ...BS_MENA_51, inStock: false };
    const out = toRawOffers('topups', [BS_GLOBAL_51, BS_GLOBAL_105, outOfStock, PS_VOUCHER], '77');
    assert.deepEqual(out.offers.map((o) => o.offer_id), ['2733', '2737']);
  });
  it('the price is a string with the exact USD value, and the name is the offer group name verbatim', () => {
    const out = toRawOffers('topups', [BS_GLOBAL_51], '77');
    assert.deepEqual(out.offers[0], { offer_id: '2733', card_id: '2733', name: 'bloodstrike 51', price_usd: '0.39' });
  });
  it('the buyer form uses the same player_id/server_id keys every other supplier does (not GamesDrop\'s own gameUserId/' +
    'gameServerId param names, which stay in validation_fields/checkGameData only -- catalog_fields_are_safe rejects camelCase ' +
    'keys, so a mismatched buyer key would block every GamesDrop topup category live)', () => {
    assert.deepEqual(toRawOffers('topups', [BS_GLOBAL_51], '77').fields.map((f) => f.key), ['player_id']);
    assert.deepEqual(toRawOffers('topups', [ML_TWO_FIELD], '55').fields.map((f) => f.key), ['player_id', 'server_id']);
  });
  it('a giftcard product has no buyer fields at all', () => {
    assert.deepEqual(toRawOffers('giftcards', [PS_VOUCHER], '2').fields, []);
  });
});
