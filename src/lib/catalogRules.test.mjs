// Run with: npm run test:unit
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { purchasablePackages, safeImageUrl, tileLetter } from './catalogRules.ts';

describe('safeImageUrl', () => {
  it('accepts http(s) addresses and trims them', () => {
    assert.equal(safeImageUrl('https://x.supabase.co/storage/v1/object/public/product-art/ff.png'), 'https://x.supabase.co/storage/v1/object/public/product-art/ff.png');
    assert.equal(safeImageUrl('  http://a.b/c.jpg '), 'http://a.b/c.jpg');
  });
  it('rejects everything else, so the letter tile shows', () => {
    for (const v of [null, undefined, '', '   ', 42, {}, 'ff.png', 'javascript:alert(1)', 'data:image/png;base64,AAAA', 'file:///etc/passwd', 'https://', 'https://a b.com/x', 'ftp://a.b/c']) {
      assert.equal(safeImageUrl(v), null, String(v));
    }
  });
});

describe('tileLetter', () => {
  it('first letter, upper-cased', () => {
    assert.equal(tileLetter('free fire'), 'F');
    assert.equal(tileLetter('  pubg mobile'), 'P');
    assert.equal(tileLetter('ሰላም'), 'ሰ');
  });
  it('never splits an emoji or a surrogate pair in half', () => {
    assert.equal(tileLetter('🎮 Games'), '🎮');
    assert.equal(tileLetter('𝓕ire'), '𝓕');
  });
  it('a missing name still gives something to draw', () => {
    for (const v of [null, undefined, '', '   ', 5]) assert.equal(tileLetter(v), '?', String(v));
  });
});

describe('purchasablePackages: what the shop may show', () => {
  const on = (id, region_id = null) => ({ id, is_active: true, region_id });
  const off = (id, region_id = null) => ({ id, is_active: false, region_id });
  const regions = [{ id: 'r-on', is_active: true }, { id: 'r-off', is_active: false }];

  it('only packages that are on', () => {
    assert.deepEqual(purchasablePackages([on('a'), off('b')], regions).map((p) => p.id), ['a']);
  });
  it('a product whose packages are all off shows nothing (the product is then hidden)', () => {
    assert.equal(purchasablePackages([off('a'), off('b')], regions).length, 0);
  });
  it('a package in a region that is on is shown', () => {
    assert.deepEqual(purchasablePackages([on('a', 'r-on')], regions).map((p) => p.id), ['a']);
  });
  it('a package in a region that is OFF is hidden, since the purchase would be refused', () => {
    assert.equal(purchasablePackages([on('a', 'r-off')], regions).length, 0);
  });
  it('a package pointing at a region we cannot see is hidden too', () => {
    assert.equal(purchasablePackages([on('a', 'r-missing')], regions).length, 0);
    assert.equal(purchasablePackages([on('a', 'r-on')], []).length, 0);
    assert.equal(purchasablePackages([on('a', 'r-on')], null).length, 0);
  });
  it('a package with no region is never affected by regions', () => {
    assert.deepEqual(purchasablePackages([on('a')], []).map((p) => p.id), ['a']);
    assert.deepEqual(purchasablePackages([on('a')], null).map((p) => p.id), ['a']);
  });
  it('null or missing lists are just empty', () => {
    assert.deepEqual(purchasablePackages(null, regions), []);
    assert.deepEqual(purchasablePackages(undefined, undefined), []);
  });
  it('mixed regions: only the live ones survive', () => {
    const got = purchasablePackages([on('a', 'r-on'), on('b', 'r-off'), on('c'), off('d', 'r-on')], regions);
    assert.deepEqual(got.map((p) => p.id), ['a', 'c']);
  });
  it('does not modify its input', () => {
    const input = [on('a'), off('b')];
    purchasablePackages(input, regions);
    assert.equal(input.length, 2);
  });
});
