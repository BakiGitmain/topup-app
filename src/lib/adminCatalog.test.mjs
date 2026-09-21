// Run with: npm run test:unit
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  catalogErrorMessage, checkLock, filterCounts, filterProducts, hiddenReasonText, isLivePack, lockLabel, lockState,
  missingUpstreamCount, parseRegionCodes, productStatus, sectionsForEditor, switchOnBlocker,
} from './adminCatalog.ts';

const pack = (o = {}) => ({ is_active: true, region_id: null, ...o });
const product = (o = {}) => ({ name: 'Free Fire', tagline: 'Diamonds', is_active: true, options: [pack()], regions: [], ...o });

describe('productStatus: the same rule the shop uses', () => {
  it('on sale: product on and at least one pack on', () => {
    assert.deepEqual(productStatus(product()), { status: 'on_sale', reason: null });
  });
  it('product off -> hidden, even with packs on', () => {
    assert.deepEqual(productStatus(product({ is_active: false })), { status: 'hidden', reason: 'product_off' });
  });
  it('product on but every pack off -> hidden (customers would see an empty shell)', () => {
    assert.deepEqual(productStatus(product({ options: [pack({ is_active: false })] })), { status: 'hidden', reason: 'no_packs_on' });
    assert.deepEqual(productStatus(product({ options: [] })), { status: 'hidden', reason: 'no_packs_on' });
  });
  it('a pack in a region that is off does not count', () => {
    const p = product({ options: [pack({ region_id: 'r1' })], regions: [{ id: 'r1', is_active: false }] });
    assert.deepEqual(productStatus(p), { status: 'hidden', reason: 'region_off' });
  });
  it('a pack in a region that is on does', () => {
    const p = product({ options: [pack({ region_id: 'r1' })], regions: [{ id: 'r1', is_active: true }] });
    assert.equal(productStatus(p).status, 'on_sale');
  });
  it('one live pack among dead ones is enough', () => {
    const p = product({ options: [pack({ is_active: false }), pack({ region_id: 'r2' }), pack({ region_id: 'r1' })], regions: [{ id: 'r1', is_active: true }, { id: 'r2', is_active: false }] });
    assert.equal(productStatus(p).status, 'on_sale');
  });
  it('a pack pointing at a region we cannot see is not live', () => {
    assert.equal(isLivePack(pack({ region_id: 'ghost' }), []), false);
  });
  it('every hidden reason has plain wording', () => {
    for (const r of ['product_off', 'no_packs_on', 'region_off']) assert.ok(hiddenReasonText(r).length > 10);
  });
});

describe('filters and search', () => {
  const list = [
    product({ name: 'Free Fire' }),
    product({ name: 'PUBG Mobile', tagline: 'UC', is_active: false }),
    product({ name: 'Mobile Legends', tagline: 'Diamonds', options: [pack({ is_active: false })] }),
    product({ name: 'Roblox', tagline: 'Robux' }),
  ];
  it('All / On sale / Hidden', () => {
    assert.deepEqual(filterProducts(list, 'all', '').map((p) => p.name), ['Free Fire', 'PUBG Mobile', 'Mobile Legends', 'Roblox']);
    assert.deepEqual(filterProducts(list, 'on_sale', '').map((p) => p.name), ['Free Fire', 'Roblox']);
    assert.deepEqual(filterProducts(list, 'hidden', '').map((p) => p.name), ['PUBG Mobile', 'Mobile Legends']);
  });
  it('search matches name or short description, ignoring case and spaces at the ends', () => {
    assert.deepEqual(filterProducts(list, 'all', '  MOBILE ').map((p) => p.name), ['PUBG Mobile', 'Mobile Legends']);
    assert.deepEqual(filterProducts(list, 'all', 'robux').map((p) => p.name), ['Roblox']);
    assert.deepEqual(filterProducts(list, 'all', 'nothing like this'), []);
  });
  it('search and filter combine', () => {
    assert.deepEqual(filterProducts(list, 'hidden', 'mobile').map((p) => p.name), ['PUBG Mobile', 'Mobile Legends']);
    assert.deepEqual(filterProducts(list, 'on_sale', 'mobile'), []);
  });
  it('the counts follow the search and always add up', () => {
    assert.deepEqual(filterCounts(list, ''), { all: 4, on_sale: 2, hidden: 2 });
    assert.deepEqual(filterCounts(list, 'mobile'), { all: 2, on_sale: 0, hidden: 2 });
    for (const q of ['', 'a', 'zzz']) { const c = filterCounts(list, q); assert.equal(c.on_sale + c.hidden, c.all); }
  });
  it('an empty list is fine', () => {
    assert.deepEqual(filterCounts([], ''), { all: 0, on_sale: 0, hidden: 0 });
    assert.deepEqual(filterProducts([], 'hidden', 'x'), []);
  });
});

describe('supplier flags', () => {
  it('counts packs missing at the supplier (they stay on sale, so admins must see them)', () => {
    assert.equal(missingUpstreamCount({ options: [pack({ missing_upstream: true }), pack(), pack({ missing_upstream: true })] }), 2);
    assert.equal(missingUpstreamCount({ options: [pack()] }), 0);
  });
});

describe('region codes', () => {
  it('normalizes: upper-case, de-duplicated, sorted', () => {
    assert.deepEqual(parseRegionCodes('me, BR ,me'), { codes: ['BR', 'ME'], invalid: [] });
    assert.deepEqual(parseRegionCodes('sg my; ph'), { codes: ['MY', 'PH', 'SG'], invalid: [] });
    assert.deepEqual(parseRegionCodes(''), { codes: [], invalid: [] });
  });
  it('reports junk instead of guessing', () => {
    assert.deepEqual(parseRegionCodes('me, <b>, x'.replace('x', 'ok')), { codes: ['ME', 'OK'], invalid: ['<b>'] });
    assert.equal(parseRegionCodes('a'.repeat(17)).invalid.length, 1);
  });
  it('lock state and wording', () => {
    assert.equal(lockState({ region_locked: false, account_region_codes: [] }), 'open');
    assert.equal(lockState({ region_locked: true, account_region_codes: ['ME'] }), 'locked');
    assert.equal(lockState({ region_locked: true, account_region_codes: [] }), 'locked_no_codes');
    assert.equal(lockLabel({ region_locked: true, account_region_codes: ['ME', 'BR'] }), 'ME, BR accounts only');
    assert.match(lockLabel({ region_locked: true, account_region_codes: [] }), /no account regions/);
  });
  it('a locked pack with no regions cannot be switched on', () => {
    assert.match(switchOnBlocker({ region_locked: true, account_region_codes: [] }), /can't be switched on/);
    assert.equal(switchOnBlocker({ region_locked: true, account_region_codes: ['ME'] }), null);
    assert.equal(switchOnBlocker({ region_locked: false, account_region_codes: [] }), null);
  });
  it('checkLock: what the lock editor may save', () => {
    assert.deepEqual(checkLock(true, 'me, br'), { ok: true, region_locked: true, account_region_codes: ['BR', 'ME'] });
    assert.deepEqual(checkLock(false, ''), { ok: true, region_locked: false, account_region_codes: [] });
    assert.equal(checkLock(false, 'ME').ok, false);
    assert.equal(checkLock(true, '<x>').ok, false);
    assert.deepEqual(checkLock(true, ''), { ok: true, region_locked: true, account_region_codes: [] });
  });
});

describe('sectionsForEditor', () => {
  const R = (id, sort_order, label = id) => ({ id, sort_order, label });
  const P = (id, o = {}) => ({ id, group_label: null, region_id: 'r1', sort_order: 100, price: 10, label: id, ...o });
  it('by region, then by group label, cheapest first', () => {
    const s = sectionsForEditor(
      [P('m1', { group_label: 'Membership', sort_order: 20 }), P('d2', { group_label: 'Diamonds', sort_order: 10, price: 40 }), P('d1', { group_label: 'Diamonds', sort_order: 10, price: 20 }), P('b1', { region_id: 'r2' })],
      [R('r2', 2), R('r1', 1)]
    );
    assert.deepEqual(s.map((x) => x.region.id), ['r1', 'r2']);
    assert.deepEqual(s[0].groups.map((g) => g.label), ['Diamonds', 'Membership']);
    assert.deepEqual(s[0].groups[0].packs.map((p) => p.id), ['d1', 'd2']);
  });
  it('packs with no region (older products) come last, in their own section', () => {
    const s = sectionsForEditor([P('a', { region_id: null }), P('b')], [R('r1', 1)]);
    assert.deepEqual(s.map((x) => x.region?.id ?? null), ['r1', null]);
  });
  it('a pack pointing at a region that no longer exists is not lost', () => {
    const s = sectionsForEditor([P('a', { region_id: 'gone' })], []);
    assert.equal(s.length, 1);
    assert.equal(s[0].groups[0].packs[0].id, 'a');
  });
  it('empty in, empty out; input not modified', () => {
    assert.deepEqual(sectionsForEditor([], []), []);
    const input = [P('b', { price: 9 }), P('a', { price: 1 })];
    sectionsForEditor(input, [R('r1', 1)]);
    assert.equal(input[0].id, 'b');
  });
});

describe('catalogErrorMessage', () => {
  const m = (message) => catalogErrorMessage({ message });
  it('explains the refusals admins can hit', () => {
    assert.match(m('violates check constraint "product_options_locked_needs_codes_to_be_live"'), /account regions/);
    assert.match(m('new row for relation "product_options" violates check constraint "product_options_codes_need_lock"'), /region lock/);
    assert.match(m('violates check constraint "product_options_old_price_check"'), /old price must be higher/);
    assert.match(m('violates check constraint "product_options_price_check"'), /above Br 0/);
    assert.match(m('violates check constraint "product_options_region_codes_safe"'), /short/);
    assert.match(m('new row violates row-level security policy'), /admin access/);
    assert.match(m('not_updated'), /wasn't saved/, 'a write that changed no row (blocked by the row rules) is explained');
  });
  it('explains the refusals of an import', () => {
    assert.match(catalogErrorMessage({ message: 'already_imported', details: '110 Diamonds' }), /"110 Diamonds" was already imported/);
    assert.match(m('already_imported'), /A pack was already imported/);
    assert.match(m('offer_name_required'), /no supplier name/);
    assert.match(m('first_purchase_only_not_sellable'), /first-purchase-only/);
    assert.match(m('blocked_supplier_category'), /login or password/);
    assert.match(catalogErrorMessage({ message: 'import_invalid', details: 'price' }), /refused \(price\)/);
    assert.match(m('import_invalid'), /invalid data/);
  });
  it('null for anything else', () => {
    for (const e of [null, undefined, {}, { message: 5 }, { message: 'boom' }]) assert.equal(catalogErrorMessage(e), null);
  });
});
