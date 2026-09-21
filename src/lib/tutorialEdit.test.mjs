// Run with: npm run test:unit
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MAX_TUTORIALS, canAddMore, forProvider, isDirty, moveItem, removeItem, toSaveItems } from './tutorialEdit.ts';

describe('reordering', () => {
  it('moves an item up or down, and never changes the original list', () => {
    const list = ['a', 'b', 'c', 'd'];
    assert.deepEqual(moveItem(list, 2, 1), ['a', 'c', 'b', 'd']);
    assert.deepEqual(moveItem(list, 0, 1), ['b', 'a', 'c', 'd']);
    assert.deepEqual(list, ['a', 'b', 'c', 'd']);
  });
  it('clamps at the ends (moving the first item up, or the last down, changes nothing)', () => {
    const list = ['a', 'b', 'c'];
    assert.deepEqual(moveItem(list, 0, -1), ['a', 'b', 'c']);
    assert.deepEqual(moveItem(list, 2, 3), ['a', 'b', 'c']);
    assert.deepEqual(moveItem(list, 9, 0), ['a', 'b', 'c']);
    assert.deepEqual(moveItem([], 0, 0), []);
  });
});

describe('removing and the limit', () => {
  it('removes one item by position', () => {
    assert.deepEqual(removeItem(['a', 'b', 'c'], 1), ['a', 'c']);
    assert.deepEqual(removeItem(['a'], 5), ['a']);
  });
  it('at most 10 per payment method', () => {
    assert.equal(MAX_TUTORIALS, 10);
    assert.equal(canAddMore(9), true);
    assert.equal(canAddMore(10), false);
    assert.equal(canAddMore(8, 3), false);
  });
});

describe('what changed', () => {
  const saved = ['i1', 'i2', 'i3'];
  it('the same images in the same order is not a change', () => assert.equal(isDirty(saved, [{ id: 'i1' }, { id: 'i2' }, { id: 'i3' }]), false));
  it('a reorder, a removal and an addition each are', () => {
    assert.equal(isDirty(saved, [{ id: 'i2' }, { id: 'i1' }, { id: 'i3' }]), true);
    assert.equal(isDirty(saved, [{ id: 'i1' }, { id: 'i3' }]), true);
    assert.equal(isDirty(saved, [{ id: 'i1' }, { id: 'i2' }, { id: 'i3' }, { id: null }]), true);
  });
  it('moving something and moving it back is not a change', () => {
    const moved = moveItem(moveItem([{ id: 'i1' }, { id: 'i2' }, { id: 'i3' }], 0, 2), 2, 0);
    assert.equal(isDirty(saved, moved), false);
  });
  it('nothing saved and nothing staged is clean', () => assert.equal(isDirty([], []), false));
});

describe('the save payload', () => {
  it('existing images go by id (in their new order), new ones by url and file path', () => {
    const out = toSaveItems([{ id: 'i2', url: 'u2', path: 'p2' }, { id: null, url: 'https://x/n.jpg', path: 'tutorials/n.jpg' }, { id: 'i1', url: 'u1', path: 'p1' }]);
    assert.deepEqual(out, [{ id: 'i2' }, { id: null, image_url: 'https://x/n.jpg', storage_path: 'tutorials/n.jpg' }, { id: 'i1' }]);
  });
  it('a new image that was never uploaded cannot be saved', () => {
    assert.throws(() => toSaveItems([{ id: null, url: null, path: null }]), /tutorial_not_uploaded/);
  });
});

describe('per provider', () => {
  it('keeps only that provider\'s images, in order', () => {
    const rows = [{ provider: 'telebirr', n: 1 }, { provider: 'cbe', n: 2 }, { provider: 'telebirr', n: 3 }];
    assert.deepEqual(forProvider(rows, 'telebirr').map((r) => r.n), [1, 3]);
    assert.deepEqual(forProvider(rows, 'cbe').map((r) => r.n), [2]);
    assert.deepEqual(forProvider(rows, 'mpesa'), []);
  });
});
