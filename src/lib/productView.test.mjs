// Run with: npm run test:unit
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { categoryFilter, describeFields, effectiveCategoryId, groupPackages, humanizeKey, initialRegionId, needsRegionChips, packagesInRegion, sortRegions } from './productView.ts';
import { packageState } from './regionMatch.ts';

const pkg = (id, o = {}) => ({ id, label: id, groupLabel: null, price: 10, oldPrice: null, regionId: 'r1', regionLocked: false, accountRegionCodes: [], sortOrder: 100, ...o });
const region = (id, o = {}) => ({ id, code: id, label: id, buyerFields: [], idValidation: 'supplier', sortOrder: 100, ...o });

describe('groupPackages', () => {
  it('groups by label, in order of first appearance, cheapest first inside', () => {
    const groups = groupPackages([
      pkg('m1', { groupLabel: 'Membership', sortOrder: 20, price: 50 }),
      pkg('d2', { groupLabel: 'Diamonds', sortOrder: 10, price: 40 }),
      pkg('d1', { groupLabel: 'Diamonds', sortOrder: 10, price: 20 }),
    ]);
    assert.deepEqual(groups.map((g) => g.label), ['Diamonds', 'Membership']);
    assert.deepEqual(groups[0].packages.map((p) => p.id), ['d1', 'd2']);
  });
  it('one unlabeled group when nothing has a label', () => {
    const groups = groupPackages([pkg('a'), pkg('b')]);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].label, null);
  });
  it('blank labels count as no label', () => {
    assert.equal(groupPackages([pkg('a', { groupLabel: '   ' }), pkg('b', { groupLabel: null })]).length, 1);
  });
  it('does not modify its input and handles empty', () => {
    const input = [pkg('b', { price: 9 }), pkg('a', { price: 1 })];
    groupPackages(input);
    assert.equal(input[0].id, 'b');
    assert.deepEqual(groupPackages([]), []);
  });
});

describe('regions', () => {
  it('chips only when there is a choice', () => {
    assert.equal(needsRegionChips([]), false);
    assert.equal(needsRegionChips([region('a')]), false);
    assert.equal(needsRegionChips([region('a'), region('b')]), true);
  });
  it('sorted by sort order then label', () => {
    assert.deepEqual(sortRegions([region('z', { sortOrder: 1 }), region('a', { sortOrder: 2 }), region('b', { sortOrder: 2 })]).map((r) => r.id), ['z', 'a', 'b']);
  });
  it('starts on the region of the pre-selected package, else the first', () => {
    const regions = [region('r1', { sortOrder: 1 }), region('r2', { sortOrder: 2 })];
    const packages = [pkg('p1', { regionId: 'r1' }), pkg('p2', { regionId: 'r2' })];
    assert.equal(initialRegionId(regions, packages, 'p2'), 'r2');
    assert.equal(initialRegionId(regions, packages, 'nope'), 'r1');
    assert.equal(initialRegionId(regions, packages, null), 'r1');
    assert.equal(initialRegionId([], [], null), null);
  });
  it('packagesInRegion; a legacy product (no regions) uses region null', () => {
    const packages = [pkg('a', { regionId: 'r1' }), pkg('b', { regionId: 'r2' }), pkg('c', { regionId: null })];
    assert.deepEqual(packagesInRegion(packages, 'r1').map((p) => p.id), ['a']);
    assert.deepEqual(packagesInRegion(packages, null).map((p) => p.id), ['c']);
  });
});

describe('describing stored IDs', () => {
  it('humanizeKey', () => {
    assert.equal(humanizeKey('player_id'), 'Player ID');
    assert.equal(humanizeKey('server'), 'Server');
    assert.equal(humanizeKey('zone_id'), 'Zone ID');
    assert.equal(humanizeKey(''), '');
  });
  it('multi-field orders list every field', () => {
    assert.deepEqual(describeFields({ fields: { player_id: '1', server_id: '2' }, account_id: '1' }), [['Player ID', '1'], ['Server ID', '2']]);
  });
  it('old single-ID orders still show', () => {
    assert.deepEqual(describeFields({ account_id: '99' }), [['Game ID', '99']]);
  });
  it('nothing to show', () => {
    for (const d of [null, undefined, {}, { fields: {} }, { fields: { a: {} } }]) assert.deepEqual(describeFields(d), [], JSON.stringify(d));
  });
});

describe('packageState (what a package offers, given the ID check)', () => {
  const ME = { regionLocked: true, accountRegionCodes: ['ME'] };
  const BR = { regionLocked: true, accountRegionCodes: ['BR'] };
  const OPEN = { regionLocked: false, accountRegionCodes: [] };
  const sup = (validated, accountRegion) => ({ idMode: 'supplier', validated, accountRegion });

  it('open packages are always ok', () => {
    for (const ctx of [sup(false, null), sup(true, 'ME'), { idMode: 'tick', validated: false, accountRegion: null }, { idMode: 'none', validated: false, accountRegion: null }])
      assert.equal(packageState(OPEN, ctx), 'ok');
  });
  it('a locked package waits for the check', () => assert.equal(packageState(ME, sup(false, null)), 'pending'));
  it('after the check: match -> ok, other region -> wrong_region', () => {
    assert.equal(packageState(ME, sup(true, 'ME')), 'ok');
    assert.equal(packageState(BR, sup(true, 'ME')), 'wrong_region');
    assert.equal(packageState(ME, sup(true, ' me ')), 'ok');
  });
  it('checked but the supplier gave no region -> region_unknown (never sold)', () => {
    assert.equal(packageState(ME, sup(true, null)), 'region_unknown');
  });
  it('a locked package with no codes is unavailable', () => {
    assert.equal(packageState({ regionLocked: true, accountRegionCodes: [] }, sup(true, 'ME')), 'unavailable');
    assert.equal(packageState({ regionLocked: true, accountRegionCodes: [] }, sup(false, null)), 'unavailable');
  });
  it('where nothing can verify the account, a locked package is unavailable', () => {
    assert.equal(packageState(ME, { idMode: 'tick', validated: false, accountRegion: null }), 'unavailable');
    assert.equal(packageState(ME, { idMode: 'none', validated: false, accountRegion: null }), 'unavailable');
  });
});

// ---------------------------------------------------------------- categories
const cat = (id, sortOrder, label = id) => ({ id, label, sortOrder });
const inCat = (id, categoryId, o = {}) => pkg(id, { categoryId, imageUrl: null, ...o });
const UC = cat('uc', 1, 'UC');
const COINS = cat('coins', 2, 'Coins');
const MEMBERSHIP = cat('member', 3, 'Membership');
const ids = (list) => list.map((p) => p.id);

describe('categoryFilter: when the pills show', () => {
  const packs = [inCat('a', 'uc'), inCat('b', 'coins'), inCat('c', 'member')];
  it('zero categories: no pills, every pack shown', () => {
    const f = categoryFilter(packs, [], null);
    assert.deepEqual([f.pills, f.activeId, ids(f.visible)], [[], null, ['a', 'b', 'c']]);
  });
  it('ONE category: no pills, every pack shown', () => {
    const f = categoryFilter([inCat('a', 'uc'), inCat('b', 'uc')], [UC], null);
    assert.deepEqual([f.pills, f.activeId, ids(f.visible)], [[], null, ['a', 'b']]);
  });
  it('two or more categories: pills in sort order, and the FIRST is selected by default', () => {
    const f = categoryFilter(packs, [MEMBERSHIP, UC, COINS], null);
    assert.deepEqual(f.pills.map((c) => c.id), ['uc', 'coins', 'member']);
    assert.equal(f.activeId, 'uc');
    assert.deepEqual(ids(f.visible), ['a']);
  });
  it('sort order decides "first", not the order the rows arrived in', () => {
    assert.equal(categoryFilter(packs, [cat('z', 5), cat('y', 1), cat('x', 3)].map((c, i) => ({ ...c, id: ['uc', 'coins', 'member'][i] })), null).activeId, 'coins');
  });
  it('ties in sort order fall back to the label', () => {
    const f = categoryFilter([inCat('a', 'b'), inCat('b', 'a')], [cat('b', 1, 'Beta'), cat('a', 1, 'Alpha')], null);
    assert.deepEqual(f.pills.map((c) => c.label), ['Alpha', 'Beta']);
  });
});

describe('categoryFilter: tapping a pill', () => {
  const packs = [inCat('a', 'uc'), inCat('b', 'uc'), inCat('c', 'coins')];
  it("shows only that category's packs", () => {
    const f = categoryFilter(packs, [UC, COINS], 'coins');
    assert.equal(f.activeId, 'coins');
    assert.deepEqual(ids(f.visible), ['c']);
    assert.deepEqual(ids(categoryFilter(packs, [UC, COINS], 'uc').visible), ['a', 'b']);
  });
  it('an unknown or stale choice falls back to the first pill', () => {
    for (const bad of ['gone', '', null, undefined]) assert.equal(categoryFilter(packs, [UC, COINS], bad).activeId, 'uc');
  });
  it('every pack appears under exactly one pill (none lost, none doubled)', () => {
    const f1 = categoryFilter(packs, [UC, COINS], 'uc');
    const f2 = categoryFilter(packs, [UC, COINS], 'coins');
    assert.deepEqual([...ids(f1.visible), ...ids(f2.visible)].sort(), ['a', 'b', 'c']);
  });
});

describe('categoryFilter: never hides a pack, never shows an empty tab', () => {
  it('a pack with no category is shown under the first category', () => {
    const packs = [inCat('a', 'uc'), inCat('loose', null), inCat('c', 'coins')];
    assert.deepEqual(ids(categoryFilter(packs, [UC, COINS], 'uc').visible), ['a', 'loose']);
    assert.deepEqual(ids(categoryFilter(packs, [UC, COINS], 'coins').visible), ['c']);
  });
  it('a pack pointing at a category that is not in the list is treated the same', () => {
    assert.equal(effectiveCategoryId({ categoryId: 'deleted' }, [UC, COINS]), 'uc');
    assert.equal(effectiveCategoryId({ categoryId: null }, []), null);
    assert.equal(effectiveCategoryId({ categoryId: 'uc' }, [COINS, UC]), 'uc');
  });
  it('a category with nothing to buy in this region gets no pill, and one left means no row', () => {
    const packs = [inCat('a', 'uc'), inCat('b', 'uc')]; // this region has only UC packs
    const f = categoryFilter(packs, [UC, COINS, MEMBERSHIP], null);
    assert.deepEqual([f.pills, ids(f.visible)], [[], ['a', 'b']]);
    const two = categoryFilter([inCat('a', 'uc'), inCat('c', 'member')], [UC, COINS, MEMBERSHIP], null);
    assert.deepEqual(two.pills.map((c) => c.id), ['uc', 'member']);
  });
  it('switching region: a pill that exists only in the old region is replaced by the first of the new one', () => {
    const regionB = [inCat('x', 'uc'), inCat('y', 'coins')];
    assert.equal(categoryFilter(regionB, [UC, COINS, MEMBERSHIP], 'member').activeId, 'uc');
  });
  it('no packs at all: nothing breaks', () => {
    assert.deepEqual(categoryFilter([], [UC, COINS], null), { pills: [], activeId: null, visible: [] });
  });
  it('does not change the packs it is given', () => {
    const packs = [inCat('a', 'uc'), inCat('b', 'coins')];
    const copy = JSON.stringify(packs);
    categoryFilter(packs, [UC, COINS], 'coins');
    assert.equal(JSON.stringify(packs), copy);
  });
});
