// Run with: npm run test:unit. The network is faked; the fixtures are trimmed copies of REAL responses from the live service
// (2026-09-21), so the tests break if the mapping stops matching what Shop2Topup actually sends.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';

import { regionDefaults } from '../../../src/lib/importPlan.ts';
import { normalizeOffers } from './catalog.ts';
import {
  CHECK_REPORTS_NO_REGION, S2Error, VALIDATED_GAMES, categoriesForCheck, createShop2TopupClient, familyOf, fieldsFromRequirementString, fieldsFromRequirements, isValidatedCategory,
  normalizeShop2TopupCategory, regionLabelOf, toRawCategories, toRawOffers, validateWithAnyPack, validationStatusFor, variantLabelOf,
} from './shop2topup.ts';

// ---- real shapes
const FF_MENA = { id: 4, name: 'Mena Direct Topup', description: null, big_category_id: 2, region_ids: [{ id: 30, name: 'MENA' }], country_ids: [], requirements: 'player_id' };
const FF_BR = { id: 487, name: 'Direct Topup Brazil', big_category_id: 2, region_ids: [], country_ids: [{ id: 102, code: 'BR', name: 'Brazil' }], requirements: 'player_id' };
const FF_CARDS = { id: 3, name: 'Garena Cards', big_category_id: 2, region_ids: [], country_ids: [], requirements: {} };
const ML_PLAIN = { id: 474, name: 'Direct Topup', region_ids: [], country_ids: [], requirements: 'player_id, zone_id' };
const ML_EXCL = { id: 476, name: 'Direct Topup Exclusive', region_ids: [], country_ids: [], requirements: 'player_id, zone_id' };
const ML_GLOBAL = { id: 472, name: 'Direct Topup Global', region_ids: [{ id: 1, name: 'Worldwide' }], country_ids: [], requirements: 'player_id, zone_id' };
const PUBG = { id: 2, name: 'Direct Topup', region_ids: [], country_ids: [], requirements: 'player_id' };
const BLOOD = { id: 445, name: 'Direct Topup Mena', region_ids: [{ id: 30, name: 'MENA' }], country_ids: [], requirements: 'player_id' };
const BLOOD_GLOBAL = { id: 491, name: 'Direct Topup', region_ids: [], country_ids: [], requirements: 'player_id' };
const GAMES = [
  { id: 2, name: 'Free Fire', categories: [FF_MENA, FF_BR, FF_CARDS] },
  { id: 264, name: 'Mobile Legends: Bang Bang', categories: [ML_PLAIN, ML_EXCL, ML_GLOBAL] },
  { id: 1, name: 'PUBG Mobile', categories: [PUBG] },
  { id: 241, name: 'Blood Strike', categories: [BLOOD, BLOOD_GLOBAL] },
];
const CTX = { blocklist: {}, listedAt: '2026-09-21T00:00:00Z' };

describe('what a category is', () => {
  it('a category that asks for something is a top-up; one that asks for nothing is a voucher', () => {
    assert.equal(familyOf(FF_MENA), 'topups');
    assert.equal(familyOf(ML_PLAIN), 'topups');
    assert.equal(familyOf(FF_CARDS), 'giftcards');
    assert.equal(familyOf({ id: 1, name: 'x' }), 'giftcards');
  });
  it('its region: a country code first, then a named region, else none', () => {
    assert.equal(regionLabelOf(FF_BR), 'BR');
    assert.equal(regionLabelOf(FF_MENA), 'MENA');
    assert.equal(regionLabelOf(ML_PLAIN), null);
  });
  it('a variant with no region is named by what is left of its name', () => {
    assert.equal(variantLabelOf(ML_EXCL), 'Exclusive');
    assert.equal(variantLabelOf(ML_PLAIN), null);
    assert.equal(variantLabelOf(FF_CARDS), 'Garena Cards');
  });
});

describe('the buyer form', () => {
  it('from the categories list ("player_id, zone_id")', () => {
    assert.deepEqual(fieldsFromRequirementString('player_id, zone_id').map((f) => [f.key, f.label, f.type]), [['player_id', 'Player ID', 'text'], ['zone_id', 'Zone ID', 'text']]);
    assert.deepEqual(fieldsFromRequirementString('player_id'), [{ key: 'player_id', label: 'Player ID', type: 'text' }]);
    assert.deepEqual(fieldsFromRequirementString({}), []);
    assert.deepEqual(fieldsFromRequirementString('player_id, ; DROP TABLE'), [{ key: 'player_id', label: 'Player ID', type: 'text' }]);
  });
  it('from the requirements endpoint, including a dropdown', () => {
    const fields = fieldsFromRequirements([
      { field_name: 'player_id', data_type: 'text', placeholder: 'Enter player ID' },
      { field_name: 'zone_id', data_type: 'single_select', select_options: ['Asia1', 'Europe', 7, ''] },
      { field_name: 'charname', data_type: 'text' },
      { field_name: 'Bad Key!', data_type: 'text' },
    ]);
    assert.deepEqual(fields.map((f) => f.key), ['player_id', 'zone_id', 'charname']);
    assert.equal(fields[1].type, 'select');
    assert.deepEqual(fields[1].options, [{ label: 'Asia1', value: 'Asia1' }, { label: 'Europe', value: 'Europe' }]);
    assert.equal(fields[2].label, 'Character name');
  });
});

describe('rows for the saved catalog', () => {
  const top = toRawCategories(GAMES, 'topups');
  const gift = toRawCategories(GAMES, 'giftcards');
  it('top-ups and vouchers are separated, and every category is named "Game (Region)" like FazerCards', () => {
    assert.deepEqual(top.map((c) => c.name), ['Free Fire (MENA)', 'Free Fire (BR)', 'Mobile Legends: Bang Bang', 'Mobile Legends: Bang Bang (Exclusive)', 'Mobile Legends: Bang Bang (Worldwide)', 'PUBG Mobile', 'Blood Strike (MENA)', 'Blood Strike']);
    assert.deepEqual(gift.map((c) => c.name), ['Free Fire (Garena Cards)']);
  });
  it('category ids are Shop2Topup\'s own numbers, as text', () => {
    assert.deepEqual(top.slice(0, 2).map((c) => c.category_id), ['4', '487']);
  });
  const row = (cat, family = 'topups') => normalizeShop2TopupCategory(family, [...toRawCategories(GAMES, family)].find((c) => c.category_id === String(cat.id)), CTX);

  it('is tagged with its supplier, so it can never be mistaken for a FazerCards row', () => {
    assert.equal(row(FF_MENA).supplier, 'shop2topup');
  });
  it('Free Fire MENA: game, region, the ID check, and a real region so packs lock', () => {
    const r = row(FF_MENA);
    assert.deepEqual([r.game_name, r.region_label, r.note_region, r.family], ['Free Fire', 'MENA', 'MENA', 'topups']);
    assert.equal(r.validation_category_id, '4');
    assert.deepEqual(r.validation_fields.map((f) => f.key), ['player_id']);
    assert.equal(r.blocked_reason, null);
  });
  it('the games proven to validate get the supplier ID check: Free Fire, PUBG Mobile, Mobile Legends, Blood Strike', () => {
    for (const c of [FF_MENA, FF_BR, ML_PLAIN, ML_GLOBAL, PUBG, BLOOD]) assert.notEqual(row(c).validation_category_id, null, c.name);
    assert.deepEqual(row(ML_PLAIN).validation_fields.map((f) => f.key), ['player_id', 'zone_id']);
  });
  it('anything else falls back to the customer\'s tick: vouchers, Mobile Legends Exclusive, games not proven', () => {
    assert.equal(row(FF_CARDS, 'giftcards').validation_category_id, null);
    assert.equal(row(ML_EXCL).validation_category_id, null);
    assert.equal(isValidatedCategory('Magic Chess: Go Go', 'Direct Topup'), false, 'answers "unavailable": not proven, so not offered');
    assert.equal(isValidatedCategory('Silver and Blood', 'Direct Topup'), false, 'a name that merely contains "Blood" is another game');
    assert.equal(isValidatedCategory('Blood Strike Mobile', 'Direct Topup'), false);
  });
  it('Blood Strike (proven live with a real ID: it returns the player name) gets the supplier ID check on Global AND MENA', () => {
    const r = row(BLOOD);
    assert.equal(isValidatedCategory('Blood Strike', 'Direct Topup'), true);
    assert.equal(isValidatedCategory('blood strike', 'Direct Topup Mena'), true);
    assert.equal(r.validation_category_id, String(BLOOD.id));
    assert.deepEqual(r.validation_fields.map((f) => f.key), ['player_id']);
    assert.equal(r.blocked_reason, null);
    const g = row(BLOOD_GLOBAL);
    assert.equal(g.validation_category_id, '491');
    assert.deepEqual([g.note_region, g.blocked_reason], [null, null]);
    assert.deepEqual([regionDefaults({ ...g, fields: g.validation_fields }).idMode, regionDefaults({ ...g, fields: g.validation_fields }).locked], ['supplier', false]);
  });
  it('its check reports NO account region, so the MENA label stays a label and never becomes an unsellable lock', () => {
    const r = row(BLOOD);
    assert.equal(r.region_label, 'MENA', 'customers still see the region chip');
    assert.equal(r.note_region, null, 'nothing to lock: the check cannot report a region');
    // Through the real import defaults: checked by the supplier, NOT locked, no codes to type.
    const d = regionDefaults({ ...r, fields: r.validation_fields });
    assert.deepEqual([d.idMode, d.locked, d.codes], ['supplier', false, []]);
  });
  it('a game whose check DOES report a region (Free Fire) is still locked to it', () => {
    const r = row(FF_MENA);
    assert.equal(r.note_region, 'MENA');
    const d = regionDefaults({ ...r, fields: r.validation_fields });
    assert.deepEqual([d.idMode, d.locked, d.codes], ['supplier', true, ['ME']]);
  });
  it('the list of games whose check reports no region is exactly PUBG Mobile and Blood Strike', () => {
    assert.deepEqual([...CHECK_REPORTS_NO_REGION], ['PUBG Mobile', 'Blood Strike']);
    for (const g of CHECK_REPORTS_NO_REGION) assert.ok(VALIDATED_GAMES.includes(g), `${g} must be a validated game`);
  });
  it('a variant name is a label but NOT a region (so it never locks packs)', () => {
    const r = row(ML_EXCL);
    assert.equal(r.region_label, 'Exclusive');
    assert.equal(r.note_region, null);
  });
  it('a category that asks for a password is blocked, and unusable rows become null', () => {
    const raw = { ...toRawCategories(GAMES, 'topups')[0], requirements: 'player_id, password' };
    assert.match(normalizeShop2TopupCategory('topups', raw, CTX).blocked_reason, /password/);
    for (const bad of [{}, { category_id: '', name: 'x', game: 'g' }, { category_id: '1', name: ' ', game: 'g' }, { category_id: '1', name: 'x' }]) assert.equal(normalizeShop2TopupCategory('topups', bad, CTX), null);
  });
});

describe('packs go through the SAME normalizer as FazerCards', () => {
  const subs = [
    { id: 28, name: '100 + 10 Diamonds', price: 0.94564, product_type: 'topup' },
    { id: 29, name: 'Booyah Pass', price: 3.10078 },
    { id: 30, name: 'First Purchase Bonus 50', price: 0.5 },
    { id: 31, name: 'Broken', price: 'free' },
  ];
  const fields = fieldsFromRequirements([{ field_name: 'player_id', data_type: 'text' }]);
  it('keeps the supplier\'s pack id and name, and the USD cost', () => {
    const out = normalizeOffers('topups', toRawOffers('topups', subs, fields));
    assert.deepEqual(out.offers, [{ ref: '28', name: '100 + 10 Diamonds', cost_usd: '0.94564' }, { ref: '29', name: 'Booyah Pass', cost_usd: '3.10078' }]);
  });
  it('first-purchase offers and unpriced packs are hidden and counted, exactly as for FazerCards', () => {
    assert.equal(normalizeOffers('topups', toRawOffers('topups', subs, fields)).hidden_offer_count, 2);
  });
  it('vouchers use the gift-card path', () => {
    const out = normalizeOffers('giftcards', toRawOffers('giftcards', [{ id: 9, name: 'Garena 100', price: 1.2 }], []));
    assert.deepEqual(out.offers, [{ ref: '9', name: 'Garena 100', cost_usd: '1.2' }]);
  });
});

// ---- the client, with a fake network
const reply = (http, body) => ({ status: http, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
function fake(routes) {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    const path = url.replace('https://shop2topup.com/api/endpoints/v1', '');
    for (const [pattern, answer] of routes) if (path.startsWith(pattern)) return typeof answer === 'function' ? answer(init) : answer;
    return reply(404, { success: false, error: { code: 'NOPE' } });
  };
  return { calls, client: createShop2TopupClient({ key: 'keyid.secret', fetchFn }) };
}

describe('the HTTP client', () => {
  it('sends the key as a Bearer token and reads /account', async () => {
    const { client, calls } = fake([['/account', reply(200, { success: true, account: { email: 'a@b.c', wallet: '0.000000' } })]]);
    assert.deepEqual(await client.account(), { email: 'a@b.c', wallet: '0.000000' });
    assert.equal(calls[0].headers.Authorization, 'Bearer keyid.secret');
  });
  it('a wrong key is a 401 the callers understand as "refused"', async () => {
    const { client } = fake([['/account', reply(401, { success: false, error: { code: 'INVALID_API_KEY' } })]]);
    await assert.rejects(client.account(), (e) => e instanceof S2Error && e.status === 401 && e.code === 'INVALID_API_KEY');
  });
  it('an IP that is not allowed is a 403 (also "refused")', async () => {
    const { client } = fake([['/catalog/big-categories', reply(403, { success: false, error: { code: 'IP_NOT_ALLOWED' } })]]);
    await assert.rejects(client.bigCategories(), (e) => e.status === 403 && e.code === 'IP_NOT_ALLOWED');
  });
  it('the catalog calls carry the ids in the query string', async () => {
    const { client, calls } = fake([['/catalog/categories', reply(200, { success: true, data: [FF_MENA] })], ['/catalog/subcategories', reply(200, { success: true, data: [{ id: 1, name: 'x', price: 1 }] })]]);
    assert.equal((await client.categories(2)).length, 1);
    assert.equal((await client.subcategories(4)).length, 1);
    assert.deepEqual(calls.map((c) => c.url.split('/v1')[1]), ['/catalog/categories?bigCategoryId=2', '/catalog/subcategories?categoryId=4']);
  });
  it('a voucher category has no requirements: that is an empty form, not an error', async () => {
    const { client } = fake([['/catalog/category/3/requirements', reply(404, { success: false, error: { code: 'NO_REQUIREMENTS_FOUND' } })]]);
    assert.deepEqual(await client.requirements(3), []);
  });
  it('any other requirements failure IS an error', async () => {
    const { client } = fake([['/catalog/category/3/requirements', reply(500, { success: false, error: { code: 'X' } })]]);
    await assert.rejects(client.requirements(3), (e) => e.status === 500);
  });
  it('never touches /orders: no method requests it, and the request function refuses it', async () => {
    const src = fs.readFileSync(new URL('./shop2topup.ts', import.meta.url), 'utf8');
    assert.ok(!/request\('(GET|POST)', [`'"]\/orders/.test(src), 'no client method may call /orders');
    assert.match(src, /\^\\\/orders/, 'and the guard is in place');
    // a path with an odd id is encoded into the query, never turned into a different endpoint
    const { client, calls } = fake([['/catalog/subcategories', reply(200, { success: true, data: [] })]]);
    await client.subcategories('1&x=/orders/create');
    assert.ok(calls[0].url.includes('/catalog/subcategories?categoryId=1%26x%3D%2Forders%2Fcreate'));
  });
  it('a missing key refuses before any request', async () => {
    let n = 0;
    const client = createShop2TopupClient({ key: '', fetchFn: async () => { n++; return reply(200, {}); } });
    await assert.rejects(client.account(), (e) => e.status === 503);
    assert.equal(n, 0);
  });
  it('a hung request is aborted', async () => {
    const client = createShop2TopupClient({ key: 'k', timeoutMs: 20, fetchFn: (u, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted')))) });
    await assert.rejects(client.account(), /aborted/);
  });
  it('the key never appears in an error', async () => {
    const { client } = fake([['/account', reply(500, 'oops keyid.secret')]]);
    await assert.rejects(client.account(), (e) => !String(e.message).includes('keyid.secret') && !JSON.stringify(e).includes('keyid.secret'));
  });
});

describe('ID validation', () => {
  const ok = reply(200, { success: true, data: { player_id: '1', player_name: 'Ali', region: 'ME' } });
  it('sends the pack, the player and (only if given) the zone, as zone_id', async () => {
    const { client, calls } = fake([['/player/validate', ok]]);
    await client.validate({ subCategoryId: 28, playerId: '111' });
    await client.validate({ subCategoryId: 242, playerId: '111', zoneId: '2222' });
    assert.deepEqual(JSON.parse(calls[0].body), { sub_category_id: 28, player_id: '111' });
    assert.deepEqual(JSON.parse(calls[1].body), { sub_category_id: 242, player_id: '111', zone_id: '2222' });
  });
  it('returns the name and the account REGION (same vocabulary as FazerCards: ME, BR, ID), or null when it reports none', async () => {
    assert.deepEqual(await fake([['/player/validate', ok]]).client.validate({ subCategoryId: 1, playerId: '1' }), { valid: true, player_name: 'Ali', region: 'ME' });
    const pubg = reply(200, { success: true, data: { player_id: '5', player_name: 'Bek' } });
    assert.deepEqual(await fake([['/player/validate', pubg]]).client.validate({ subCategoryId: 1, playerId: '5' }), { valid: true, player_name: 'Bek', region: null });
  });
  it('ONLY "player not found" means the ID is wrong (status 400)', async () => {
    const nf = reply(400, { success: false, error: { code: 'PLAYER_NOT_FOUND' } });
    await assert.rejects(fake([['/player/validate', nf]]).client.validate({ subCategoryId: 1, playerId: '1' }), (e) => e.status === 400 && e.code === 'PLAYER_NOT_FOUND');
  });
  it('everything else is "could not check" (503), even when Shop2Topup itself answers 400', async () => {
    const cases = [
      [400, 'MISSING_REQUIRED_FIELD'], [400, 'INVALID_UUID_FORMAT'], [409, 'PRODUCT_UNAVAILABLE'], [503, 'PLAYER_CHECK_UNAVAILABLE'],
      [429, 'RATE_LIMIT_EXCEEDED'], [500, null], [400, 'SOMETHING_NEW'],
    ];
    for (const [http, code] of cases) {
      const answer = reply(http, { success: false, error: { code } });
      await assert.rejects(fake([['/player/validate', answer]]).client.validate({ subCategoryId: 1, playerId: '1' }), (e) => e.status === 503, `${http} ${code}`);
    }
    assert.equal(validationStatusFor(401, 'INVALID_API_KEY'), 401);
    assert.equal(validationStatusFor(200, null), 503);
  });
  it('REGION_MISMATCH means the account WAS found: it comes back with its region so OUR region lock decides', async () => {
    const mismatch = reply(400, { success: false, error: { code: 'REGION_MISMATCH', player_region: 'US', player_name: 'Ali', action: 'CHOOSE_OTHER', retryable: false } });
    assert.deepEqual(await fake([['/player/validate', mismatch]]).client.validate({ subCategoryId: 4, playerId: '1' }), { valid: true, player_name: 'Ali', region: 'US' });
    const noName = reply(400, { success: false, error: { code: 'REGION_MISMATCH', player_region: 'US' } });
    assert.deepEqual(await fake([['/player/validate', noName]]).client.validate({ subCategoryId: 4, playerId: '1' }), { valid: true, player_name: null, region: 'US' });
  });
  it('REGION_MISMATCH without a region in the reply, or with another status, is still "could not check": nothing is invented', async () => {
    for (const [http, error] of [[400, { code: 'REGION_MISMATCH' }], [400, { code: 'REGION_MISMATCH', player_region: '  ' }], [400, { code: 'REGION_MISMATCH', player_region: 7 }], [503, { code: 'REGION_MISMATCH', player_region: 'US' }]]) {
      await assert.rejects(fake([['/player/validate', reply(http, { success: false, error })]]).client.validate({ subCategoryId: 4, playerId: '1' }), (e) => e.status === 503, JSON.stringify(error));
    }
  });
  it('a 200 that is not a clear success is not a valid ID', async () => {
    for (const body of [{ success: false }, { success: true }, { success: true, data: null }, 'not json']) {
      await assert.rejects(fake([['/player/validate', reply(200, body)]]).client.validate({ subCategoryId: 1, playerId: '1' }), (e) => e.status === 503);
    }
  });
});

describe('finding a pack that can be checked against', () => {
  const unavailable = new S2Error('x', 503, 'PRODUCT_UNAVAILABLE');
  const good = { valid: true, player_name: 'A', region: null };
  it('a pack that is temporarily unavailable moves on to the next one (PUBG\'s first pack was)', async () => {
    const tried = [];
    const client = { validate: async ({ subCategoryId }) => { tried.push(subCategoryId); if (subCategoryId === 12) throw unavailable; return good; } };
    assert.deepEqual(await validateWithAnyPack(client, [12, 3423], { playerId: '1' }), good);
    assert.deepEqual(tried, [12, 3423]);
  });
  it('a wrong ID or a refused key stops at once (no point asking again, and every ask uses the daily quota)', async () => {
    for (const code of ['PLAYER_NOT_FOUND', 'INVALID_API_KEY', 'PLAYER_CHECK_UNAVAILABLE', 'MISSING_REQUIRED_FIELD']) {
      let n = 0;
      const client = { validate: async () => { n++; throw new S2Error('x', 400, code); } };
      await assert.rejects(validateWithAnyPack(client, [1, 2, 3], { playerId: '1' }));
      assert.equal(n, 1, code);
    }
  });
  it('gives up after three unavailable packs', async () => {
    let n = 0;
    const client = { validate: async () => { n++; throw unavailable; } };
    await assert.rejects(validateWithAnyPack(client, [1, 2, 3, 4, 5], { playerId: '1' }));
    assert.equal(n, 3);
  });
  it('no packs at all is "could not check"', async () => {
    await assert.rejects(validateWithAnyPack({ validate: async () => good }, [], { playerId: '1' }), (e) => e.status === 503);
  });
});

describe('which categories an ID check may borrow packs from', () => {
  const rows = [
    { category_id: '445', game_name: 'Blood Strike' }, { category_id: '491', game_name: 'Blood Strike' },
    { category_id: '4', game_name: 'Free Fire' }, { category_id: '484', game_name: 'Free Fire' },
    { category_id: '2', game_name: 'PUBG Mobile' }, { category_id: '1', game_name: 'PUBG Mobile UC' },
  ];
  it('a game whose check does not depend on the region: its own category first, then the others of the same game', () => {
    assert.deepEqual(categoriesForCheck(rows, '445'), ['445', '491']);
    assert.deepEqual(categoriesForCheck(rows, '491'), ['491', '445']);
  });
  it('a game whose check DOES report a region keeps to its own category: a Free Fire check must stay in its region', () => {
    assert.deepEqual(categoriesForCheck(rows, '4'), ['4']);
    assert.deepEqual(categoriesForCheck(rows, '484'), ['484']);
  });
  it('a game with no sibling, or a category not in the saved catalog, is just itself', () => {
    assert.deepEqual(categoriesForCheck(rows, '2'), ['2']);
    assert.deepEqual(categoriesForCheck(rows, '999'), ['999']);
    assert.deepEqual(categoriesForCheck([], '445'), ['445']);
  });
  it('the game name match ignores case, and another game with a similar name is not a sibling', () => {
    assert.deepEqual(categoriesForCheck([{ category_id: '1', game_name: 'BLOOD STRIKE' }, { category_id: '2', game_name: 'blood strike' }, { category_id: '3', game_name: 'Silver and Blood' }], '1'), ['1', '2']);
  });
  it('with an out-of-stock own category, the check still succeeds on a pack of the other category (the Blood Strike MENA case)', async () => {
    const { client } = fake([['/player/validate', (init) => {
      const pack = JSON.parse(init.body).sub_category_id;
      return pack === 183 || pack === 184 ? reply(409, { success: false, error: { code: 'PRODUCT_UNAVAILABLE' } }) : reply(200, { success: true, data: { player_id: '1', player_name: 'Ali' } });
    }]]);
    assert.deepEqual(await validateWithAnyPack(client, [183, 184, 1638, 1639], { playerId: '1' }, 4), { valid: true, player_name: 'Ali', region: null });
  });
});
