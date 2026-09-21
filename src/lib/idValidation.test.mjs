// Run with: npm run test:unit
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CHECK_TIMEOUT_MS, DEBOUNCE_MS, EXPIRY_MARGIN_MS,
  continueBlocker, currentCheck, fieldsKey, isFieldsComplete, isValidNow, normalizeFields,
} from './idValidation.ts';

const ONE = [{ key: 'player_id', label: 'Player ID', type: 'text' }];
const TWO = [{ key: 'player_id', label: 'User ID', type: 'text' }, { key: 'server_id', label: 'Zone', type: 'text' }];
const SEL = [{ key: 'server', label: 'Server', type: 'select', options: [{ label: 'Asia', value: 'Asia' }, { label: 'EU', value: 'EU' }] }];

describe('the agreed timings', () => {
  it('debounce 600ms, "Checking…" gives up after 15s', () => {
    assert.equal(DEBOUNCE_MS, 600);
    assert.equal(CHECK_TIMEOUT_MS, 15_000);
  });
});

describe('fields', () => {
  it('normalizeFields keeps only declared keys, trimmed', () => {
    assert.deepEqual(normalizeFields(ONE, { player_id: '  123 ', junk: 'x' }), { player_id: '123' });
    assert.deepEqual(normalizeFields(TWO, { player_id: '1' }), { player_id: '1', server_id: '' });
  });
  it('isFieldsComplete needs every field non-blank', () => {
    assert.equal(isFieldsComplete(ONE, { player_id: '123' }), true);
    assert.equal(isFieldsComplete(ONE, { player_id: '   ' }), false);
    assert.equal(isFieldsComplete(TWO, { player_id: '1' }), false);
    assert.equal(isFieldsComplete(TWO, { player_id: '1', server_id: '2' }), true);
    assert.equal(isFieldsComplete(ONE, { player_id: 'x'.repeat(129) }), false);
    assert.equal(isFieldsComplete([], {}), true);
  });
  it('a dropdown value must be one of the options', () => {
    assert.equal(isFieldsComplete(SEL, { server: 'Asia' }), true);
    assert.equal(isFieldsComplete(SEL, { server: 'Mars' }), false);
    assert.equal(isFieldsComplete(SEL, { server: '' }), false);
  });
  it('fieldsKey ignores spacing and key order but not the region or the values', () => {
    const a = fieldsKey('r1', TWO, { player_id: ' 1 ', server_id: '2' });
    assert.equal(a, fieldsKey('r1', TWO, { server_id: '2', player_id: '1' }));
    assert.notEqual(a, fieldsKey('r2', TWO, { player_id: '1', server_id: '2' }));
    assert.notEqual(a, fieldsKey('r1', TWO, { player_id: '1', server_id: '3' }));
    assert.notEqual(fieldsKey('r1', ONE, { player_id: 'abc' }), fieldsKey('r1', ONE, { player_id: 'ABC' }), 'case matters');
  });
});

describe('currentCheck / isValidNow', () => {
  const valid = { kind: 'valid', key: 'K', validationId: 'v', playerName: 'N', accountRegion: 'ME', expiresAt: 1_000_000 };
  it('a result for other inputs is ignored', () => {
    assert.equal(currentCheck(valid, 'OTHER', 0).kind, 'idle');
    assert.equal(currentCheck({ kind: 'invalid', key: 'K' }, 'OTHER', 0).kind, 'idle');
    assert.equal(currentCheck({ kind: 'checking', key: 'K' }, 'OTHER', 0).kind, 'idle');
  });
  it('idle stays idle', () => assert.equal(currentCheck({ kind: 'idle' }, 'K', 0).kind, 'idle'));
  it('valid until shortly before the server expiry', () => {
    assert.equal(currentCheck(valid, 'K', 1_000_000 - EXPIRY_MARGIN_MS - 1).kind, 'valid');
    assert.equal(currentCheck(valid, 'K', 1_000_000 - EXPIRY_MARGIN_MS).kind, 'expired');
    assert.equal(currentCheck(valid, 'K', 2_000_000).kind, 'expired');
  });
  it('isValidNow is true only for a live valid result on the same inputs', () => {
    assert.equal(isValidNow(valid, 'K', 0), true);
    assert.equal(isValidNow(valid, 'X', 0), false);
    assert.equal(isValidNow(valid, 'K', 2_000_000), false);
    for (const s of [{ kind: 'idle' }, { kind: 'checking', key: 'K' }, { kind: 'invalid', key: 'K' }, { kind: 'unavailable', key: 'K', reason: 'timeout' }]) {
      assert.equal(isValidNow(s, 'K', 0), false, s.kind);
    }
  });
});

describe('continueBlocker: when Continue is off', () => {
  const valid = { kind: 'valid', key: 'K', validationId: 'v', playerName: 'N', accountRegion: 'ME', expiresAt: 9e12 };
  const base = { hasPackage: true, packageState: 'ok', fieldsComplete: true, idMode: 'supplier', check: valid, ticked: false };
  const b = (o) => continueBlocker({ ...base, ...o });

  it('all good -> null (Continue is on)', () => assert.equal(b({}), null));
  it('no package chosen', () => assert.equal(b({ hasPackage: false }), 'choose_package'));
  it('fields not filled in', () => assert.equal(b({ fieldsComplete: false }), 'fill_fields'));
  it('THE ID COMES FIRST: with nothing chosen yet, the first thing asked for is the ID, then its check, then a pack', () => {
    assert.equal(b({ hasPackage: false, fieldsComplete: false }), 'fill_fields');
    assert.equal(b({ hasPackage: false, check: { kind: 'idle' } }), 'checking');
    assert.equal(b({ hasPackage: false, check: { kind: 'invalid', key: 'K' } }), 'invalid_id');
    assert.equal(b({ hasPackage: false, check: { kind: 'unavailable', key: 'K', reason: 'timeout' } }), 'check_failed');
    assert.equal(b({ hasPackage: false }), 'choose_package', 'a valid ID with no pack: now choose one');
  });
  it('a game that is not checked by the supplier still asks for the ID before the pack', () => {
    assert.equal(b({ idMode: 'tick', hasPackage: false, fieldsComplete: false }), 'fill_fields');
    assert.equal(b({ idMode: 'tick', hasPackage: false, ticked: true }), 'choose_package');
  });
  it('still checking', () => {
    assert.equal(b({ check: { kind: 'checking', key: 'K' } }), 'checking');
    assert.equal(b({ check: { kind: 'idle' } }), 'checking');
  });
  it('the supplier said the ID is invalid', () => assert.equal(b({ check: { kind: 'invalid', key: 'K' } }), 'invalid_id'));
  it('A TIMEOUT KEEPS CONTINUE OFF (the database will not sell without a record)', () => {
    assert.equal(b({ check: { kind: 'unavailable', key: 'K', reason: 'timeout' } }), 'check_failed');
  });
  it('any other check error keeps it off too', () => {
    for (const reason of ['error', 'busy']) assert.equal(b({ check: { kind: 'unavailable', key: 'K', reason } }), 'check_failed');
  });
  it('an expired check keeps it off', () => assert.equal(b({ check: { kind: 'expired', key: 'K' } }), 'check_expired'));
  it('the wrong region for this account', () => assert.equal(b({ packageState: 'wrong_region' }), 'wrong_region'));
  it('an account whose region the supplier did not report', () => assert.equal(b({ packageState: 'region_unknown' }), 'region_unknown'));
  it('a package that is gone', () => assert.equal(b({ packageState: 'unavailable' }), 'package_unavailable'));
  it('a package still pending its region check cannot proceed while validating', () => assert.equal(b({ packageState: 'pending' }), 'checking'));

  it('unvalidated region: needs the tick', () => {
    const t = { idMode: 'tick', check: { kind: 'idle' }, packageState: 'pending' };
    assert.equal(b({ ...t, ticked: false }), 'confirm_id');
    assert.equal(b({ ...t, ticked: true }), null);
  });
  it('a package in a tick region that is unavailable stays blocked even when ticked', () => {
    assert.equal(b({ idMode: 'tick', ticked: true, packageState: 'unavailable' }), 'package_unavailable');
    assert.equal(b({ idMode: 'tick', ticked: true, packageState: 'wrong_region' }), 'package_unavailable');
  });
  it('the tick does NOT replace a validation in a region that validates', () => {
    assert.equal(b({ idMode: 'supplier', ticked: true, check: { kind: 'unavailable', key: 'K', reason: 'timeout' } }), 'check_failed');
  });
  it('a form with nothing to check (gift card, legacy) needs only a package', () => {
    assert.equal(b({ idMode: 'none', check: { kind: 'idle' }, fieldsComplete: true }), null);
    assert.equal(b({ idMode: 'none', hasPackage: false }), 'choose_package');
  });
  it('every input combination gets a decision, never a crash', () => {
    const kinds = [{ kind: 'idle' }, { kind: 'checking', key: 'K' }, valid, { kind: 'invalid', key: 'K' }, { kind: 'unavailable', key: 'K', reason: 'timeout' }, { kind: 'expired', key: 'K' }];
    let combos = 0;
    for (const check of kinds) for (const idMode of ['supplier', 'tick', 'none']) for (const packageState of ['pending', 'ok', 'wrong_region', 'region_unknown', 'unavailable'])
      for (const ticked of [true, false]) for (const fieldsComplete of [true, false]) for (const hasPackage of [true, false]) {
        const r = continueBlocker({ hasPackage, packageState, fieldsComplete, idMode, check, ticked });
        assert.ok(r === null || typeof r === 'string');
        combos++;
      }
    assert.ok(combos > 500);
  });
  it('Continue is only ever ON for supplier regions when the check is valid', () => {
    for (const check of [{ kind: 'idle' }, { kind: 'checking', key: 'K' }, { kind: 'invalid', key: 'K' }, { kind: 'unavailable', key: 'K', reason: 'timeout' }, { kind: 'expired', key: 'K' }])
      for (const packageState of ['pending', 'ok', 'wrong_region', 'region_unknown', 'unavailable'])
        assert.notEqual(continueBlocker({ ...base, check, packageState, ticked: true }), null, `${check.kind}/${packageState}`);
  });
});
