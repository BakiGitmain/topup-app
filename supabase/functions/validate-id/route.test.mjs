// Run with: npm run test:unit. Proves each product's ID check goes to the supplier its pack data is TAGGED with, and only
// that supplier: the real handler, the real routing function and the real Shop2Topup client, with a fake network.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';

import { createShop2TopupClient, validateWithAnyPack } from '../_shared/shop2topup.ts';
import { createHandler } from './handler.ts';
import { DEFAULT_SUPPLIER, routeValidation } from './route.ts';

const REGION = '11111111-2222-3333-4444-555555555555';
const FAR = new Date(Date.now() + 15 * 60 * 1000).toISOString();
const reply = (http, body) => ({ status: http, text: async () => JSON.stringify(body) });

function world({ target, s2 = () => reply(200, { success: true, data: { player_id: '1', player_name: 'Shop Player', region: 'ME' } }) }) {
  const seen = { fazer: [], s2: [], recorded: [] };
  const client = createShop2TopupClient({ key: 'k', fetchFn: async (url, init) => { seen.s2.push({ url: url.split('/v1')[1], body: JSON.parse(init.body ?? 'null') }); return s2(url, init); } });
  const validators = {
    fazercards: async (categoryId, fields) => { seen.fazer.push({ categoryId, fields }); return { valid: true, player_name: 'Fazer Player', region: 'ME' }; },
    shop2topup: async (categoryId, fields) => validateWithAnyPack(client, [28, 29], { playerId: fields.player_id, zoneId: fields.zone_id }),
  };
  const handle = createHandler({
    timeoutMs: 500,
    getUserId: async (t) => (t === 'tok' ? 'user-1' : null),
    claimSlot: async () => true,
    getTarget: async () => target,
    supplierValidate: routeValidation(validators),
    record: async (user, region, fields, acct, name) => { seen.recorded.push({ fields, acct, name }); return { validation_id: 'v1', valid_until: FAR }; },
    log: () => {},
  });
  const call = async (fields) => {
    const res = await handle(new Request('https://x.test', { method: 'POST', headers: { authorization: 'Bearer tok', 'content-type': 'application/json' }, body: JSON.stringify({ region_id: REGION, fields }) }));
    return { status: res.status, body: await res.json() };
  };
  return { seen, call };
}
const FF = { id_validation: 'supplier', buyer_fields: [{ key: 'player_id', label: 'Player ID', type: 'text' }], validation_category_id: 'free_fire', validation_field_map: {} };
const ML = { id_validation: 'supplier', buyer_fields: [{ key: 'player_id', label: 'User ID', type: 'text' }, { key: 'zone_id', label: 'Zone ID', type: 'text' }], validation_category_id: '474', validation_field_map: {}, supplier: 'shop2topup' };

describe('the check goes to the supplier the region is tagged with', () => {
  it('a FazerCards-tagged region is checked with FazerCards, and Shop2Topup is never called', async () => {
    const { call, seen } = world({ target: { ...FF, supplier: 'fazercards' } });
    const { body } = await call({ player_id: '3327205705' });
    assert.equal(body.status, 'valid');
    assert.equal(body.player_name, 'Fazer Player');
    assert.deepEqual(seen.fazer, [{ categoryId: 'free_fire', fields: { player_id: '3327205705' } }]);
    assert.equal(seen.s2.length, 0);
  });
  it('a Shop2Topup-tagged region is checked with Shop2Topup, and FazerCards is never called', async () => {
    const { call, seen } = world({ target: { ...FF, validation_category_id: '4', supplier: 'shop2topup' } });
    const { body } = await call({ player_id: '3327205705' });
    assert.equal(body.status, 'valid');
    assert.equal(body.player_name, 'Shop Player');
    assert.equal(body.account_region, 'ME', 'the account region comes back in the same vocabulary, so region locking works unchanged');
    assert.equal(seen.fazer.length, 0);
    assert.deepEqual(seen.s2, [{ url: '/player/validate', body: { sub_category_id: 28, player_id: '3327205705' } }]);
  });
  it('a region with NO tag (a row from before suppliers were named) is FazerCards: nothing about live products changes', async () => {
    for (const target of [FF, { ...FF, supplier: null }, { ...FF, supplier: '' }]) {
      const { call, seen } = world({ target });
      assert.equal((await call({ player_id: '1' })).body.status, 'valid');
      assert.equal(seen.fazer.length, 1);
      assert.equal(seen.s2.length, 0);
    }
    assert.equal(DEFAULT_SUPPLIER, 'fazercards');
  });
  it('a supplier we do not know is "could not check": it never falls back to another supplier', async () => {
    for (const supplier of ['mpesa', 'FAZERCARDS', 'constructor', '__proto__', 'toString']) {
      const { call, seen } = world({ target: { ...FF, supplier } });
      const { body } = await call({ player_id: '1' });
      assert.equal(body.status, 'unavailable', supplier);
      assert.equal(seen.fazer.length + seen.s2.length, 0, supplier);
    }
  });
  it('with the REAL production wiring (FazerCards not registered), a fazercards-tagged region is "could not check", not a crash and never a wrong-supplier guess', async () => {
    const seen = { s2: [], recorded: [] };
    const client = createShop2TopupClient({ key: 'k', fetchFn: async () => reply(200, { success: true, data: { player_id: '1', player_name: 'x' } }) });
    const handle = createHandler({
      timeoutMs: 500,
      getUserId: async () => 'user-1',
      claimSlot: async () => true,
      getTarget: async () => ({ ...FF, supplier: 'fazercards' }),
      supplierValidate: routeValidation({ shop2topup: async (categoryId, fields) => validateWithAnyPack(client, [28], { playerId: fields.player_id }) }),
      record: async (user, region, fields, acct, name) => { seen.recorded.push({ fields, acct, name }); return { validation_id: 'v1', valid_until: FAR }; },
      log: () => {},
    });
    const res = await handle(new Request('https://x.test', { method: 'POST', headers: { authorization: 'Bearer tok', 'content-type': 'application/json' }, body: JSON.stringify({ region_id: REGION, fields: { player_id: '1' } }) }));
    assert.deepEqual(await res.json(), { status: 'unavailable' });
    assert.equal(seen.recorded.length, 0);
  });
});

describe('Shop2Topup validation through the handler', () => {
  it('a two-field game sends the player and the zone as zone_id', async () => {
    const { call, seen } = world({ target: ML });
    await call({ player_id: '1234567', zone_id: '1234' });
    assert.deepEqual(seen.s2[0].body, { sub_category_id: 28, player_id: '1234567', zone_id: '1234' });
  });
  it('an ID Shop2Topup says does not exist is INVALID (the customer is told to fix it)', async () => {
    const { call, seen } = world({ target: ML, s2: () => reply(400, { success: false, error: { code: 'PLAYER_NOT_FOUND' } }) });
    assert.deepEqual((await call({ player_id: '1', zone_id: '1' })).body, { status: 'invalid' });
    assert.equal(seen.recorded.length, 0);
  });
  it('a missing field, a busy game, a refused key: "could not check", NEVER "invalid" and never recorded', async () => {
    for (const [http, code] of [[400, 'MISSING_REQUIRED_FIELD'], [503, 'PLAYER_CHECK_UNAVAILABLE'], [401, 'INVALID_API_KEY'], [403, 'IP_NOT_ALLOWED'], [429, 'RATE_LIMIT_EXCEEDED'], [500, null]]) {
      const { call, seen } = world({ target: ML, s2: () => reply(http, { success: false, error: { code } }) });
      assert.deepEqual((await call({ player_id: '1', zone_id: '1' })).body, { status: 'unavailable' }, `${http} ${code}`);
      assert.equal(seen.recorded.length, 0);
    }
  });
  it('a pack that is temporarily unavailable is skipped: the second pack is tried, once', async () => {
    let n = 0;
    const { call, seen } = world({ target: ML, s2: () => (++n === 1 ? reply(409, { success: false, error: { code: 'PRODUCT_UNAVAILABLE' } }) : reply(200, { success: true, data: { player_id: '1', player_name: 'P' } })) });
    const { body } = await call({ player_id: '1', zone_id: '1' });
    assert.equal(body.status, 'valid');
    assert.deepEqual(seen.s2.map((c) => c.body.sub_category_id), [28, 29]);
    assert.equal(body.account_region, null, 'PUBG-style: no region reported, recorded as none (never guessed)');
  });
});

describe('Blood Strike on Shop2Topup (the real reply: a name and NO account region)', () => {
  const BS = { id_validation: 'supplier', buyer_fields: [{ key: 'player_id', label: 'Player ID', type: 'text' }], validation_category_id: '491', validation_field_map: {}, supplier: 'shop2topup' };
  const live = () => reply(200, { success: true, data: { player_id: '568840231399', player_name: 'BAKI神' } });
  it('is valid, the name shown exactly as given (never sanitized), and the region recorded as none', async () => {
    const { call, seen } = world({ target: BS, s2: live });
    const { body } = await call({ player_id: '568840231399' });
    assert.equal(body.status, 'valid');
    assert.equal(body.player_name, 'BAKI神');
    assert.equal(body.account_region, null);
    assert.deepEqual(seen.recorded, [{ fields: { player_id: '568840231399' }, acct: null, name: 'BAKI神' }]);
    assert.deepEqual(seen.s2.map((c) => c.body), [{ sub_category_id: 28, player_id: '568840231399' }]);
    assert.equal(seen.fazer.length, 0, 'FazerCards is never asked');
  });
  it('an unknown ID is invalid, and "could not check" stays "could not check"', async () => {
    const nf = world({ target: BS, s2: () => reply(400, { success: false, error: { code: 'PLAYER_NOT_FOUND' } }) });
    assert.deepEqual((await nf.call({ player_id: '1' })).body, { status: 'invalid' });
    const down = world({ target: BS, s2: () => reply(503, { success: false, error: { code: 'PLAYER_CHECK_UNAVAILABLE', retryable: true } }) });
    assert.deepEqual((await down.call({ player_id: '1' })).body, { status: 'unavailable' });
    assert.equal(down.seen.recorded.length, 0);
  });
});

describe('routeValidation on its own', () => {
  it('calls exactly one validator with the category and fields it was given', async () => {
    const seen = [];
    const v = routeValidation({ a: async (c, f) => { seen.push(['a', c, f]); return 'A'; }, b: async (c, f) => { seen.push(['b', c, f]); return 'B'; } });
    assert.equal(await v('cat', { x: '1' }, 'b'), 'B');
    assert.deepEqual(seen, [['b', 'cat', { x: '1' }]]);
  });
  it('an unknown name throws a 503 error', async () => {
    await assert.rejects(routeValidation({ a: async () => 1 })('c', {}, 'z'), (e) => e.status === 503);
  });
});

describe('the deployed wiring (source checks)', () => {
  const index = fs.readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
  it('every supplier check goes through routeValidation, and both live suppliers\' keys are read', () => {
    assert.match(index, /supplierValidate: routeValidation\(\{/);
    assert.match(index, /SHOP2TOPUP_API_KEY/);
    assert.match(index, /GAMESDROP_API_KEY/);
  });
  it('FazerCards is no longer called: no client, no key read (mentioning why in a comment is fine)', () => {
    assert.ok(!/new FazerCardsClient|npm:fazercards|Deno\.env\.get\('FAZER_API_KEY'\)/.test(index));
    // and it is not a registered validator, so a region tagged fazercards gets "could not check", never a silent guess
    assert.ok(!/fazercards: async/.test(index));
  });
  it('Shop2Topup packs come from the SHOP2TOPUP rows of the saved catalog only', () => {
    assert.match(index, /\.eq\('supplier', 'shop2topup'\)/);
  });
  it('GamesDrop is registered as a validator', () => {
    assert.match(index, /gamesdrop: validateWithGamesDrop/);
  });
});
