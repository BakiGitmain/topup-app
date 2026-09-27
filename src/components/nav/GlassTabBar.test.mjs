// Run with: npm run test:unit
// Guards for the "tab bar looks different on Android, and pressing a tab inverts its color" report: (1) nothing in the app
// ever asks for a native ripple/highlight (this bar draws its own press feedback with Reanimated, never android_ripple or a
// Touchable* component, so there is no default colour for a platform theme to substitute), and (2) an Animated.View that
// scales on press always has an explicit background, so Android cannot rasterize its hardware layer's first frame as
// solid black (a real, documented RN/Android rendering quirk for transformed views with no backgroundColor of their own).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
const bar = read('./GlassTabBar.tsx');
const customerLayout = read('../../app/(customer)/_layout.tsx');
const adminLayout = read('../../app/(admin)/_layout.tsx');

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
    if (name.name === 'node_modules' || name.name.startsWith('.')) continue;
    const full = path.join(dir, name.name);
    if (name.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(name.name)) out.push(full);
  }
  return out;
}
const srcRoot = fileURLToPath(new URL('../..', import.meta.url));
const appFiles = walk(srcRoot).map((f) => ({ path: f, text: fs.readFileSync(f, 'utf8') }));

describe('no native Android touch feedback exists anywhere to fall back to a default colour', () => {
  it('android_ripple is never set as a prop, in this bar or anywhere else in the app (mentioning it in a comment, to say it is NOT used, is fine)', () => {
    for (const f of appFiles) assert.doesNotMatch(f.text, /android_ripple=/, f.path);
  });
  it('Touchable* (which DOES ripple/highlight by default on Android) is never used; every touch target is a plain Pressable', () => {
    for (const f of appFiles) assert.doesNotMatch(f.text, /TouchableNativeFeedback|TouchableHighlight|TouchableOpacity/, f.path);
  });
  it("the bar's own press feedback is a Reanimated scale, driven by its own state, not a Pressable style function reading `pressed`", () => {
    assert.match(bar, /scale\.set\(pressed \? withTiming/);
    assert.doesNotMatch(bar, /style=\{\(\{ ?pressed ?\}\)/);
  });
});

describe('a view that scales on press always has an explicit background (the Android black-flash guard)', () => {
  it('the button and its icon wrapper -- the two views that actually animate -- both declare backgroundColor', () => {
    assert.match(bar, /button:\s*\{[^}]*backgroundColor:\s*'transparent'/);
    assert.match(bar, /iconWrap:\s*\{[^}]*backgroundColor:\s*'transparent'/);
  });
});

describe('one bar, wired the same way, for both roles', () => {
  it('the customer and admin tab layouts both render GlassTabBar (not two different bars that could drift apart)', () => {
    for (const layout of [customerLayout, adminLayout]) {
      assert.match(layout, /import \{ GlassTabBar/);
      assert.match(layout, /tabBar=\{\(props\) => <GlassTabBar \{\.\.\.props\}/);
    }
  });
});

describe('every OS branch in the bar is there for a real capability gap, not a styling shortcut', () => {
  it('the count of Platform.OS checks is exactly the six that are each explained in the file (Liquid Glass availability, live-blur-behind-content support, the Android keyboard-push workaround x2, and gating Haptics off web x2): a new one added without updating this count means it was not deliberately reviewed', () => {
    assert.equal((bar.match(/Platform\.OS/g) ?? []).length, 6);
  });
  it('none of the six are about colour, background or a ripple -- only capability (ios/android/web) and one keyboard workaround', () => {
    for (const m of bar.matchAll(/.*Platform\.OS.*/g)) assert.doesNotMatch(m[0], /ripple|colou?r|background/i, m[0]);
  });
});
