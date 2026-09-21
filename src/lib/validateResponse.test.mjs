// Run with: npm run test:unit
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseValidateResponse } from './validateResponse.ts';
import { mismatchRegion, purchaseErrorKind } from './purchaseErrors.ts';

describe('parseValidateResponse', () => {
  const good = { status: 'valid', validation_id: 'v1', expires_in: 900, player_name: 'ᴹᴿ᭄༄⁷⁸⁶ᵈ᭄༄', account_region: 'ME' };
  it('valid: keeps the name verbatim and works out the expiry from the relative time', () => {
    const r = parseValidateResponse(good, 1_000);
    assert.deepEqual(r, { status: 'valid', validationId: 'v1', expiresAt: 1_000 + 900_000, playerName: 'ᴹᴿ᭄༄⁷⁸⁶ᵈ᭄༄', accountRegion: 'ME' });
  });
  it('a missing name or region is null', () => {
    const r = parseValidateResponse({ status: 'valid', validation_id: 'v', expires_in: 5 }, 0);
    assert.equal(r.playerName, null);
    assert.equal(r.accountRegion, null);
    assert.equal(parseValidateResponse({ ...good, account_region: '  ' }, 0).accountRegion, null);
  });
  it('invalid', () => assert.deepEqual(parseValidateResponse({ status: 'invalid' }), { status: 'invalid' }));
  it('unavailable is unavailable, and never valid', () => {
    assert.equal(parseValidateResponse({ status: 'unavailable' }).status, 'unavailable');
  });
  for (const bad of [null, undefined, 'valid', 5, [], {}, { status: 'valid' }, { status: 'valid', validation_id: '', expires_in: 5 },
    { status: 'valid', validation_id: 'v' }, { status: 'valid', validation_id: 'v', expires_in: 0 }, { status: 'valid', validation_id: 'v', expires_in: -3 },
    { status: 'valid', validation_id: 'v', expires_in: '900' }, { status: 'valid', validation_id: 'v', expires_in: NaN }, { status: 'valid', validation_id: 7, expires_in: 5 },
    { error: 'server_error' }, { status: 'maybe' }]) {
    it(`a malformed answer ${JSON.stringify(bad)} is NEVER treated as valid`, () => {
      assert.notEqual(parseValidateResponse(bad).status, 'valid');
    });
  }
});

describe('purchaseErrorKind', () => {
  const kind = (message) => purchaseErrorKind({ message });
  it('maps each database error', () => {
    assert.equal(kind('insufficient_balance'), 'insufficient');
    assert.equal(kind('option_unavailable'), 'unavailable');
    assert.equal(kind('id_not_validated'), 'idNotValidated');
    assert.equal(kind('id_validation_expired'), 'idExpired');
    assert.equal(kind('id_check_required'), 'idCheckRequired');
    assert.equal(kind('region_mismatch'), 'regionMismatch');
    assert.equal(kind('region_unverified'), 'regionUnverified');
    assert.equal(kind('region_unverifiable'), 'regionUnverified');
    assert.equal(kind('account_id_required'), 'accountId');
    assert.equal(kind('buyer_field_required'), 'accountId');
    assert.equal(kind('buyer_field_invalid'), 'accountId');
  });
  it('expired is not confused with not-validated', () => {
    assert.equal(kind('id_validation_expired'), 'idExpired');
  });
  it('anything else is generic', () => {
    for (const e of [null, undefined, {}, { message: 5 }, { message: 'boom' }, 'x']) assert.equal(purchaseErrorKind(e), 'generic');
  });
  it('mismatchRegion reads the region the database named', () => {
    assert.equal(mismatchRegion({ details: 'ME' }), 'ME');
    for (const e of [null, {}, { details: 'has space' }, { details: '' }, { details: 5 }, { details: 'x'.repeat(20) }]) assert.equal(mismatchRegion(e), null);
  });
});
