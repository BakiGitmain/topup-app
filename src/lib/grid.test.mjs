// Run with: npm run test:unit
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';

import {
  GRID_GAP, HOME_COLUMNS, ROW_TILE_MIN_WIDTH, STACK_NAME_LINES, STACK_NAME_LINE_HEIGHT, STACK_PAD, TILE_ART, TILE_HEIGHT,
  gridColumns, sectionLimit, stackArt, tileHeight, tileLayout, tileWidth,
} from './grid.ts';

const PAD = 24;
// The app never draws its column wider than 480: window widths above that are capped before this is called.
const column = (windowWidth) => Math.min(windowWidth, 480);

describe('gridColumns: three columns on every phone', () => {
  it('3 columns at every real phone width (and tablets, which are capped to the 480 column)', () => {
    for (const w of [280, 320, 360, 375, 390, 393, 411, 414, 430, 480, 600, 768, 1024]) assert.equal(gridColumns(column(w), PAD), HOME_COLUMNS, String(w));
    assert.equal(HOME_COLUMNS, 3);
  });
  it('never fewer than one column, whatever the width', () => {
    for (const w of [NaN, Infinity, -Infinity, undefined, 0, -5, 10]) assert.equal(gridColumns(w, PAD), 1, String(w));
  });
});

describe('tileWidth', () => {
  it('a row of tiles plus gaps never exceeds the content area, and wastes under one pixel per column', () => {
    for (const columns of [1, 2, 3]) {
      for (let content = 280; content <= 480; content += 7) {
        const w = tileWidth(content, PAD, columns);
        const row = w * columns + GRID_GAP * (columns - 1);
        assert.ok(row <= content - PAD * 2, `${columns} cols @ ${content}: row ${row}`);
        assert.ok(content - PAD * 2 - row < columns, `${columns} cols @ ${content}: wastes ${content - PAD * 2 - row}`);
        assert.ok(Number.isInteger(w));
      }
    }
  });
  it('known sizes at the widths people actually have', () => {
    assert.equal(tileWidth(320, PAD, 3), 84);
    assert.equal(tileWidth(360, PAD, 3), 97);
    assert.equal(tileWidth(411, PAD, 3), 114);
    assert.equal(tileWidth(480, PAD, 3), 137);
  });
  it('never negative or NaN', () => {
    assert.equal(tileWidth(10, PAD, 3), 0);
    assert.equal(tileWidth(NaN, PAD, 3), 0);
  });
});

describe('tile layout: picture-left / name-right when there is room, picture-over-name when there is not', () => {
  it('every 3-column phone tile is stacked (a row tile would leave the name ~30pt)', () => {
    for (const w of [320, 360, 411, 480]) assert.equal(tileLayout(tileWidth(column(w), PAD, 3)), 'stack', String(w));
  });
  it('the row layout still applies wherever a tile is wide enough: 2 columns on a phone, or one full-width row', () => {
    assert.equal(tileLayout(tileWidth(360, PAD, 2)), 'row'); // 151
    assert.equal(tileLayout(tileWidth(320, PAD, 2)), 'stack'); // 131: a 320pt phone is too narrow for a row tile in 2 columns too
  });
  it('the switch is exactly at ROW_TILE_MIN_WIDTH', () => {
    assert.equal(tileLayout(ROW_TILE_MIN_WIDTH - 1), 'stack');
    assert.equal(tileLayout(ROW_TILE_MIN_WIDTH), 'row');
  });
  it('a row tile always leaves at least 64pt for the name', () => {
    const name = ROW_TILE_MIN_WIDTH - (TILE_HEIGHT - TILE_ART) - TILE_ART - 12;
    assert.ok(name >= 64, String(name));
  });
});

describe('stacked tile size', () => {
  it('the picture fills nearly the whole tile (small, fixed padding on each side), between 40 and 120pt', () => {
    for (let w = 60; w < ROW_TILE_MIN_WIDTH; w++) {
      const art = stackArt(w);
      assert.ok(art >= 40 && art <= 120);
      if (w - STACK_PAD * 2 >= 40) assert.equal(art, Math.min(120, w - STACK_PAD * 2), `w=${w} art=${art}`);
    }
  });
  it('height is fixed per width: room for a two-line name, so one-line and two-line tiles in a row match', () => {
    const w = tileWidth(360, PAD, 3);
    assert.equal(tileHeight(w), STACK_PAD * 2 + stackArt(w) + 6 + STACK_NAME_LINES * STACK_NAME_LINE_HEIGHT);
    // pinned: a 360pt phone's tile is 97pt wide, so its picture is 89pt (up from 72 before this fix) and the tile 133pt tall.
    assert.equal(stackArt(w), 89);
    assert.equal(tileHeight(w), 133);
  });
  it('a row tile keeps its own fixed height', () => assert.equal(tileHeight(200), TILE_HEIGHT));
});

describe('sectionLimit', () => {
  it('a section shows two full rows before "See all"', () => {
    assert.equal(sectionLimit(3), 6);
    assert.equal(sectionLimit(2), 4);
    assert.equal(sectionLimit(0), 2);
  });
});

describe('every product list uses the one grid (source checks)', () => {
  const root = new URL('../../', import.meta.url);
  const read = (p) => fs.readFileSync(new URL(p, root), 'utf8');
  it('home sections, "See all" and search results all render ProductGrid, and only ProductTile draws a product tile', () => {
    assert.match(read('src/app/(customer)/shop.tsx'), /<ProductGrid/);
    assert.match(read('src/app/category/[id].tsx'), /<ProductGrid/);
    for (const f of ['src/app/(customer)/shop.tsx', 'src/app/category/[id].tsx']) assert.ok(!/<ProductTile/.test(read(f)), `${f} must not draw tiles itself`);
  });
  it('a long name is cut with an ellipsis (never overflows or clips mid-word) in both layouts', () => {
    const tile = read('src/components/market/ProductTile.tsx');
    assert.match(tile, /numberOfLines=\{layout === 'stack' \? STACK_NAME_LINES : 2\}/);
    assert.match(tile, /ellipsizeMode="tail"/);
  });
});
