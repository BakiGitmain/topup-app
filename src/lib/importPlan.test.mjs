// Run with: npm run test:unit
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';

import {
  KNOWN_ACCOUNT_REGION_CODES, buildImportPayload, commonUnit, costRange, formatUsd, formatUsdRange, groupByGame, mapValidationFields,
  SUPPLIERS, SUPPLIER_LABEL, ageText, oldestDate, stalePriceWarnings, categoryKeyFor, applyOutcome, effectiveRow, initialRegionState, parseLoadOffers, parseRefresh, regionCodeFor, regionDefaults, staleLevel, unitOf, unreachableText,
  crossSupplierValidation, ownValidation, resolvedValidation,
} from './importPlan.ts';

const PLAYER = [{ key: 'player_id', label: 'Player ID', type: 'text' }];
const ML_BUY = [{ key: 'player_id', label: 'User ID', type: 'text' }, { key: 'server_id', label: 'Zone ID', type: 'text' }];
const ML_CHECK = [{ key: 'player_id', label: 'User ID', type: 'text' }, { key: 'zone_id', label: 'Zone ID', type: 'text' }];
const OFFERS = [
  { ref: '231_diamonds', name: '231 Diamonds', cost_usd: '1.8913' },
  { ref: '110_diamonds', name: '110 Diamonds', cost_usd: '0.9456' },
];
const row = (o = {}) => ({
  family: 'topups', category_id: 'free_fire_mena', name: 'Free Fire (MENA)', game_name: 'Free Fire', region_label: 'MENA', note_region: 'MENA',
  validation_category_id: 'free_fire', validation_fields: PLAYER, offers: OFFERS, fields: PLAYER, hidden_offer_count: 0, offers_fetched_at: '2026-09-20T12:00:00Z', ...o,
});
// codes start as the screen starts them: the region's own defaults (ME for MENA, nothing for the rest).
const choice = (r, packs, extra = {}) => ({ row: r, label: r.region_label ?? 'Standard', packs, codes: regionDefaults(r).codes, invalidCodes: [], ...extra });
const priced = (offers, price = 100) => offers.map((offer) => ({ offer, price }));

describe('groupByGame', () => {
  it('puts a game\'s regions together, sorted, and keeps top-ups and gift cards apart', () => {
    const groups = groupByGame([
      row({ category_id: 'free_fire_th', name: 'Free Fire (TH)', region_label: 'TH' }),
      row({ category_id: 'free_fire_bd', name: 'Free Fire (BD)', region_label: 'BD' }),
      row({ category_id: 'amazon_us', name: 'Amazon (US)', game_name: 'Amazon', family: 'giftcards', region_label: 'US' }),
      row({ category_id: 'amazon_gc', name: 'Amazon', game_name: 'amazon', family: 'topups', region_label: null }),
    ]);
    assert.deepEqual(groups.map((g) => [g.name, g.family, g.regions.length]), [['Amazon', 'giftcards', 1], ['amazon', 'topups', 1], ['Free Fire', 'topups', 2]]);
    assert.deepEqual(groups[2].regions.map((r) => r.region_label), ['BD', 'TH']);
  });
  it('is empty for nothing', () => assert.deepEqual(groupByGame([]), []));
});

describe('costs and dates', () => {
  it('finds the cheapest and dearest pack, and copes with none', () => {
    assert.deepEqual(costRange(OFFERS), { min: 0.9456, max: 1.8913 });
    assert.equal(costRange([]), null);
    assert.equal(costRange(null), null);
  });
  it('shows cents normally and small costs precisely', () => {
    assert.equal(formatUsd(18.9128), '$18.91');
    assert.equal(formatUsd(1), '$1.00');
    assert.equal(formatUsd(0.9456), '$0.9456');
    assert.equal(formatUsd(0.1), '$0.1');
    assert.equal(formatUsdRange({ min: 0.9456, max: 18.9128 }), '$0.9456 - $18.91');
    assert.equal(formatUsdRange({ min: 2, max: 2 }), '$2.00');
    assert.equal(formatUsdRange(null), 'no packs');
  });
  it('grades how stale saved prices are', () => {
    const now = Date.parse('2026-09-25T12:00:00Z');
    assert.equal(staleLevel(null, now), 'never');
    assert.equal(staleLevel('garbage', now), 'never');
    assert.equal(staleLevel('2026-09-25T00:00:00Z', now), 'fresh');
    assert.equal(staleLevel('2026-09-20T12:00:00Z', now), 'aging');
    assert.equal(staleLevel('2026-09-01T12:00:00Z', now), 'old');
  });
});

describe('how old saved data is, in words', () => {
  const now = Date.parse('2026-09-25T12:00:00Z');
  const ago = (ms) => new Date(now - ms).toISOString();
  it('spells the age out, with the right singular and plural', () => {
    assert.equal(ageText(ago(20_000), now), 'just now');
    assert.equal(ageText(ago(60_000), now), '1 minute ago');
    assert.equal(ageText(ago(59 * 60_000), now), '59 minutes ago');
    assert.equal(ageText(ago(3600_000), now), '1 hour ago');
    assert.equal(ageText(ago(23 * 3600_000), now), '23 hours ago');
    assert.equal(ageText(ago(24 * 3600_000), now), '1 day ago');
    assert.equal(ageText(ago(5 * 24 * 3600_000), now), '5 days ago');
  });
  it('a date in the future (a wrong clock) reads as just now, never a negative age', () => assert.equal(ageText(new Date(now + 3600_000).toISOString(), now), 'just now'));
  it('says never when there is no date', () => {
    for (const bad of [null, '', 'garbage']) assert.equal(ageText(bad, now), 'never');
  });
  it('the oldest date in a group is the one that counts', () => {
    assert.equal(oldestDate(['2026-09-22T00:00:00Z', null, '2026-09-20T00:00:00Z', 'nope']), '2026-09-20T00:00:00Z');
    assert.equal(oldestDate([null, 'x']), null);
    assert.equal(oldestDate([]), null);
  });
  it('warns, before an import, about every region whose prices are over a day old or missing', () => {
    const w = stalePriceWarnings([
      { label: 'MENA', fetchedAt: ago(2 * 3600_000) },
      { label: 'BD', fetchedAt: ago(3 * 24 * 3600_000) },
      { label: 'TH', fetchedAt: null },
    ], now);
    assert.equal(w.length, 2);
    assert.match(w[0], /"BD".*3 days ago.*may have changed.*refresh/);
    assert.match(w[1], /"TH".*no prices have been saved/);
    assert.deepEqual(stalePriceWarnings([], now), []);
  });
});

describe('mapValidationFields', () => {
  it('needs no map when the forms match', () => assert.deepEqual(mapValidationFields(PLAYER, PLAYER), {}));
  it('maps the one field that is named differently (Mobile Legends)', () => assert.deepEqual(mapValidationFields(ML_BUY, ML_CHECK), { server_id: 'zone_id' }));
  it('refuses anything ambiguous or incomplete', () => {
    assert.equal(mapValidationFields(PLAYER, ML_CHECK), null);
    assert.equal(mapValidationFields([], PLAYER), null);
    assert.equal(mapValidationFields([{ key: 'a' }, { key: 'b' }], [{ key: 'x' }, { key: 'y' }]), null);
    assert.equal(mapValidationFields([{ key: 'a' }, { key: 'a' }], [{ key: 'a' }]), null);
  });
});

describe('regionDefaults (never guess a region code)', () => {
  it('Free Fire MENA: supplier ID check, locked, ME prefilled', () => {
    assert.deepEqual(regionDefaults(row()), { idMode: 'supplier', validationCategoryId: 'free_fire', validationFieldMap: {}, locked: true, codes: ['ME'], idCheckNote: null });
  });
  it('the MENA match ignores case and spacing of the supplier text', () => assert.deepEqual(regionDefaults(row({ note_region: ' mena ' })).codes, ['ME']));
  it('any other region of a checkable game is locked with NO codes (an off draft until typed)', () => {
    for (const region of ['Bangladesh', 'Brazil', 'CIS', 'Europe', 'Indonesia', 'LATAM', 'Malaysia/Singapore', 'Philippines', 'Singapore', 'Thailand', 'Taiwan', 'Vietnam', 'ID', 'MY', 'TR', 'RU', 'Russia']) {
      const d = regionDefaults(row({ note_region: region }));
      assert.equal(d.locked, true, region);
      assert.deepEqual(d.codes, [], region);
      assert.equal(d.idMode, 'supplier', region);
    }
  });
  it('a Global category is checked but not locked', () => {
    const d = regionDefaults(row({ category_id: 'pubg_mobile_auto', note_region: 'Global', validation_category_id: 'pubg_mobile' }));
    assert.equal(d.idMode, 'supplier');
    assert.equal(d.locked, false);
    assert.deepEqual(d.codes, []);
  });
  it('Mobile Legends validates with zone_id, so the map is stored', () => {
    const d = regionDefaults(row({ note_region: 'BR', fields: ML_BUY, validation_fields: ML_CHECK, validation_category_id: 'mobile_legends' }));
    assert.deepEqual(d.validationFieldMap, { server_id: 'zone_id' });
    assert.equal(d.locked, true);
    assert.deepEqual(d.codes, []);
  });
  it('a game the supplier cannot check imports unlocked, with the customer tick', () => {
    const d = regionDefaults(row({ category_id: 'blood_strike_mena', validation_category_id: null, validation_fields: null }));
    assert.deepEqual([d.idMode, d.locked, d.codes], ['none', false, []]);
  });
  it('a lock is never set without a supplier ID check (a locked pack could never be sold)', () => {
    const d = regionDefaults(row({ fields: [{ key: 'other', label: 'X', type: 'text' }, { key: 'more', label: 'Y', type: 'text' }] }));
    assert.deepEqual([d.idMode, d.locked], ['none', false]);
    assert.match(d.idCheckNote, /tick/);
  });
  it('a category that states no region is not locked', () => {
    assert.equal(regionDefaults(row({ note_region: null })).locked, false);
    assert.equal(regionDefaults(row({ note_region: '   ' })).locked, false);
  });
  it('gift cards are never locked and never ID-checked', () => {
    const d = regionDefaults(row({ family: 'giftcards', fields: [], validation_category_id: null, validation_fields: null, note_region: 'US' }));
    assert.deepEqual([d.idMode, d.locked, d.codes], ['none', false, []]);
  });
  it('MENA is the only region with a known code', () => assert.deepEqual(Object.keys(KNOWN_ACCOUNT_REGION_CODES), ['MENA']));
});

describe('names', () => {
  it('reads the unit word of a pack', () => {
    assert.equal(unitOf('110 Diamonds'), 'Diamonds');
    assert.equal(unitOf('50 + 50 Diamonds'), 'Diamonds');
    assert.equal(unitOf('Weekly Membership'), null);
    assert.equal(unitOf('5 USD'), 'USD');
  });
  it('picks the unit most packs share', () => {
    assert.equal(commonUnit(['110 Diamonds', '231 diamonds', 'Weekly Membership']), 'Diamonds');
    assert.equal(commonUnit(['Weekly Membership']), null);
    assert.equal(commonUnit([]), null);
  });
  it('makes short unique region codes the database accepts', () => {
    const used = new Set();
    const codes = ['MENA', 'MENA', 'Malaysia/Singapore', '', '!!!'].map((l) => { const c = regionCodeFor(l, 'free_fire_x', used); used.add(c); return c; });
    assert.deepEqual(codes, ['mena', 'mena_2', 'malaysia_singapore', 'free_fire_x', 'free_fire_x_2']);
    for (const c of codes) assert.match(c, /^[a-z0-9_]{1,40}$/);
    assert.match(regionCodeFor('x'.repeat(80), 'a', new Set()), /^[a-z0-9_]{1,40}$/);
  });
});

describe('buildImportPayload', () => {
  const good = () => ({ name: 'Free Fire Diamonds', imageUrl: null, regions: [choice(row(), priced(OFFERS))] });

  it('shapes a Free Fire MENA import: locked to ME, supplier-checked, cheapest pack first, offer names kept', () => {
    const r = buildImportPayload(good());
    assert.equal(r.ok, true);
    assert.deepEqual(r.warnings, []);
    const p = r.payload;
    assert.equal(p.category, 'games');
    assert.equal(p.tagline, 'Diamonds');
    assert.equal(p.currency_label, 'Diamonds');
    assert.equal(p.image_url, null);
    const region = p.regions[0];
    assert.deepEqual([region.code, region.label, region.id_validation, region.family, region.category_id, region.validation_category_id], ['mena', 'MENA', 'supplier', 'topups', 'free_fire_mena', 'free_fire']);
    assert.deepEqual(region.buyer_fields, PLAYER);
    assert.deepEqual(region.packs.map((k) => k.offer_ref), ['110_diamonds', '231_diamonds']);
    assert.deepEqual(region.packs[0], { offer_ref: '110_diamonds', offer_name: '110 Diamonds', label: '110 Diamonds', price: 100, cost_usd: '0.9456', group_label: 'Diamonds', region_locked: true, account_region_codes: ['ME'] });
  });
  it('ME is in the payload only because the MENA default put it there; clearing it leaves the pack a draft', () => {
    const cleared = buildImportPayload({ ...good(), regions: [choice(row(), priced(OFFERS), { codes: [] })] });
    assert.deepEqual(cleared.payload.regions[0].packs.map((k) => k.account_region_codes), [[], []]);
    assert.equal(cleared.warnings.length, 1);
  });
  it('a locked region without codes imports, with a warning that it stays off', () => {
    const r = buildImportPayload(good());
    assert.equal(r.ok, true);
    const bd = buildImportPayload({ ...good(), regions: [choice(row({ note_region: 'Bangladesh', region_label: 'BD' }), priced(OFFERS))] });
    assert.equal(bd.ok, true);
    assert.equal(bd.warnings.length, 1);
    assert.match(bd.warnings[0], /no account regions.*stay off/);
    assert.deepEqual(bd.payload.regions[0].packs.map((k) => [k.region_locked, k.account_region_codes]), [[true, []], [true, []]]);
  });
  it('codes typed for a region that is not locked are ignored, with a warning', () => {
    const r = buildImportPayload({ ...good(), regions: [choice(row({ family: 'giftcards', fields: [], validation_category_id: null, validation_fields: null, category_id: 'amazon_us', note_region: 'US', region_label: 'US' }), priced(OFFERS), { codes: ['US'] })] });
    assert.equal(r.ok, true);
    assert.equal(r.warnings.length, 1);
    assert.deepEqual(r.payload.regions[0].packs.map((k) => [k.region_locked, k.account_region_codes]), [[false, []], [false, []]]);
    assert.equal(r.payload.category, 'gift-cards');
    assert.deepEqual(r.payload.regions[0].buyer_fields, []);
    assert.equal(r.payload.regions[0].id_validation, 'none');
  });
  it('several regions of one game, each with its own category and unique code', () => {
    const r = buildImportPayload({ ...good(), regions: [choice(row(), priced(OFFERS)), choice(row({ category_id: 'free_fire_bd', region_label: 'MENA', note_region: 'Bangladesh' }), priced(OFFERS.slice(0, 1)))] });
    assert.equal(r.ok, true);
    assert.deepEqual(r.payload.regions.map((x) => [x.code, x.category_id, x.packs.length]), [['mena', 'free_fire_mena', 2], ['mena_2', 'free_fire_bd', 1]]);
  });
  it('sends prices as numbers, never a placeholder', () => {
    const r = buildImportPayload({ ...good(), regions: [choice(row(), [{ offer: OFFERS[0], price: 165.5 }, { offer: OFFERS[1], price: 90 }])] });
    assert.deepEqual(r.payload.regions[0].packs.map((k) => k.price), [90, 165.5]);
  });
  const problems = (input) => { const r = buildImportPayload(input); assert.equal(r.ok, false, JSON.stringify(r)); return r.problems.join(' | '); };
  it('needs a name, a region, packs and prices', () => {
    assert.match(problems({ ...good(), name: '   ' }), /name/);
    assert.match(problems({ ...good(), name: 'x'.repeat(121) }), /too long/);
    assert.match(problems({ ...good(), regions: [] }), /at least one region/);
    assert.match(problems({ ...good(), regions: [choice(row(), [])] }), /at least one pack/);
    assert.match(problems({ ...good(), regions: [choice(row(), [{ offer: OFFERS[0], price: null }, { offer: OFFERS[1], price: 5 }])] }), /set a birr price for "231 Diamonds"/);
    assert.match(problems({ ...good(), regions: [choice(row(), [{ offer: OFFERS[0], price: 0 }, { offer: OFFERS[1], price: -1 }])] }), /2 packs/);
    assert.match(problems({ ...good(), regions: [choice(row(), priced(OFFERS), { label: '  ' })] }), /name customers will see/);
  });
  it('refuses invalid region codes and unloaded categories', () => {
    assert.match(problems({ ...good(), regions: [choice(row(), priced(OFFERS), { invalidCodes: ['not ok!'] })] }), /not ok!.*valid region code/);
    assert.match(problems({ ...good(), regions: [choice(row({ offers: null, fields: null }), priced(OFFERS))] }), /haven't been loaded/);
  });
  it("won't mix top-ups and gift cards in one product", () => {
    assert.match(problems({ ...good(), regions: [choice(row(), priced(OFFERS)), choice(row({ family: 'giftcards' }), priced(OFFERS))] }), /can't share one product/);
  });
  it('the payload survives JSON (it is sent as one)', () => {
    const r = buildImportPayload(good());
    assert.deepEqual(JSON.parse(JSON.stringify(r.payload)), r.payload);
  });
});

describe('parsing what the function returns', () => {
  const data = { offers: [{ ref: 'a', name: 'A', cost_usd: '1.0000', stock: 3 }], fields: PLAYER, hidden_offer_count: 2, offers_fetched_at: '2026-09-21T10:00:00Z' };
  it('fresh packs', () => {
    assert.deepEqual(parseLoadOffers({ status: 'ok', ...data, blocked_reason: null }), { kind: 'fresh', data });
  });
  it('saved packs when the supplier is down, with the reason and their date', () => {
    assert.deepEqual(parseLoadOffers({ status: 'unavailable', reason: 'refused', cached: data }), { kind: 'saved', reason: 'refused', data });
    assert.deepEqual(parseLoadOffers({ status: 'unavailable', reason: 'weird', cached: null }), { kind: 'saved', reason: 'error', data: null });
  });
  it('blocked', () => assert.deepEqual(parseLoadOffers({ status: 'blocked', reason: 'password' }), { kind: 'blocked', reason: 'password' }));
  it('never trusts a strange shape', () => {
    for (const bad of [null, undefined, 5, 'x', [], {}, { status: 'ok' }, { status: 'ok', offers: 'no', fields: [] }, { status: 'ok', offers: [{ ref: 1 }], fields: [] }, { status: 'ok', ...data, offers_fetched_at: null }, { status: 'nope' }]) {
      assert.deepEqual(parseLoadOffers(bad), { kind: 'error' }, JSON.stringify(bad));
    }
    assert.deepEqual(parseLoadOffers({ status: 'unavailable', reason: 'timeout', cached: { offers: 'bad' } }), { kind: 'saved', reason: 'timeout', data: null });
  });
  it('refresh results', () => {
    assert.deepEqual(parseRefresh({ status: 'ok', categories: 885, topups: 306, giftcards: 579, removed: 1, refreshed_at: '2026-09-21T10:00:00Z' }), { kind: 'ok', categories: 885, removed: 1, refreshedAt: '2026-09-21T10:00:00Z' });
    assert.deepEqual(parseRefresh({ status: 'unavailable', reason: 'refused' }), { kind: 'unavailable', reason: 'refused' });
    assert.deepEqual(parseRefresh({ status: 'suspicious', found: 3, saved: 885 }), { kind: 'suspicious', found: 3, saved: 885 });
    for (const bad of [null, {}, { status: 'ok' }, { status: 'ok', categories: 'x', refreshed_at: 'y' }, 7]) assert.deepEqual(parseRefresh(bad), { kind: 'error' });
  });
  it('says why the supplier is not answering', () => {
    assert.match(unreachableText('refused'), /trial/);
    assert.match(unreachableText('timeout'), /in time/);
    assert.match(unreachableText('error'), /reach/);
  });
});

describe('the region state on screen', () => {
  const noData = () => initialRegionState(row({ offers: null, fields: null, offers_fetched_at: null }));
  const fresh = (extra = {}) => ({ kind: 'fresh', data: { offers: OFFERS, fields: PLAYER, hidden_offer_count: 1, offers_fetched_at: '2026-09-21T10:00:00Z', ...extra } });

  it('starts unticked, from the saved packs, with ME prefilled only where it is known', () => {
    const s = initialRegionState(row());
    assert.deepEqual([s.ticked, s.label, s.codesText, s.busy, s.notice, s.data.offers.length, s.data.fetchedAt], [false, 'MENA', 'ME', false, null, 2, '2026-09-20T12:00:00Z']);
    assert.equal(initialRegionState(row({ note_region: 'Bangladesh', region_label: 'BD' })).codesText, '');
    assert.equal(initialRegionState(row({ region_label: null })).label, 'Standard');
  });
  it('a category that was never fetched has no data and no codes yet', () => {
    const s = noData();
    assert.deepEqual([s.data, s.codesText], [null, '']);
    assert.deepEqual([effectiveRow(row(), s).offers, effectiveRow(row(), s).fields], [null, null]);
  });
  it('fresh packs replace the data, clear the notice, and fill the MENA default the first time only', () => {
    const first = applyOutcome({ ...noData(), busy: true, notice: 'old' }, row(), fresh());
    assert.deepEqual([first.busy, first.notice, first.codesText, first.data.hidden, first.data.fetchedAt], [false, null, 'ME', 1, '2026-09-21T10:00:00Z']);
    const edited = applyOutcome({ ...first, codesText: '' }, row(), fresh());
    assert.equal(edited.codesText, '', 'a refresh must not put back a code the admin removed');
  });
  it("keeps the admin's picks and prices across a refresh", () => {
    const before = { ...initialRegionState(row()), ticked: true, packs: { '110_diamonds': { ticked: true, price: '90' } } };
    const after = applyOutcome(before, row(), fresh());
    assert.deepEqual(after.packs, before.packs);
    assert.equal(after.ticked, true);
  });
  it('when the supplier is down, saved packs stay and the reason is shown', () => {
    const prev = initialRegionState(row());
    const withSaved = applyOutcome(prev, row(), { kind: 'saved', reason: 'refused', data: { offers: OFFERS, fields: PLAYER, hidden_offer_count: 0, offers_fetched_at: '2026-09-20T12:00:00Z' } });
    assert.match(withSaved.notice, /refused.*trial.*saved earlier/);
    assert.equal(withSaved.data.offers.length, 2);
    const keep = applyOutcome(prev, row(), { kind: 'saved', reason: 'timeout', data: null });
    assert.equal(keep.data, prev.data, 'nothing is thrown away');
    assert.match(keep.notice, /in time.*saved earlier/);
    const none = applyOutcome(noData(), row(), { kind: 'saved', reason: 'error', data: null });
    assert.equal(none.data, null);
    assert.match(none.notice, /no saved prices/);
  });
  it('a blocked category unticks itself and says why', () => {
    const s = applyOutcome({ ...noData(), ticked: true, busy: true }, row(), { kind: 'blocked', reason: 'asks for the password' });
    assert.deepEqual([s.ticked, s.busy], [false, false]);
    assert.match(s.notice, /can't be imported: asks for the password/);
  });
  it('a plain failure keeps whatever was saved', () => {
    assert.match(applyOutcome(initialRegionState(row()), row(), { kind: 'error' }).notice, /saved earlier/);
    assert.match(applyOutcome(noData(), row(), { kind: 'error' }).notice, /Try again/);
  });
  it('never leaves the region busy', () => {
    for (const out of [fresh(), { kind: 'saved', reason: 'error', data: null }, { kind: 'blocked', reason: 'x' }, { kind: 'error' }]) {
      assert.equal(applyOutcome({ ...noData(), busy: true }, row(), out).busy, false);
    }
  });
});

describe('categories and card images at import', () => {
  const two = [{ key: 'uc', label: 'UC' }, { key: 'coins', label: 'Coins' }];
  const input = (extra = {}, packs) => ({
    name: 'Game', imageUrl: null,
    regions: [choice(row(), packs ?? [{ offer: OFFERS[0], price: 100, categoryKey: 'uc' }, { offer: OFFERS[1], price: 90, categoryKey: 'coins' }])],
    ...extra,
  });
  const problems = (i) => { const r = buildImportPayload(i); assert.equal(r.ok, false, JSON.stringify(r)); return r.problems.join(' | '); };

  it('with no categories and no images the payload is exactly as before (no new keys)', () => {
    const r = buildImportPayload({ name: 'Game', imageUrl: null, regions: [choice(row(), priced(OFFERS))] });
    assert.equal(r.ok, true);
    assert.equal('images' in r.payload, false);
    assert.equal('categories' in r.payload, false);
    assert.equal(r.payload.regions[0].packs.some((p) => 'category_key' in p), false);
  });
  it('sends the categories, each pack\'s category key, and the gallery paths', () => {
    const r = buildImportPayload(input({ categories: two, imagePaths: ['products/a-1.jpg', 'products/b-2.jpg'] }));
    assert.equal(r.ok, true);
    assert.deepEqual(r.payload.categories, two);
    assert.deepEqual(r.payload.images, [{ path: 'products/a-1.jpg' }, { path: 'products/b-2.jpg' }]);
    const byRef = Object.fromEntries(r.payload.regions[0].packs.map((p) => [p.offer_ref, p.category_key]));
    assert.deepEqual(byRef, { '110_diamonds': 'coins', '231_diamonds': 'uc' });
  });
  it('with TWO categories every pack must have one (else it would be unreachable behind the pills)', () => {
    assert.match(problems(input({ categories: two }, [{ offer: OFFERS[0], price: 100, categoryKey: 'uc' }, { offer: OFFERS[1], price: 90 }])), /choose a category for "110 Diamonds"/);
    assert.match(problems(input({ categories: two }, priced(OFFERS))), /choose a category for 2 packs/);
  });
  it('with ONE category (or none) a pack need not name one', () => {
    assert.equal(buildImportPayload(input({ categories: [two[0]] }, priced(OFFERS))).ok, true);
    assert.equal(buildImportPayload(input({}, priced(OFFERS))).ok, true);
  });
  it('a pack in a category that does not exist is refused', () => {
    assert.match(problems(input({ categories: two }, [{ offer: OFFERS[0], price: 100, categoryKey: 'ghost' }, { offer: OFFERS[1], price: 90, categoryKey: 'uc' }])), /category that no longer exists/);
  });
  it('category names: required, unique (ignoring case), at most 40 characters, at most 12', () => {
    assert.match(problems(input({ categories: [{ key: 'a', label: '  ' }] })), /every category a name/);
    assert.match(problems(input({ categories: [{ key: 'a', label: 'UC' }, { key: 'b', label: ' uc ' }] })), /same name/);
    assert.match(problems(input({ categories: [{ key: 'a', label: 'x'.repeat(41) }] })), /too long/);
    assert.match(problems(input({ categories: Array.from({ length: 13 }, (_, i) => ({ key: 'k' + i, label: 'L' + i })) })), /at most 12 categories/);
  });
  it('at most 12 card images', () => {
    assert.match(problems(input({ imagePaths: Array.from({ length: 13 }, (_, i) => `products/x-${i}.jpg`) })), /at most 12 card images/);
  });
  it('trims category labels before sending them', () => {
    assert.deepEqual(buildImportPayload(input({ categories: [{ key: 'uc', label: '  UC  ' }] }, priced(OFFERS))).payload.categories, [{ key: 'uc', label: 'UC' }]);
  });
  it('makes a short unique key from a label, one the database accepts', () => {
    const used = new Set();
    const keys = ['UC', 'uc', 'Game Coins!', '', '💎💎'].map((l) => { const k = categoryKeyFor(l, used); used.add(k); return k; });
    assert.deepEqual(keys, ['uc', 'uc_2', 'game_coins', 'category', 'category_2']);
    for (const k of keys) assert.match(k, /^[a-z0-9_-]{1,40}$/);
    assert.match(categoryKeyFor('x'.repeat(100), new Set()), /^[a-z0-9_-]{1,40}$/);
  });
});

// ---- invariants over the real catalog (skipped without the git-ignored scan)
const scanUrl = new URL('../../scripts/out/fazer-scan.json', import.meta.url);
const dumpUrl = new URL('../../scripts/out/fazer-dump.json', import.meta.url);
describe('over the real catalog', { skip: !fs.existsSync(scanUrl) || !fs.existsSync(dumpUrl) }, async () => {
  const cat = await import('../../supabase/functions/_shared/catalog.ts');
  const scan = JSON.parse(fs.readFileSync(scanUrl, 'utf8'));
  const games = cat.cleanValidationGames(JSON.parse(fs.readFileSync(dumpUrl, 'utf8')).validateIdGames.items);
  const rows = [];
  for (const [family, list, offers] of [['topups', scan.topupCats, scan.topups], ['giftcards', scan.giftCats, scan.giftcards]]) {
    for (const c of list) {
      const r = cat.normalizeCategory(family, c, { blocklist: {}, validationGames: games, listedAt: 'x' });
      const o = cat.normalizeOffers(family, offers[c.category_id]);
      rows.push({ ...r, offers: o.offers, fields: o.fields });
    }
  }
  const defaults = rows.map((r) => [r, regionDefaults(r)]);

  it('every locked region is supplier-checked (else its packs could never be sold)', () => {
    assert.ok(defaults.filter(([, d]) => d.locked).length > 0);
    for (const [r, d] of defaults) if (d.locked) assert.equal(d.idMode, 'supplier', r.category_id);
  });
  it('the only category with prefilled codes is Free Fire (MENA), and its code is ME', () => {
    const withCodes = defaults.filter(([, d]) => d.codes.length > 0).map(([r, d]) => [r.category_id, d.codes]);
    assert.deepEqual(withCodes, [['free_fire_mena', ['ME']]]);
  });
  it('no gift card is locked or checked', () => {
    for (const [r, d] of defaults) if (r.family === 'giftcards') assert.deepEqual([d.locked, d.idMode], [false, 'none'], r.category_id);
  });
  it('every category that is checked has a form that maps onto the check', () => {
    for (const [r, d] of defaults) if (d.idMode === 'supplier') assert.notEqual(mapValidationFields(r.fields, r.validation_fields), null, r.category_id);
  });
  it('Mobile Legends categories store the zone_id map', () => {
    const ml = defaults.filter(([r, d]) => d.idMode === 'supplier' && r.validation_category_id === 'mobile_legends');
    assert.ok(ml.length >= 9);
    for (const [, d] of ml) assert.deepEqual(d.validationFieldMap, { server_id: 'zone_id' });
  });
  it('every checked-or-not category can be turned into a payload the database would accept in shape', () => {
    let built = 0;
    for (const [r] of defaults) {
      if (r.offers.length === 0) continue;
      const res = buildImportPayload({ name: 'X', imageUrl: null, regions: [choice(r, priced(r.offers.slice(0, 3)))] });
      assert.equal(res.ok, true, r.category_id);
      for (const region of res.payload.regions) {
        assert.match(region.code, /^[a-z0-9_]{1,40}$/);
        assert.ok(region.label.length >= 1 && region.label.length <= 60, r.category_id);
        for (const p of region.packs) assert.ok(p.offer_name && p.offer_ref && p.label.length <= 80, r.category_id);
      }
      built++;
    }
    assert.ok(built > 800);
  });
});

describe('importing from a named supplier', () => {
  const s2 = (o = {}) => row({ supplier: 'shop2topup', category_id: '4', name: 'Free Fire (MENA)', ...o });

  it('a row with no supplier (read before suppliers were named) imports as FazerCards, as ever', () => {
    assert.equal(buildImportPayload({ name: 'X', imageUrl: null, regions: [choice(row(), priced(OFFERS))] }).payload.regions[0].supplier, 'fazercards');
  });
  it('a Shop2Topup row carries its supplier into the payload, with its own category id', () => {
    const r = buildImportPayload({ name: 'X', imageUrl: null, regions: [choice(s2(), priced(OFFERS))] });
    assert.equal(r.ok, true);
    assert.deepEqual([r.payload.regions[0].supplier, r.payload.regions[0].category_id], ['shop2topup', '4']);
  });
  it('a FazerCards row says so explicitly when the row is tagged', () => {
    assert.equal(buildImportPayload({ name: 'X', imageUrl: null, regions: [choice(row({ supplier: 'fazercards' }), priced(OFFERS))] }).payload.regions[0].supplier, 'fazercards');
  });
  it('one product cannot mix suppliers: it is a problem, not a silent choice', () => {
    const r = buildImportPayload({ name: 'X', imageUrl: null, regions: [choice(row(), priced(OFFERS)), choice(s2({ category_id: '9', region_label: 'Brazil', note_region: 'Brazil' }), priced(OFFERS))] });
    assert.equal(r.ok, false);
    assert.match(r.problems.join(' '), /different suppliers/);
  });
  it('two regions of the same supplier are fine', () => {
    const r = buildImportPayload({ name: 'X', imageUrl: null, regions: [choice(s2(), priced(OFFERS)), choice(s2({ category_id: '9', region_label: 'Brazil', note_region: 'Brazil' }), priced(OFFERS))] });
    assert.equal(r.ok, true);
  });
  it('the admin can pick exactly Shop2Topup and GamesDrop; FazerCards is not offered (its trial has ended)', () => {
    assert.deepEqual([...SUPPLIERS], ['shop2topup', 'gamesdrop']);
  });
  it('every label, including FazerCards\' (kept only for its historical data, not for picking)', () => {
    assert.deepEqual(SUPPLIER_LABEL, { fazercards: 'FazerCards', shop2topup: 'Shop2Topup', gamesdrop: 'GamesDrop' });
  });
});

describe('Shop2Topup regions (what the real catalog looks like)', () => {
  const FF_S2 = { supplier: 'shop2topup', validation_category_id: '4', category_id: '4', note_region: 'MENA' };
  it('Free Fire "Mena Direct Topup": supplier-checked, locked, ME prefilled, same as FazerCards', () => {
    const d = regionDefaults(row(FF_S2));
    assert.deepEqual([d.idMode, d.locked, d.codes, d.validationCategoryId], ['supplier', true, ['ME'], '4']);
  });
  it('Free Fire in a country (Brazil, Indonesia) is locked with NO codes: it stays off until an admin types them', () => {
    for (const region of ['BR', 'ID', 'BD', 'PK', 'TW', 'VN', 'SG', 'CIS', 'LATAM', 'Europe']) {
      const d = regionDefaults(row({ ...FF_S2, note_region: region }));
      assert.deepEqual([d.locked, d.codes], [true, []], region);
    }
  });
  it('Mobile Legends "Worldwide" is checked but NOT locked (it means any account)', () => {
    const d = regionDefaults(row({ ...FF_S2, category_id: '472', validation_category_id: '472', note_region: 'Worldwide', validation_fields: ML_CHECK, fields: ML_CHECK }));
    assert.deepEqual([d.idMode, d.locked, d.codes], ['supplier', false, []]);
  });
  it('"Worldwide" ignores case and spacing, like Global', () => {
    for (const note of ['worldwide', ' WORLDWIDE ', 'Global', 'global']) assert.equal(regionDefaults(row({ ...FF_S2, note_region: note })).locked, false, note);
  });
  it('a game Shop2Topup cannot check (no validation category) falls back to the customer\'s tick, like Blood Strike', () => {
    const d = regionDefaults(row({ ...FF_S2, validation_category_id: null, validation_fields: null, note_region: null }));
    assert.deepEqual([d.idMode, d.validationCategoryId, d.locked], ['none', null, false]);
  });
  it('a Shop2Topup Mobile Legends form maps onto its check (both use zone_id, so no rename is needed)', () => {
    assert.deepEqual(mapValidationFields(ML_CHECK, ML_CHECK), {});
  });
});

describe('cross-supplier ID checks (validation is independent of the fulfilment supplier)', () => {
  const bloodRow = () => row({
    supplier: 'fazercards', category_id: 'blood_strike_mena', name: 'Blood Strike (Mena)', game_name: 'Blood Strike',
    region_label: 'MENA', note_region: 'MENA', validation_category_id: null, validation_fields: null,
  });
  const s2Candidate = { supplier: 'shop2topup', validation_category_id: '445', validation_fields: PLAYER, note_region: null };
  const fzCandidate = { supplier: 'fazercards', validation_category_id: 'free_fire', validation_fields: PLAYER, note_region: 'MENA' };

  it("ownValidation is null when this row's own supplier has no check (Blood Strike on FazerCards)", () => {
    assert.equal(ownValidation(bloodRow()), null);
  });
  it("ownValidation mirrors the row's own fields when it does check (Free Fire on FazerCards)", () => {
    assert.deepEqual(ownValidation(row()), fzCandidate);
  });

  it('crossSupplierValidation finds another supplier\'s candidate for the same game', () => {
    assert.deepEqual(crossSupplierValidation(bloodRow(), [s2Candidate]), s2Candidate);
  });
  it('...never offers the row\'s own supplier as a "cross" option', () => {
    assert.equal(crossSupplierValidation(row(), [fzCandidate]), null);
  });
  it('...with several candidates, prefers one whose region matches, else the global one, else the first', () => {
    const mena = { supplier: 'shop2topup', validation_category_id: '445', validation_fields: PLAYER, note_region: 'MENA' };
    const global = { supplier: 'shop2topup', validation_category_id: '491', validation_fields: PLAYER, note_region: null };
    const other = { supplier: 'shop2topup', validation_category_id: '999', validation_fields: PLAYER, note_region: 'Brazil' };
    assert.equal(crossSupplierValidation(bloodRow(), [other, global, mena]), mena);
    assert.equal(crossSupplierValidation(bloodRow(), [other, global]), global);
    assert.equal(crossSupplierValidation(bloodRow(), [other]), other);
  });
  it('no candidates at all: null', () => assert.equal(crossSupplierValidation(bloodRow(), []), null));

  it("resolvedValidation: no choice made falls back to the row's own (possibly null)", () => {
    assert.equal(resolvedValidation(null, s2Candidate, undefined), null);
    assert.deepEqual(resolvedValidation(fzCandidate, s2Candidate, undefined), fzCandidate);
  });
  it('...an explicit null forces "don\'t check", even with a candidate on offer', () => {
    assert.equal(resolvedValidation(fzCandidate, s2Candidate, null), null);
  });
  it('...picking a supplier by name uses that candidate', () => {
    assert.deepEqual(resolvedValidation(null, s2Candidate, 'shop2topup'), s2Candidate);
    assert.deepEqual(resolvedValidation(fzCandidate, s2Candidate, 'fazercards'), fzCandidate);
  });
  it('...a choice matching neither candidate (stale data) falls back to the row\'s own rather than guessing', () => {
    assert.deepEqual(resolvedValidation(fzCandidate, null, 'shop2topup'), fzCandidate);
  });

  it("regionDefaults, given an explicit validation source, checks with THAT supplier's category and form and locks by ITS region", () => {
    const d = regionDefaults(bloodRow(), s2Candidate);
    assert.deepEqual([d.idMode, d.validationCategoryId, d.locked, d.codes], ['supplier', '445', false, []]);
  });
  it('regionDefaults with validation explicitly null never checks IDs, whatever the row itself would have done on its own', () => {
    const d = regionDefaults(row(), null); // Free Fire MENA, which DOES validate on its own
    assert.deepEqual([d.idMode, d.locked], ['none', false]);
  });
  it("regionDefaults with no second argument behaves exactly as before: the row's own data", () => {
    assert.deepEqual(regionDefaults(row()), regionDefaults(row(), row()));
    assert.deepEqual(regionDefaults(bloodRow()), regionDefaults(bloodRow(), bloodRow()));
  });

  describe("buildImportPayload: validation_supplier is sent only when it differs from the packs' own supplier", () => {
    it('Blood Strike: FazerCards packs, Shop2Topup validation, its own category and lock state', () => {
      const r = buildImportPayload({ name: 'Blood Strike', imageUrl: null, regions: [choice(bloodRow(), priced(OFFERS), { validation: s2Candidate })] });
      assert.equal(r.ok, true);
      const region = r.payload.regions[0];
      assert.deepEqual(
        [region.supplier, region.validation_supplier, region.id_validation, region.validation_category_id, region.packs[0].region_locked],
        ['fazercards', 'shop2topup', 'supplier', '445', false]
      );
    });
    it('the default (no validation override) omits validation_supplier entirely: nothing changes for Free Fire, PUBG...', () => {
      const r = buildImportPayload({ name: 'X', imageUrl: null, regions: [choice(row(), priced(OFFERS))] });
      assert.equal(r.ok, true);
      assert.equal('validation_supplier' in r.payload.regions[0], false);
    });
    it('...and so does explicitly picking the SAME supplier back (own === chosen)', () => {
      const r = buildImportPayload({ name: 'X', imageUrl: null, regions: [choice(row(), priced(OFFERS), { validation: ownValidation(row()) })] });
      assert.equal('validation_supplier' in r.payload.regions[0], false);
    });
    it('explicitly choosing "don\'t check" omits validation_supplier too (mode is none, nothing to route)', () => {
      const r = buildImportPayload({ name: 'X', imageUrl: null, regions: [choice(row(), priced(OFFERS), { validation: null })] });
      assert.equal(r.payload.regions[0].id_validation, 'none');
      assert.equal('validation_supplier' in r.payload.regions[0], false);
    });
  });
});
