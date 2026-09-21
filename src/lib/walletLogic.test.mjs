// Run with: npm run test:unit
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  checkoutPath, depositAmountProblem, isCredit, isOpenDeposit, normalizePayoutAccount, parseAmount,
  parseWalletFailure, payoutAccountProblem, withdrawAmountProblem,
} from './walletLogic.ts';

describe('parseAmount', () => {
  it('reads plain and comma-grouped amounts with up to 2 decimals', () => {
    assert.equal(parseAmount('500'), 500);
    assert.equal(parseAmount('1,250.5'), 1250.5);
    assert.equal(parseAmount(' 99.99 '), 99.99);
  });
  it('refuses everything else', () => {
    for (const bad of ['', ' ', '0', '0.00', '-5', 'abc', '12.345', '1e5', '10 birr', '5,0,0.0.0', 'NaN', '.5', '5.']) assert.equal(parseAmount(bad), null, bad);
    assert.equal(parseAmount(undefined), null);
  });
});

describe('amount rules (the same limits as the database)', () => {
  it('a deposit is Br 10 to Br 100,000', () => {
    assert.equal(depositAmountProblem(null), 'required');
    assert.equal(depositAmountProblem(9.99), 'min');
    assert.equal(depositAmountProblem(10), null);
    assert.equal(depositAmountProblem(100000), null);
    assert.equal(depositAmountProblem(100000.01), 'max');
  });
  it('a withdrawal is at least Br 10 and never more than the balance, to the cent', () => {
    assert.equal(withdrawAmountProblem(null, 500), 'required');
    assert.equal(withdrawAmountProblem(5, 500), 'min');
    assert.equal(withdrawAmountProblem(500, 500), null);
    assert.equal(withdrawAmountProblem(500.01, 500), 'balance');
    assert.equal(withdrawAmountProblem(20, null), 'balance');
    assert.equal(withdrawAmountProblem(0.1 + 0.2 + 10, 10.3), null);
  });
});

describe('payout accounts (must match normalize_payout_account in SQL)', () => {
  // The SAME table is asserted against the real database in supabase/tests/wallet-requests.test.mjs.
  const TABLE = [
    ['telebirr', '+251 911 22 33 44', '0911223344'],
    ['telebirr', '251911223344', '0911223344'],
    ['telebirr', '911223344', '0911223344'],
    ['telebirr', '0911-22-33-44', '0911223344'],
    ['telebirr', '+251711223344', '0711223344'],
    ['telebirr', '0811223344', '0811223344'],
    ['telebirr', '', ''],
    ['cbe', '1000 7272 57229', '1000727257229'],
    ['cbe', '1000-7272-57229', '1000727257229'],
  ];
  for (const [provider, raw, want] of TABLE) {
    it(`${provider}: "${raw}" -> "${want}"`, () => assert.equal(normalizePayoutAccount(provider, raw), want));
  }
  it('validity: Telebirr 10 digits (09 or 07), CBE 13 digits', () => {
    assert.equal(payoutAccountProblem('telebirr', '+251 911 22 33 44'), null);
    assert.equal(payoutAccountProblem('telebirr', '0811223344'), 'invalid');
    assert.equal(payoutAccountProblem('telebirr', '091122334'), 'invalid');
    assert.equal(payoutAccountProblem('telebirr', 'abc'), 'invalid');
    assert.equal(payoutAccountProblem('telebirr', '  '), 'required');
    assert.equal(payoutAccountProblem('cbe', '1000727257229'), null);
    assert.equal(payoutAccountProblem('cbe', '100072725722'), 'invalid');
    assert.equal(payoutAccountProblem('cbe', '10007272572299'), 'invalid');
    assert.equal(payoutAccountProblem('cbe', '0911223344'), 'invalid', 'a phone number is not a CBE account');
  });
});

describe('which way checkout goes', () => {
  it('the wallet only if it covers the WHOLE total', () => {
    assert.equal(checkoutPath(1000, 500), 'wallet');
    assert.equal(checkoutPath(500, 500), 'wallet');
    assert.equal(checkoutPath(499.99, 500), 'bank');
    assert.equal(checkoutPath(0, 500), 'bank');
  });
  it('never part wallet, part bank: there are only two answers', () => {
    for (const b of [0, 1, 250, 499.99, 500, 501]) assert.ok(['wallet', 'bank'].includes(checkoutPath(b, 500)));
  });
  it('an unknown balance or an empty cart is the bank path (the database decides at checkout)', () => {
    assert.equal(checkoutPath(null, 500), 'bank');
    assert.equal(checkoutPath(1000, 0), 'bank');
  });
  it('compares in cents, so float noise cannot flip it', () => {
    assert.equal(checkoutPath(0.1 + 0.2, 0.3), 'wallet');
  });
});

describe('the wallet-request function\'s answers', () => {
  it('reads each refusal', () => {
    for (const code of ['invalid_amount', 'invalid_provider', 'invalid_account', 'insufficient_balance', 'too_many_pending', 'unauthorized']) {
      assert.deepEqual(parseWalletFailure({ error: code }), { code });
    }
  });
  it('an open deposit carries its id, but only if it is a real one', () => {
    const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    assert.deepEqual(parseWalletFailure({ error: 'deposit_open', deposit_id: id }), { code: 'deposit_open', depositId: id });
    assert.deepEqual(parseWalletFailure({ error: 'deposit_open', deposit_id: "x'; drop" }), { code: 'deposit_open' });
  });
  it('anything unexpected is "unavailable"', () => {
    for (const bad of [null, undefined, 'x', 5, [], {}, { error: 'boom' }, { error: 5 }]) assert.equal(parseWalletFailure(bad).code, 'unavailable', JSON.stringify(bad));
  });
});

describe('small helpers', () => {
  it('credit vs debit and open deposits', () => {
    assert.equal(isCredit(5), true);
    assert.equal(isCredit(-5), false);
    assert.equal(isOpenDeposit('pending_reference'), true);
    assert.equal(isOpenDeposit('pending_verification'), true);
    for (const s of ['paid', 'failed', 'mismatch']) assert.equal(isOpenDeposit(s), false);
  });
});
