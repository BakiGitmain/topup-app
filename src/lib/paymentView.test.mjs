// Run with: npm run test:unit
// Targeted: only the two status classifiers the pay/[id] result-screen bug fix depends on (isSettled already
// existed but was untested; isPaymentSuccess is new). The rest of paymentView.ts (nextStep, parseVerifyAnswer...)
// is untouched by this round and stays out of scope here.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isPaymentSuccess, isSettled } from './paymentView.ts';

describe('isPaymentSuccess: which order statuses show the success screen', () => {
  it('paid, processing and completed are all success -- fulfilment moving an order past "paid" is still success', () => {
    assert.equal(isPaymentSuccess('paid'), true);
    assert.equal(isPaymentSuccess('processing'), true);
    assert.equal(isPaymentSuccess('completed'), true);
  });
  it('cancelled, failed and refunded are NOT success -- this is the bug that was fixed', () => {
    assert.equal(isPaymentSuccess('cancelled'), false);
    assert.equal(isPaymentSuccess('failed'), false);
    assert.equal(isPaymentSuccess('refunded'), false);
  });
  it('payment_mismatch and pending_payment are not success either (they have their own separate branches)', () => {
    assert.equal(isPaymentSuccess('payment_mismatch'), false);
    assert.equal(isPaymentSuccess('pending_payment'), false);
  });
});

describe('isSettled: "nothing more to enter here", regardless of success or failure', () => {
  it('every non-pending_payment status is settled, success or not', () => {
    for (const status of ['paid', 'processing', 'completed', 'cancelled', 'failed', 'refunded', 'payment_mismatch']) {
      assert.equal(isSettled(status), true, status);
    }
  });
  it('pending_payment is the only unsettled status', () => {
    assert.equal(isSettled('pending_payment'), false);
  });
});
