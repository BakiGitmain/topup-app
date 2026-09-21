// Run with: npm run test:unit
// A guard for the bug that made every admin switch snap back on Android: the native Switch claims the touch
// itself and ignores `pointerEvents`, so on phones it must ALWAYS have an onValueChange of its own.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';

const src = fs.readFileSync(new URL('./Toggle.tsx', import.meta.url), 'utf8');
const webStart = src.indexOf("if (Platform.OS === 'web') {");
const phoneStart = src.indexOf('  return (\n    <Pressable onPress={() => change(!value)}', webStart);
assert.ok(webStart > 0 && phoneStart > webStart, 'Toggle.tsx no longer has a separate web branch and phone branch');
const webBranch = src.slice(webStart, phoneStart);
const phoneBranch = src.slice(phoneStart, src.indexOf('const styles', phoneStart));

describe('Toggle', () => {
  it('the phone branch gives the Switch its own onValueChange (otherwise a tap on it snaps back and does nothing)', () => {
    assert.match(phoneBranch, /<Switch[\s\S]*onValueChange=\{change\}/);
  });
  it('the phone branch does not try to make the Switch inert', () => {
    assert.doesNotMatch(phoneBranch, /pointerEvents/);
  });
  it('the phone branch names the Switch for screen readers (the wrapper is not accessible)', () => {
    assert.match(phoneBranch, /accessibilityLabel=\{label\}/);
    assert.match(phoneBranch, /accessible=\{false\}/);
  });
  it('taps beside the Switch still toggle it (the 44pt wrapper handles them)', () => {
    assert.match(phoneBranch, /onPress=\{\(\) => change\(!value\)\}/);
    assert.match(src, /minHeight: 44/);
  });
  it('only the web branch uses the inert Switch (a checkbox that does honour pointer-events)', () => {
    assert.match(webBranch, /pointerEvents="none"/);
  });
});
