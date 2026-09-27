// Scroll-to-highlight: the reveal maths, and that there is ONE highlight mechanism shared by every list.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';

import { REVEAL_MARGIN, revealOffset } from './scrollHighlight.ts';

const src = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');

describe('revealOffset', () => {
  const base = { viewTop: 100, viewHeight: 400, offset: 0, contentHeight: 2000 };
  it('an item already fully in view does not move the list', () => {
    assert.equal(revealOffset({ ...base, itemTop: 150, itemHeight: 60 }), 0);
    assert.equal(revealOffset({ ...base, offset: 300, itemTop: 100, itemHeight: 400 }), 300);
  });
  it('an item below the fold is centred', () => {
    // 900 on screen = 800 into the view; centred: 800 - (400 - 60) / 2 = 630
    assert.equal(revealOffset({ ...base, itemTop: 900, itemHeight: 60 }), 630);
  });
  it('an item above (already scrolled past) is centred too', () => {
    assert.equal(revealOffset({ ...base, offset: 1000, itemTop: -200, itemHeight: 60 }), 1000 - 300 - 170);
  });
  it('never past either end of the content', () => {
    assert.equal(revealOffset({ ...base, itemTop: 2050, itemHeight: 60 }), 1600);
    assert.equal(revealOffset({ ...base, offset: 50, itemTop: 60, itemHeight: 60 }), 0);
  });
  it('an item taller than the area is top-aligned with a margin', () => {
    assert.equal(revealOffset({ ...base, itemTop: 700, itemHeight: 500 }), 600 - REVEAL_MARGIN);
  });
  it('a covered bottom (floating tab bar) counts as not visible, but the content may still scroll to the frame end', () => {
    // 380..440 into a 400 frame is "visible", but a 100pt bar covers 300..400: centre within the 300 that show.
    assert.equal(revealOffset({ ...base, itemTop: 480, itemHeight: 60, insetBottom: 100 }), 380 - 120);
    assert.equal(revealOffset({ ...base, itemTop: 150, itemHeight: 60, insetBottom: 100 }), 0);
    assert.equal(revealOffset({ ...base, itemTop: 2050, itemHeight: 60, insetBottom: 100 }), 1600);
  });
  it('unknown content height: only the top is clamped; no area yet: nothing moves', () => {
    assert.equal(revealOffset({ ...base, contentHeight: 0, itemTop: 5000, itemHeight: 60 }), 4730);
    assert.equal(revealOffset({ ...base, viewHeight: 0, itemTop: 900, itemHeight: 60 }), 0);
  });
});

describe('one shared mechanism', () => {
  const grid = src('../components/product/PackageGrid.tsx');
  const product = src('../app/product/[id].tsx');
  const profile = src('../app/(customer)/profile.tsx');
  const glow = src('../components/ui/HighlightTarget.tsx');
  it('the pack card and the transaction row both go through HighlightTarget, fed by useScrollToHighlight', () => {
    assert.match(grid, /<HighlightTarget key=\{pkg\.id\} id=\{pkg\.id\} binding=\{highlight\}/);
    assert.match(profile, /<HighlightTarget key=\{tx\.id\} id=\{tx\.id\} binding=\{highlighter\}/);
    assert.match(product, /useScrollToHighlight\(\{/);
    assert.match(profile, /useScrollToHighlight\(\{/);
  });
  it('the glow animation exists only in HighlightTarget', () => {
    assert.match(glow, /withSequence\(/);
    for (const [name, text] of [['PackageGrid', grid], ['product page', product], ['profile', profile]]) {
      assert.doesNotMatch(text, /withSequence|useSharedValue/, name);
    }
  });
  it('the glow is opacity only, respects reduce motion, and runs about 1.5-2 s', () => {
    assert.match(glow, /useReducedMotion\(\)/);
    assert.match(glow, /useAnimatedStyle\(\(\) => \(\{ opacity: opacity\.value \}\)\)/);
    const ms = Number(/GLOW_MS = (\d+)/.exec(glow)[1]);
    assert.ok(ms >= 1500 && ms <= 2000, String(ms));
  });
  it('each request is handled once: the destination clears its highlight params afterwards', () => {
    for (const text of [product, profile]) assert.match(text, /onConsumed: \(\) => router\.setParams\(\{ highlight: undefined, hl: undefined \}\)/);
  });
});
