// Run with: npm run test:unit
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';

import { registerConfirmHost, confirmDestructive } from './confirm.ts';
import { AM_NEEDS_REVIEW, am, en } from './strings.ts';

const hasEthiopic = (s) => /[ሀ-፿]/.test(s);
const vars = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
const KEYS = Object.keys(en);

describe('the two dictionaries agree', () => {
  it('Amharic has every key English has, and nothing else', () => {
    assert.deepEqual(Object.keys(am).sort(), [...KEYS].sort());
  });
  it('every {placeholder} in the English text is in the Amharic text, and no others (a missing one would show "{amount}" or lose the number)', () => {
    for (const k of KEYS) assert.equal(vars(am[k]), vars(en[k]), k);
  });
  it('no string is empty', () => {
    for (const k of KEYS) assert.ok(en[k].trim() !== '' && am[k].trim() !== '', k);
  });
});

describe('what is still English in Amharic is exactly what is listed for review', () => {
  // Legitimately identical: brand names, an example email, and similar.
  const SAME_ON_PURPOSE = new Set(['auth.emailPlaceholder', 'account.google', 'gift.email.placeholder', 'vault.gift.chosen']);
  const stillEnglish = KEYS.filter((k) => !hasEthiopic(am[k]) && !SAME_ON_PURPOSE.has(k));

  it('every English placeholder is on the review list (so none is forgotten or mistaken for a translation)', () => {
    const listed = new Set(AM_NEEDS_REVIEW);
    for (const k of stillEnglish) {
      // Strings made only of Latin words that are the same in both languages (e.g. "CBE") are fine when identical to English.
      if (/^[A-Z0-9 ]+$/.test(en[k])) continue;
      assert.ok(listed.has(k), `${k} is English in Amharic but not on AM_NEEDS_REVIEW: "${en[k]}"`);
    }
  });
  it('everything on the review list really is still English (the list is not stale)', () => {
    for (const k of AM_NEEDS_REVIEW) assert.equal(am[k], en[k], `${k} is on the review list but already translated`);
  });
  it('the review list has no duplicates and only real keys', () => {
    assert.equal(new Set(AM_NEEDS_REVIEW).size, AM_NEEDS_REVIEW.length);
    for (const k of AM_NEEDS_REVIEW) assert.ok(k in en, k);
  });
  it('the money-critical instruction sentences are on it (they must not go out unreviewed)', () => {
    for (const k of ['pay.steps.telebirr', 'pay.steps.cbe', 'pay.mismatchBody', 'pay.referenceUsed', 'withdraw.note', 'withdraw.confirmBody']) {
      assert.ok(AM_NEEDS_REVIEW.includes(k), k);
    }
  });
  it('the everyday screens are translated: cart, wallet, deposit, withdraw, receipt, sign-in', () => {
    for (const k of ['cart.title', 'cart.checkout', 'wallet.title', 'wallet.deposit', 'wallet.withdraw', 'deposit.title', 'withdraw.title', 'receipt.title', 'receipt.download', 'auth.login', 'auth.signUp', 'product.buyNow', 'pay.method', 'common.cancel']) {
      assert.ok(hasEthiopic(am[k]), `${k} should be Amharic`);
    }
  });
});

describe('the app opens in Amharic and remembers the choice', () => {
  const root = new URL('../../', import.meta.url);
  const read = (p) => fs.readFileSync(new URL(p, root), 'utf8');
  it('the default language is Amharic, and only a saved choice on the device changes it', () => {
    const i18n = read('src/lib/i18n.tsx');
    assert.match(i18n, /DEFAULT_LANGUAGE: Language = 'am'/);
    assert.match(i18n, /stored \?\? DEFAULT_LANGUAGE/);
    assert.match(i18n, /AsyncStorage\.setItem\(STORAGE_KEY, next\)/);
    assert.ok(!/profile\?\.language/.test(i18n), "a profile's default must not override the device (that is how English would win on first open)");
  });
  it('the አማ/EN pill is in the header of orders, vault, profile, and the sign-in / sign-up / splash screens', () => {
    for (const f of ['src/app/(customer)/orders.tsx', 'src/app/(customer)/vault.tsx', 'src/app/(customer)/profile.tsx', 'src/app/splash.tsx', 'src/components/ui/AuthLayout.tsx']) {
      assert.match(read(f), /<LanguagePill \/>/, f);
    }
  });
  it('the shop header (redesigned) carries the language control through LanguageButton, not the two-segment pill', () => {
    const shop = read('src/app/(customer)/shop.tsx');
    assert.match(shop, /<ShopHeader\b/);
    assert.ok(!/LanguagePill/.test(shop), 'the shop header uses LanguageButton, not LanguagePill directly');
    const header = read('src/components/header/ShopHeader.tsx');
    assert.match(header, /<LanguageButton\b/);
    const button = read('src/components/header/LanguageButton.tsx');
    assert.match(button, /setLanguage\(next\)/);
    assert.ok(button.includes('አማ') && button.includes('EN'));
  });
  it('the pill switches at once (no navigation) and labels both languages in their own script', () => {
    const pill = read('src/components/ui/LanguagePill.tsx');
    assert.match(pill, /setLanguage\(next\)/);
    assert.ok(pill.includes('አማ') && pill.includes('EN'));
    assert.ok(!/router\./.test(pill));
  });
  it('sign-in and sign-up no longer hold English text of their own', () => {
    for (const f of ['src/app/sign-in.tsx', 'src/app/sign-up.tsx']) {
      const text = read(f);
      assert.ok(!/label="(Login|Sign up|Sign Up|Go to login)"/.test(text), f);
      assert.match(text, /useT\(\)/, f);
    }
  });
});

describe('one confirmation dialog for the whole app', () => {
  const root = new URL('../../', import.meta.url);
  const read = (p) => fs.readFileSync(new URL(p, root), 'utf8');

  it('with no dialog mounted, asking resolves "no" (no confirmation means no action)', async () => {
    assert.equal(await confirmDestructive('Remove?', 'Sure?', 'Remove'), false);
  });
  it('the mounted dialog receives the question and its answer decides', async () => {
    let seen;
    const off = registerConfirmHost((request) => { seen = request; request.resolve(true); });
    assert.equal(await confirmDestructive('Remove it?', 'It cannot be undone.', 'Remove'), true);
    assert.deepEqual([seen.title, seen.message, seen.confirmLabel, seen.tone], ['Remove it?', 'It cannot be undone.', 'Remove', 'danger']);
    await confirmDestructive('Send it?', 'x', 'Send', 'primary').then(() => {});
    assert.equal(seen.tone, 'primary');
    off();
    assert.equal(await confirmDestructive('a', 'b', 'c'), false, 'after it unmounts, back to "no"');
  });
  it('an old dialog cannot unregister a newer one', async () => {
    const off1 = registerConfirmHost((r) => r.resolve(false));
    const off2 = registerConfirmHost((r) => r.resolve(true));
    off1();
    assert.equal(await confirmDestructive('a', 'b', 'c'), true);
    off2();
  });
  it('no screen uses the phone\'s own popup or window.confirm; the dialog is mounted once at the root', () => {
    const walk = (dir) => fs.readdirSync(new URL(dir, root), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${dir}${e.name}/`) : [`${dir}${e.name}`]));
    for (const file of walk('src/').filter((f) => /\.(ts|tsx)$/.test(f))) {
      const text = read(file);
      assert.ok(!/\bAlert\.alert\(|window\.confirm\(/.test(text), `${file} must use confirmDestructive`);
    }
    assert.match(read('src/app/_layout.tsx'), /<ConfirmHost \/>/);
  });
  it('a modal screen\'s own dialog asks while it is open, and the root one takes over again when it closes', async () => {
    const offRoot = registerConfirmHost((r) => r.resolve(false));
    const offModal = registerConfirmHost((r) => r.resolve(true));
    assert.equal(await confirmDestructive('a', 'b', 'c'), true, 'the modal screen\'s dialog');
    offModal();
    assert.equal(await confirmDestructive('a', 'b', 'c'), false, 'the root dialog again, not "no dialog at all"');
    offRoot();
  });
  it('every screen presented as a native modal that asks for confirmation mounts its own dialog (iOS: the root one cannot show over a modal sheet)', () => {
    const layout = read('src/app/_layout.tsx');
    const modals = [...layout.matchAll(/name="([^"]+)"\s*options=\{\{[^}]*presentation: 'modal'/g)].map((m) => m[1]);
    assert.ok(modals.includes('product/[id]'), modals.join(' '));
    for (const name of modals) {
      const text = read(`src/app/${name}.tsx`);
      if (/confirmDestructive\(/.test(text)) assert.match(text, /<ConfirmHost \/>/, `${name} asks for confirmation but has no ConfirmHost of its own`);
    }
  });
});
