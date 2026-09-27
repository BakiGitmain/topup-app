// Run with: npm run test:unit. Every outside dependency is faked: no network, no database, no supplier.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createShop2TopupClient, fieldsFromRequirements, normalizeShop2TopupCategory, toRawCategories, toRawOffers } from '../_shared/shop2topup.ts';
import { createHandler, failReason } from './handler.ts';

const NOW = new Date('2026-09-21T10:00:00.000Z');
const FF_GAMES = [
  { category_id: 'free_fire', name: 'Free Fire', fields: [{ key: 'player_id', label: 'Player ID', type: 'text' }] },
  { category_id: 'mobile_legends', name: 'Mobile Legends', fields: [{ key: 'player_id', label: 'User ID', type: 'text' }, { key: 'zone_id', label: 'Zone ID', type: 'text' }] },
];
const TOPUP_CATS = [
  { category_id: 'free_fire_mena', name: 'Free Fire (MENA)', note: 'Region: MENA\nAutomatic Free Fire top-up.' },
  { category_id: 'free_fire_bd', name: 'Free Fire (BD)', note: 'Region: Bangladesh\nAutomatic.' },
  { category_id: 'genshin_impact_login', name: 'Genshin Impact (Login)', note: 'Enter your email and password' },
  { category_id: 'mobile_legends_adventure', name: 'Mobile Legends: Adventure', note: 'Region: Global' },
];
const GIFT_CATS = [{ category_id: 'amazon_us', name: 'Amazon (US)', note: 'Region: US' }];
const BLOCKLIST = { 'topups/genshin_impact_login': 'asks for the buyer\'s game password' };

function setup(overrides = {}) {
  const calls = { upsert: [], deleted: [], saved: [], logs: [], offersFetched: [], counted: 0 };
  const deps = {
    refreshTimeoutMs: 200,
    offersTimeoutMs: 200,
    getUserId: async (t) => (t === 'admin-token' ? 'admin-1' : t === 'user-token' ? 'user-1' : null),
    isAdmin: async (id) => id === 'admin-1',
    loadBlocklist: async () => BLOCKLIST,
    listCategories: async (family) => (family === 'topups' ? TOPUP_CATS : GIFT_CATS),
    listValidationGames: async () => FF_GAMES,
    fetchOffers: async (family, id) => {
      calls.offersFetched.push([family, id]);
      return {
        offers: [
          { offer_id: '110_diamonds', name: '110 Diamonds', price_usd: '0.9456' },
          { offer_id: '250_first', name: '250 (FIRST PURCHASE ONLY)', price_usd: '1.0000' },
          { offer_id: '231_diamonds', name: '231 Diamonds', price_usd: '1.8913' },
        ],
        fields: [{ key: 'player_id', label: 'Player ID', type: 'text' }],
      };
    },
    countCatalog: async () => { calls.counted++; return 0; },
    upsertCategories: async (rows) => { calls.upsert.push(...rows); },
    deleteStale: async (before) => { calls.deleted.push(before); return 2; },
    getCached: async () => ({ offers: null, fields: null, hidden_offer_count: 0, offers_fetched_at: null, blocked_reason: null }),
    saveOffers: async (family, id, result, at) => { calls.saved.push({ family, id, result, at }); return true; },
    now: () => NOW,
    log: (e) => calls.logs.push(e),
    ...overrides,
  };
  const handle = createHandler(deps);
  const call = (body, { token = 'admin-token', method = 'POST', raw } = {}) =>
    handle(new Request('https://x.test/supplier-catalog', {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: method === 'POST' ? (raw ?? JSON.stringify(body)) : undefined,
    }));
  return { call, calls };
}
const read = async (res) => ({ status: res.status, body: await res.json() });

describe('who may call it', () => {
  it('needs a signed-in user', async () => {
    const { call, calls } = setup();
    assert.equal((await call({ action: 'refresh_catalog' }, { token: null })).status, 401);
    assert.equal((await call({ action: 'refresh_catalog' }, { token: 'nonsense' })).status, 401);
    assert.equal(calls.upsert.length, 0);
  });
  it('refuses a customer, and never touches the supplier or the saved catalog', async () => {
    const { call, calls } = setup();
    assert.equal((await call({ action: 'refresh_catalog' }, { token: 'user-token' })).status, 403);
    assert.equal((await call({ action: 'load_offers', family: 'topups', category_id: 'free_fire_mena' }, { token: 'user-token' })).status, 403);
    assert.equal(calls.upsert.length + calls.offersFetched.length + calls.counted, 0);
  });
  it('only accepts POST, valid JSON and a known action', async () => {
    const { call } = setup();
    assert.equal((await call(null, { method: 'GET' })).status, 405);
    assert.equal((await call(null, { raw: '{oops' })).status, 400);
    assert.equal((await call({ action: 'order_something' })).status, 400);
    assert.equal((await call({})).status, 400);
  });
  it('answers the CORS preflight', async () => {
    const { call } = setup();
    assert.equal((await call(null, { method: 'OPTIONS' })).status, 204);
  });
});

describe('refresh_catalog', () => {
  it('saves every category with its game, region and ID check, and drops what the supplier no longer lists', async () => {
    const { call, calls } = setup();
    const { status, body } = await read(await call({ action: 'refresh_catalog' }));
    assert.equal(status, 200);
    assert.deepEqual(body, { status: 'ok', categories: 5, topups: 4, giftcards: 1, removed: 2, refreshed_at: NOW.toISOString() });
    assert.equal(calls.upsert.length, 5);
    assert.deepEqual(calls.deleted, [NOW.toISOString()]);
    const mena = calls.upsert.find((r) => r.category_id === 'free_fire_mena');
    assert.equal(mena.game_name, 'Free Fire');
    assert.equal(mena.region_label, 'MENA');
    assert.equal(mena.note_region, 'MENA');
    assert.equal(mena.validation_category_id, 'free_fire');
    assert.equal(mena.blocked_reason, null);
    assert.equal(mena.listed_at, NOW.toISOString());
  });
  it('marks password categories blocked and never gives an unlike game the wrong ID check', async () => {
    const { call, calls } = setup();
    await call({ action: 'refresh_catalog' });
    assert.match(calls.upsert.find((r) => r.category_id === 'genshin_impact_login').blocked_reason, /password/);
    assert.equal(calls.upsert.find((r) => r.category_id === 'mobile_legends_adventure').validation_category_id, null);
    assert.equal(calls.upsert.find((r) => r.category_id === 'amazon_us').validation_category_id, null);
  });
  it('never writes packs, costs or buyer forms (those are fetched per category)', async () => {
    const { call, calls } = setup();
    await call({ action: 'refresh_catalog' });
    for (const row of calls.upsert) {
      assert.equal('offers' in row, false);
      assert.equal('fields' in row, false);
      assert.equal('offers_fetched_at' in row, false);
    }
  });
  it('a supplier that refuses the key (a finished trial) changes nothing and says so', async () => {
    const { call, calls } = setup({ listCategories: async () => { throw Object.assign(new Error('nope'), { status: 401 }); } });
    const { body } = await read(await call({ action: 'refresh_catalog' }));
    assert.deepEqual(body, { status: 'unavailable', reason: 'refused' });
    assert.equal(calls.upsert.length + calls.deleted.length, 0);
  });
  it('a slow supplier times out and changes nothing', async () => {
    const { call, calls } = setup({ listCategories: () => new Promise(() => {}) });
    const { body } = await read(await call({ action: 'refresh_catalog' }));
    assert.deepEqual(body, { status: 'unavailable', reason: 'timeout' });
    assert.equal(calls.upsert.length + calls.deleted.length, 0);
  });
  it('failing to get the ID-check games also changes nothing (rows would lose their checks)', async () => {
    const { call, calls } = setup({ listValidationGames: async () => { throw new Error('boom'); } });
    assert.equal((await read(await call({ action: 'refresh_catalog' }))).body.status, 'unavailable');
    assert.equal(calls.upsert.length, 0);
  });
  it('refuses to shrink the saved catalog to a sliver', async () => {
    const { call, calls } = setup({ countCatalog: async () => 885 });
    const { body } = await read(await call({ action: 'refresh_catalog' }));
    assert.deepEqual(body, { status: 'suspicious', found: 5, saved: 885 });
    assert.equal(calls.upsert.length + calls.deleted.length, 0);
  });
  it('refuses an empty list even on a fresh database', async () => {
    const { call, calls } = setup({ listCategories: async () => [] });
    assert.equal((await read(await call({ action: 'refresh_catalog' }))).body.status, 'suspicious');
    assert.equal(calls.upsert.length, 0);
  });
  it('skips malformed and repeated categories', async () => {
    const { call, calls } = setup({ listCategories: async (f) => (f === 'topups' ? [...TOPUP_CATS, TOPUP_CATS[0], { category_id: 5 }, { name: 'x' }, null].filter((x) => x !== null) : []) });
    const { body } = await read(await call({ action: 'refresh_catalog' }));
    assert.equal(body.categories, 4);
    assert.equal(calls.upsert.length, 4);
  });
});

describe('search_catalog', () => {
  const searchDeps = (rows = TOPUP_CATS, overrides = {}) => ({ searchLive: async (family) => (family === 'topups' ? rows : []), ...overrides });

  it('is refused (400) for a supplier with no searchLive, so Shop2Topup is untouched by this action', async () => {
    const { call, calls } = setup();
    assert.equal((await call({ action: 'search_catalog', query: 'free fire' })).status, 400);
    assert.equal(calls.upsert.length, 0);
  });
  it('rejects a query under 2 letters or over 60, without calling the supplier', async () => {
    const seen = [];
    const { call } = setup({ searchLive: async (f, q) => { seen.push(q); return []; } });
    for (const query of [undefined, '', 'a', 'x'.repeat(61)]) {
      assert.equal((await call({ action: 'search_catalog', query })).status, 400);
    }
    assert.equal(seen.length, 0);
  });
  it('saves just what the query matched, tagged and normalized the same way as a refresh, and never deletes anything', async () => {
    const { call, calls } = setup(searchDeps());
    const { status, body } = await read(await call({ action: 'search_catalog', query: 'free fire' }));
    assert.equal(status, 200);
    assert.deepEqual(body, { status: 'ok', categories: 4, topups: 4, giftcards: 0 });
    assert.equal(calls.upsert.length, 4);
    assert.equal(calls.deleted.length, 0, 'a scoped search must never delete categories outside its own query');
    assert.equal(calls.counted, 0, 'no "did the catalog shrink" check either: there is no whole catalog to compare against');
  });
  it('zero matches is a normal, successful outcome (not "suspicious" the way an empty refresh is)', async () => {
    const { call, calls } = setup(searchDeps([]));
    const { body } = await read(await call({ action: 'search_catalog', query: 'zzzznonexistent' }));
    assert.deepEqual(body, { status: 'ok', categories: 0, topups: 0, giftcards: 0 });
    assert.equal(calls.upsert.length, 0);
  });
  it('a slow or refused supplier reports unavailable and changes nothing, same as refresh', async () => {
    const { call, calls } = setup(searchDeps(undefined, { searchLive: () => new Promise(() => {}) }));
    assert.deepEqual((await read(await call({ action: 'search_catalog', query: 'free fire' }))).body, { status: 'unavailable', reason: 'timeout' });
    assert.equal(calls.upsert.length, 0);

    const refused = setup(searchDeps(undefined, { searchLive: async () => { throw Object.assign(new Error('nope'), { status: 403 }); } }));
    assert.deepEqual((await read(await refused.call({ action: 'search_catalog', query: 'free fire' }))).body, { status: 'unavailable', reason: 'refused' });
  });
  it('a customer is refused before the supplier is ever called', async () => {
    const { call, calls } = setup(searchDeps());
    assert.equal((await call({ action: 'search_catalog', query: 'free fire' }, { token: 'user-token' })).status, 403);
    assert.equal(calls.upsert.length, 0);
  });
});

describe('load_offers', () => {
  const ask = (call, extra = {}) => call({ action: 'load_offers', family: 'topups', category_id: 'free_fire_mena', ...extra });

  it('fetches one category, hides first-purchase offers, saves with the date and returns it', async () => {
    const { call, calls } = setup();
    const { status, body } = await read(await ask(call));
    assert.equal(status, 200);
    assert.equal(body.status, 'ok');
    assert.deepEqual(body.offers.map((o) => o.ref), ['110_diamonds', '231_diamonds']);
    assert.equal(body.offers[0].cost_usd, '0.9456');
    assert.equal(body.hidden_offer_count, 1);
    assert.equal(body.offers_fetched_at, NOW.toISOString());
    assert.deepEqual(body.fields, [{ key: 'player_id', label: 'Player ID', type: 'text' }]);
    assert.deepEqual(calls.offersFetched, [['topups', 'free_fire_mena']]);
    assert.equal(calls.saved.length, 1);
    assert.equal(calls.saved[0].at, NOW.toISOString());
  });
  it('rejects a category that is not in the saved catalog, without calling the supplier', async () => {
    const { call, calls } = setup({ getCached: async () => null });
    assert.equal((await ask(call)).status, 404);
    assert.equal(calls.offersFetched.length, 0);
  });
  it('a blocked category is never fetched', async () => {
    const { call, calls } = setup({ getCached: async () => ({ offers: null, fields: null, hidden_offer_count: 0, offers_fetched_at: null, blocked_reason: 'asks for the password' }) });
    const { body } = await read(await ask(call, { category_id: 'genshin_impact_login' }));
    assert.deepEqual(body, { status: 'blocked', reason: 'asks for the password' });
    assert.equal(calls.offersFetched.length, 0);
    assert.equal(calls.saved.length, 0);
  });
  it('a category whose buyer form asks for a password is saved as blocked and never shown', async () => {
    const { call, calls } = setup({ fetchOffers: async () => ({ offers: [{ offer_id: 'a', name: '60 Crystals', price_usd: '1.0' }], fields: [{ key: 'server_id', label: 'Password', type: 'text' }] }) });
    const { body } = await read(await ask(call, { category_id: 'brand_new_thing' }));
    assert.equal(body.status, 'blocked');
    assert.equal(body.offers, undefined);
    assert.equal(calls.saved[0].result.blocked_reason.length > 0, true);
    assert.deepEqual(calls.saved[0].result.offers, []);
  });
  it('when the supplier is down it returns what was saved, with its date, so the admin can see how stale it is', async () => {
    const cached = { offers: [{ ref: 'a', name: 'A', cost_usd: '1.0000' }], fields: [], hidden_offer_count: 0, offers_fetched_at: '2026-09-20T15:00:00Z', blocked_reason: null };
    const { call, calls } = setup({ getCached: async () => cached, fetchOffers: async () => { throw Object.assign(new Error('x'), { status: 403 }); } });
    const { body } = await read(await ask(call));
    assert.equal(body.status, 'unavailable');
    assert.equal(body.reason, 'refused');
    assert.equal(body.cached.offers_fetched_at, '2026-09-20T15:00:00Z');
    assert.equal(body.cached.offers.length, 1);
    assert.equal(calls.saved.length, 0, 'a failed fetch must not overwrite the saved packs');
  });
  it('when the supplier is down and nothing was saved, cached is null', async () => {
    const { call } = setup({ fetchOffers: () => new Promise(() => {}) });
    const { body } = await read(await ask(call));
    assert.deepEqual(body, { status: 'unavailable', reason: 'timeout', cached: null });
  });
  it('rejects a bad family or category id', async () => {
    const { call, calls } = setup();
    for (const extra of [{ family: 'gamekeys' }, { family: 5 }, { category_id: '../etc' }, { category_id: '' }, { category_id: 7 }, { category_id: 'a'.repeat(101) }]) {
      assert.equal((await ask(call, extra)).status, 400);
    }
    assert.equal(calls.offersFetched.length, 0);
  });
  it('drops unsellable gift cards (no card id) and reports how many', async () => {
    const { call } = setup({ fetchOffers: async () => ({ offers: [{ card_id: null, name: '10 USD', price_usd: '10.00', stock: 5 }, { card_id: '25_usd', name: '25 USD', price_usd: '25.00', stock: 0 }] }) });
    const { body } = await read(await call({ action: 'load_offers', family: 'giftcards', category_id: 'amazon_us' }));
    assert.deepEqual(body.offers, [{ ref: '25_usd', name: '25 USD', cost_usd: '25.00', stock: 0 }]);
    assert.equal(body.hidden_offer_count, 1);
    assert.deepEqual(body.fields, []);
  });
});

describe('what is logged', () => {
  it('never a cost, an offer name, a player id or a supplier body', async () => {
    const { call, calls } = setup();
    await call({ action: 'refresh_catalog' });
    await call({ action: 'load_offers', family: 'topups', category_id: 'free_fire_mena' });
    const text = JSON.stringify(calls.logs);
    for (const secret of ['0.9456', '1.8913', '110 Diamonds', 'Player ID', 'Free Fire', 'free_fire_mena']) assert.equal(text.includes(secret), false, `logged ${secret}`);
    assert.ok(calls.logs.length >= 2);
  });
});

describe('failReason', () => {
  it('tells a refused key from a timeout from anything else', () => {
    assert.equal(failReason({ status: 401 }), 'refused');
    assert.equal(failReason({ status: 403 }), 'refused');
    assert.equal(failReason({ timedOut: true }), 'timeout');
    assert.equal(failReason({ status: 500 }), 'error');
    assert.equal(failReason(null), 'error');
    assert.equal(failReason(new Error('x')), 'error');
  });
});

// ---------------------------------------------------------------- a second supplier plugs into the same handler

describe('Shop2Topup through the same handler (fake network, real mapping)', () => {
  const reply = (http, body) => ({ status: http, text: async () => JSON.stringify(body) });
  const ROUTES = {
    '/catalog/big-categories': { success: true, data: [{ id: 2, name: 'Free Fire' }, { id: 241, name: 'Blood Strike' }] },
    '/catalog/categories?bigCategoryId=2': { success: true, data: [
      { id: 4, name: 'Mena Direct Topup', region_ids: [{ id: 30, name: 'MENA' }], country_ids: [], requirements: 'player_id' },
      { id: 3, name: 'Garena Cards', region_ids: [], country_ids: [], requirements: {} },
    ] },
    '/catalog/categories?bigCategoryId=241': { success: true, data: [{ id: 445, name: 'Direct Topup Mena', region_ids: [{ id: 30, name: 'MENA' }], country_ids: [], requirements: 'player_id' }] },
    '/catalog/subcategories?categoryId=4': { success: true, data: [{ id: 28, name: '100 + 10 Diamonds', price: 0.94564 }, { id: 29, name: 'Weekly Membership', price: 3.1 }] },
    '/catalog/category/4/requirements': { success: true, data: [{ field_name: 'player_id', data_type: 'text' }] },
  };
  const fetchFn = async (url) => {
    const path = url.replace('https://shop2topup.com/api/endpoints/v1', '');
    return ROUTES[path] ? reply(200, ROUTES[path]) : reply(404, { success: false, error: { code: 'NO_REQUIREMENTS_FOUND' } });
  };
  const client = createShop2TopupClient({ key: 'k', fetchFn });
  const s2deps = () => ({
    normalizeCategory: (family, raw, ctx) => normalizeShop2TopupCategory(family, raw, ctx),
    listValidationGames: async () => [],
    listCategories: async (family) => {
      const bigs = await client.bigCategories();
      const games = await Promise.all(bigs.map(async (g) => ({ ...g, categories: await client.categories(g.id) })));
      return toRawCategories(games, family);
    },
    fetchOffers: async (family, id) => {
      const [subs, req] = await Promise.all([client.subcategories(id), family === 'topups' ? client.requirements(id) : Promise.resolve([])]);
      return toRawOffers(family, subs, fieldsFromRequirements(req));
    },
  });

  it('a refresh saves Shop2Topup rows tagged with their supplier, split into top-ups and vouchers, with the ID check only where proven', async () => {
    const { call, calls } = setup(s2deps());
    const { status, body } = await read(await call({ action: 'refresh_catalog', supplier: 'shop2topup' }));
    assert.equal(status, 200);
    assert.equal(body.status, 'ok');
    assert.equal(calls.upsert.every((r) => r.supplier === 'shop2topup'), true);
    const byId = Object.fromEntries(calls.upsert.map((r) => [`${r.family}/${r.category_id}`, r]));
    assert.equal(byId['topups/4'].game_name, 'Free Fire');
    assert.equal(byId['topups/4'].validation_category_id, '4', 'Free Fire is proven to validate');
    assert.equal(byId['topups/445'].validation_category_id, '445', 'Blood Strike is proven too (a real ID returned its name)');
    assert.equal(byId['topups/445'].note_region, null, 'but its check reports no region, so MENA is a label, not a lock');
    assert.equal(byId['topups/445'].region_label, 'MENA');
    assert.equal(byId['giftcards/3'].family, 'giftcards');
  });
  it('loading a category returns its packs (Shop2Topup pack ids as refs, USD cost) and its buyer form', async () => {
    const { call, calls } = setup({ ...s2deps(), getCached: async () => ({ offers: null, fields: null, hidden_offer_count: 0, offers_fetched_at: null, blocked_reason: null }) });
    const { body } = await read(await call({ action: 'load_offers', supplier: 'shop2topup', family: 'topups', category_id: '4' }));
    assert.equal(body.status, 'ok');
    assert.deepEqual(body.offers, [{ ref: '28', name: '100 + 10 Diamonds', cost_usd: '0.94564' }, { ref: '29', name: 'Weekly Membership', cost_usd: '3.1' }]);
    assert.deepEqual(body.fields.map((f) => f.key), ['player_id']);
    assert.equal(calls.saved.length, 1);
  });
  it('a refused key (wrong key, or a server IP that is not allowed) is reported as "refused", not as an empty catalog', async () => {
    const refused = createShop2TopupClient({ key: 'k', fetchFn: async () => reply(403, { success: false, error: { code: 'IP_NOT_ALLOWED' } }) });
    const { call, calls } = setup({ ...s2deps(), listCategories: async () => { await refused.bigCategories(); return []; } });
    const { body } = await read(await call({ action: 'refresh_catalog', supplier: 'shop2topup' }));
    assert.deepEqual(body, { status: 'unavailable', reason: 'refused' });
    assert.equal(calls.upsert.length, 0);
  });
});
