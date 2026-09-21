// Run with: npm run test:unit
// The batch-save diff: tapping a switch changes only local state; Save sends exactly what differs, in one request.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { countChanges, describeFailures, emptyState, parseBatchFailures, pendingChanges, prune, setLocal, valueOf } from './manageCatalog.ts';

const P1 = '11111111-1111-1111-1111-111111111111';
const P2 = '22222222-2222-2222-2222-222222222222';
const R1 = '33333333-3333-3333-3333-333333333333';
const O1 = '44444444-4444-4444-4444-444444444444';
const O2 = '55555555-5555-5555-5555-555555555555';
const saved = () => ({ products: { [P1]: false, [P2]: true }, regions: { [R1]: false }, options: { [O1]: false, [O2]: true } });

describe('valueOf / setLocal', () => {
  it('shows the saved value until a switch is tapped, then the local one', () => {
    let local = emptyState();
    assert.equal(valueOf(saved(), local, 'products', P1), false);
    local = setLocal(saved(), local, 'products', P1, true);
    assert.equal(valueOf(saved(), local, 'products', P1), true);
    assert.equal(valueOf(saved(), local, 'products', P2), true, 'other switches are untouched');
  });
  it('tapping a switch does not touch the saved state (nothing is sent)', () => {
    const s = saved();
    const before = JSON.stringify(s);
    setLocal(s, emptyState(), 'options', O1, true);
    assert.equal(JSON.stringify(s), before);
  });
  it('flipping a switch back to its saved value removes the pending change', () => {
    let local = setLocal(saved(), emptyState(), 'regions', R1, true);
    assert.equal(countChanges(pendingChanges(saved(), local)), 1);
    local = setLocal(saved(), local, 'regions', R1, false);
    assert.equal(countChanges(pendingChanges(saved(), local)), 0);
    assert.deepEqual(local.regions, {});
  });
  it('an unknown id reads as off', () => assert.equal(valueOf(saved(), emptyState(), 'options', 'nope'), false));
});

describe('pendingChanges (the request body)', () => {
  it('is empty when nothing was tapped', () => {
    assert.deepEqual(pendingChanges(saved(), emptyState()), { products: [], regions: [], options: [] });
    assert.equal(countChanges(pendingChanges(saved(), emptyState())), 0);
  });
  it('holds exactly the switches that differ, grouped by kind', () => {
    let local = emptyState();
    local = setLocal(saved(), local, 'products', P1, true);
    local = setLocal(saved(), local, 'products', P2, false);
    local = setLocal(saved(), local, 'options', O2, false);
    local = setLocal(saved(), local, 'options', O1, false); // same as saved: not a change
    const changes = pendingChanges(saved(), local);
    assert.deepEqual(changes.products, [{ id: P1, is_active: true }, { id: P2, is_active: false }]);
    assert.deepEqual(changes.regions, []);
    assert.deepEqual(changes.options, [{ id: O2, is_active: false }]);
    assert.equal(countChanges(changes), 3);
  });
  it('never sends a change for something that no longer exists', () => {
    const local = { products: { gone: true }, regions: {}, options: {} };
    assert.equal(countChanges(pendingChanges(saved(), local)), 0);
  });
  it('is stable: the same taps in any order give the same request', () => {
    const a = setLocal(saved(), setLocal(saved(), emptyState(), 'products', P1, true), 'options', O2, false);
    const b = setLocal(saved(), setLocal(saved(), emptyState(), 'options', O2, false), 'products', P1, true);
    assert.deepEqual(pendingChanges(saved(), a), pendingChanges(saved(), b));
  });
  it('one request carries every kind at once', () => {
    let local = emptyState();
    for (const [kind, id] of [['products', P1], ['regions', R1], ['options', O1]]) local = setLocal(saved(), local, kind, id, true);
    assert.equal(countChanges(pendingChanges(saved(), local)), 3);
  });
});

describe('prune (after a save or a reload)', () => {
  it('drops entries that now match what is saved, keeps the rest', () => {
    const local = { products: { [P1]: true, [P2]: true }, regions: {}, options: { gone: false } };
    // the server now has P1 on (saved), P2 still on: P1's pending change is done; P2 was never a change; 'gone' vanished.
    const nowSaved = { products: { [P1]: true, [P2]: true }, regions: {}, options: {} };
    assert.deepEqual(prune(nowSaved, local), emptyState());
    const stillPending = prune(saved(), { products: { [P1]: true }, regions: {}, options: {} });
    assert.deepEqual(stillPending.products, { [P1]: true });
  });
});

describe('a refused batch', () => {
  const failure = (list) => ({ message: 'active_changes_failed', details: JSON.stringify(list) });
  it('reads exactly which items were refused, and why', () => {
    const list = [{ kind: 'options', id: O1, reason: 'new row violates check constraint "product_options_locked_needs_codes_to_be_live"' }, { kind: 'products', id: 'x', reason: 'not_found' }];
    assert.deepEqual(parseBatchFailures(failure(list)), list);
  });
  it('is null for any other error, so a network error is never mistaken for a refusal', () => {
    for (const e of [null, undefined, {}, { message: 'boom' }, { message: 5 }, new Error('fetch failed')]) assert.equal(parseBatchFailures(e), null);
  });
  it('copes with garbage details (an empty list, not a crash)', () => {
    assert.deepEqual(parseBatchFailures({ message: 'active_changes_failed', details: 'not json' }), []);
    assert.deepEqual(parseBatchFailures({ message: 'active_changes_failed', details: '{"a":1}' }), []);
    assert.deepEqual(parseBatchFailures({ message: 'active_changes_failed', details: '[{"kind":"hax","id":"1"},{"kind":"options","id":5}]' }), []);
    assert.deepEqual(parseBatchFailures({ message: 'active_changes_failed' }), []);
  });
  it('names each refused pack in words the admin can act on', () => {
    const lines = describeFailures(
      [{ kind: 'options', id: O1, reason: 'violates "product_options_locked_needs_codes_to_be_live"' }, { kind: 'regions', id: R1, reason: 'not_found' }, { kind: 'products', id: P1, reason: 'whatever' }, { kind: 'options', id: 'zz', reason: '' }],
      { [O1]: '110 Diamonds', [R1]: 'MENA', [P1]: 'Free Fire' }
    );
    assert.match(lines[0], /^Pack "110 Diamonds" wasn't saved: it is region-locked but has no account regions/);
    assert.match(lines[1], /^Region "MENA" wasn't saved: it no longer exists/);
    assert.match(lines[2], /^Product "Free Fire" wasn't saved: the database refused it/);
    assert.match(lines[3], /"zz"/, 'an unknown id is shown rather than hidden');
    assert.equal(lines.length, 4, 'one line per refused item, none dropped');
  });
});
