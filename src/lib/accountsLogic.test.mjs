// Run with: npm run test:unit
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';

import {
  MAX_ACCOUNTS,
  canAddAccount,
  classifyRefreshFailure,
  markNeedsSignIn,
  parseSavedAccounts,
  removeAccount,
  tokenKey,
  upsertAccount,
} from './accountsLogic.ts';

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const acct = (n, lastUsedAt = n) => ({ id: id(n), displayName: `A${n}`, email: `a${n}@x.test`, avatarUrl: null, isAdmin: false, lastUsedAt });

describe('upsertAccount', () => {
  it('signing into an account that is already saved updates it, never duplicates it', () => {
    const { list } = upsertAccount([acct(1), acct(2)], { ...acct(1), displayName: 'Renamed', lastUsedAt: 99 });
    assert.equal(list.length, 2);
    assert.equal(list[0].displayName, 'Renamed');
  });
  it('clears a "needs sign-in" mark once the account signs in again', () => {
    const { list } = upsertAccount(markNeedsSignIn([acct(1)], id(1)), acct(1));
    assert.equal(list[0].needsSignIn, undefined);
  });
  it('never exceeds the limit: past it, the least recently used OTHER account is dropped', () => {
    assert.equal(MAX_ACCOUNTS, 3);
    const { list, dropped } = upsertAccount([acct(1, 50), acct(2, 10), acct(3, 30)], acct(4, 60));
    assert.deepEqual(list.map((a) => a.id), [id(1), id(3), id(4)]);
    assert.deepEqual(dropped, [id(2)]);
  });
  it('the account being added is never the one dropped, even if its timestamp is the oldest', () => {
    const { list } = upsertAccount([acct(1, 50), acct(2, 40), acct(3, 30)], acct(4, 1));
    assert.ok(list.some((a) => a.id === id(4)));
    assert.equal(list.length, 3);
  });
});

describe('the rest of the list rules', () => {
  it('canAddAccount stops at the limit', () => {
    assert.equal(canAddAccount([acct(1), acct(2)]), true);
    assert.equal(canAddAccount([acct(1), acct(2), acct(3)]), false);
  });
  it('removeAccount only drops that one', () => {
    assert.deepEqual(removeAccount([acct(1), acct(2)], id(1)).map((a) => a.id), [id(2)]);
  });
  it('parseSavedAccounts drops junk, bad ids and duplicates, and caps the length', () => {
    const raw = JSON.stringify([acct(1), acct(1), { id: 'nope' }, null, 7, acct(2), acct(3), acct(4)]);
    assert.deepEqual(parseSavedAccounts(raw).map((a) => a.id), [id(1), id(2), id(3)]);
    assert.deepEqual(parseSavedAccounts('not json'), []);
    assert.deepEqual(parseSavedAccounts(null), []);
  });
  it('tokenKey only ever builds a key from a real user id', () => {
    assert.equal(tokenKey(id(1)), `portal.rt.${id(1)}`);
    assert.throws(() => tokenKey('../evil'));
  });
  it('classifyRefreshFailure: 4xx means sign in again, no answer means the network, anything else is retryable', () => {
    for (const s of [400, 401, 403, 404]) assert.equal(classifyRefreshFailure(s), 'expired');
    assert.equal(classifyRefreshFailure(null), 'network');
    assert.equal(classifyRefreshFailure(0), 'network');
    assert.equal(classifyRefreshFailure(503), 'failed');
  });
});

describe('switching never goes through the client refresh that would wipe the active session', () => {
  const src = fs.readFileSync(new URL('./accounts.tsx', import.meta.url), 'utf8');
  it('checks the saved token with its own request first, then hands the client a fresh session', () => {
    assert.match(src, /grant_type=refresh_token/);
    assert.match(src, /supabase\.auth\.setSession\(\{ access_token: fresh\.session\.access_token, refresh_token: fresh\.session\.refresh_token \}\)/);
    assert.ok(!/refreshSession\(/.test(src), 'no client refreshSession(): a failed one removes the current session');
  });
  it('removing the ACTIVE account signs out on this device only; removing another never calls the server', () => {
    assert.match(src, /signOut\(\{ scope: 'local' \}\)/);
    assert.ok(!/scope: 'global'/.test(src));
  });
  it('tokens go to secure storage on phones', () => {
    assert.match(fs.readFileSync(new URL('./accountStore.ts', import.meta.url), 'utf8'), /SecureStore\.setItemAsync/);
  });
});
