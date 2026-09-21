// Run with: npm run test:unit
// Source guards for two layout fixes that were checked visually at 320/360/411/500pt. The pixels can't be tested here,
// so these pin the properties that make them work and stop them being undone by accident.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');

describe('ProductTile (the one shared game tile: home sections, search, category screen)', () => {
  const src = read('./market/ProductTile.tsx');
  it('shows the artwork whole in a fixed-size rounded square: contained, never cropped or stretched', () => {
    assert.match(src, /contentFit="contain"/);
    assert.doesNotMatch(src, /contentFit="cover"/);
    assert.doesNotMatch(src, /contentFit="fill"/);
    assert.match(src, /styles\.art, \{ width: art, height: art,/);
    assert.match(src, /borderRadius: 14/);
  });
  it('has TWO arrangements picked by its own width: a ROW (picture left, name right, centred) where there is room, a STACK (picture over name) where there is not', () => {
    assert.match(src, /tileLayout\(width\)/);
    assert.match(src, /row: \{ \.\.\.box, flexDirection: 'row', alignItems: 'center'/);
    assert.match(src, /nameRow: \{ flex: 1/);
    assert.match(src, /stack: \{ \.\.\.box, alignItems: 'center'/);
    assert.match(src, /nameStack: \{ alignSelf: 'stretch', textAlign: 'center'/);
  });
  it('has no scrim or overlaid text any more (the name is beside the picture, not on it)', () => {
    assert.doesNotMatch(src, /LinearGradient/);
    assert.doesNotMatch(src, /scrim/);
  });
  it('has one place where tiles are drawn: the grid and the loading skeleton both use it and the shared sizes', () => {
    const grid = read('./market/ProductGrid.tsx');
    const skeleton = read('./market/CatalogSkeleton.tsx');
    assert.match(grid, /<ProductTile /);
    assert.match(skeleton, /tileHeight\(tile\)/);
    for (const file of ['../app/(customer)/shop.tsx', '../app/category/[id].tsx']) {
      assert.doesNotMatch(read(file), /<ProductTile/, `${file} must go through ProductGrid, not draw its own tiles`);
    }
  });
});

describe('PillGroup (the admin category selector)', () => {
  const src = read('./ui/PillGroup.tsx');
  it('wraps onto more rows instead of scrolling or squeezing', () => {
    assert.match(src, /flexWrap: 'wrap'/);
    assert.doesNotMatch(src, /ScrollView/);
    assert.doesNotMatch(src, /horizontal/);
  });
  it('keeps a gap between pills in BOTH directions', () => {
    assert.match(src, /columnGap: spacing\.sm/);
    assert.match(src, /rowGap: spacing\.sm/);
  });
  it('gives every pill its own outline (an unselected pill on a grey card was invisible) and a 44pt target', () => {
    assert.match(src, /borderWidth: 1/);
    assert.match(src, /minHeight: 44/);
  });
  it('cuts a label too long for the screen inside its own pill', () => {
    assert.match(src, /maxWidth: '100%'/);
    assert.match(src, /numberOfLines=\{1\}/);
    assert.match(src, /ellipsizeMode="tail"/);
  });
  it('is what the pack editor uses for its category choice', () => {
    const editor = read('./admin/PackEditor.tsx');
    assert.match(editor, /<PillGroup/);
    assert.doesNotMatch(editor, /<Chips/);
  });
});
