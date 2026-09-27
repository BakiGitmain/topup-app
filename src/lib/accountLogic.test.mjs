// Run with: npm run test:unit
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fs from 'node:fs';

import { MIN_PASSWORD_LENGTH, checkAddPassword, checkNewPassword, isValidDisplayName, signInMethods } from './accountLogic.ts';

describe('checkAddPassword: a Google-only account adding its first password', () => {
  it('same minimum as sign-up, and the two entries must match', () => {
    assert.equal(checkAddPassword('short', 'short'), 'too_short');
    assert.equal(checkAddPassword('long-enough-1', 'long-enough-2'), 'mismatch');
    assert.equal(checkAddPassword('long-enough-1', 'long-enough-1'), 'ok');
  });
});

describe('"has a password" comes from the server, not the identities', () => {
  const root = new URL('../../', import.meta.url);
  const read = (p) => fs.readFileSync(new URL(p, root), 'utf8');
  it('the Account screen asks my_account_has_password() (a Google account that adds one keeps identities ["google"])', () => {
    assert.match(read('src/lib/account.ts'), /rpc\('my_account_has_password'\)/);
    assert.match(read('src/app/settings/account.tsx'), /hasPasswordCheck\.data \?\? methods\.includes\('email'\)/);
  });
  it('the server function only answers for the caller, only a boolean, signed-in only', () => {
    const sql = read('supabase/migrations/20261012090000_account_has_password.sql');
    assert.match(sql, /my_account_has_password\(\)\s*\nreturns boolean/);
    assert.match(sql, /where u\.id = auth\.uid\(\)/);
    assert.match(sql, /revoke all on function public\.my_account_has_password\(\) from public, anon;/);
    assert.match(sql, /grant execute on function public\.my_account_has_password\(\) to authenticated;/);
  });
});

describe('signInMethods: who gets "Change password"', () => {
  it('an email/password account', () => {
    assert.deepEqual(signInMethods([{ provider: 'email' }]), ['email']);
  });
  it('a Google-only account has no password to change', () => {
    assert.deepEqual(signInMethods([{ provider: 'google' }]), ['google']);
  });
  it('both, in a fixed order; app_metadata.providers is a fallback when identities are missing', () => {
    assert.deepEqual(signInMethods([{ provider: 'google' }, { provider: 'email' }]), ['email', 'google']);
    assert.deepEqual(signInMethods(undefined, ['google']), ['google']);
    assert.deepEqual(signInMethods(null, null), []);
  });
});

describe('checkNewPassword', () => {
  it('same minimum as sign-up', () => {
    assert.equal(MIN_PASSWORD_LENGTH, 8);
    assert.equal(checkNewPassword('old-password', 'short'), 'too_short');
    assert.equal(checkNewPassword('old-password', 'old-password'), 'same');
    assert.equal(checkNewPassword('old-password', 'a-new-one-1'), 'ok');
  });
});

describe('isValidDisplayName mirrors complete_username()', () => {
  it('2 to 40 characters after trimming', () => {
    assert.equal(isValidDisplayName(' a '), false);
    assert.equal(isValidDisplayName('Ab'), true);
    assert.equal(isValidDisplayName('x'.repeat(40)), true);
    assert.equal(isValidDisplayName('x'.repeat(41)), false);
  });
});
