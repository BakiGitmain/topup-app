// Run with: npm run test:unit. The price calculator: cost x rate x (1 + the PACK's percent), one stepper per pack, and the rule
// that a price the admin typed is never changed by a stepper or a new rate.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  PERCENT_MAX, PERCENT_MIN, RATE_MAX, calcPrice, differsFromCalculated, impliedPercent, parsePercent, parseRate, percentOf, priceText, recalcDrafts,
  stepPercent, withPercent, withReset, withStep, withTick, withTypedPrice,
} from './priceCalc.ts';

const RATE = 175;
const offer = (ref, cost) => ({ ref, cost_usd: cost });

describe('cost x rate', () => {
  it('multiplies the USD cost by the rate and rounds UP to whole birr', () => {
    assert.equal(calcPrice('0.9456', 175, 0), 166); // 165.48
    assert.equal(calcPrice('1.8913', 175, 0), 331); // 330.9775
    assert.equal(calcPrice('10', 175, 0), 1750);
  });
  it('an exact result is not pushed up by floating-point dust', () => {
    assert.equal(calcPrice('1', 175, 0), 175);
    assert.equal(calcPrice('0.1', 150, 0), 15);
    assert.equal(calcPrice('0.7', 100, 0), 70); // 0.7 * 100 = 70.00000000000001 in floating point
    assert.equal(calcPrice(0.29, 100, 0), 29); // 28.999999999999996
    assert.equal(calcPrice('3.3', 100, 0), 330); // 329.99999999999994
  });
  it('follows the rate: a new rate is a new price', () => {
    assert.equal(calcPrice('2', 181.5, 0), 363);
    assert.equal(calcPrice('2', 175, 0), 350);
  });
  it('never gives a price below 1 birr', () => assert.equal(calcPrice('0.0001', 175, 0), 1));
  it('gives no price from a cost or rate that cannot be used', () => {
    for (const cost of ['', 'abc', '0', '-1', 'NaN', 'Infinity']) assert.equal(calcPrice(cost, 175, 0), null, cost);
    for (const rate of [0, -1, NaN, Infinity]) assert.equal(calcPrice('1', rate, 0), null, String(rate));
    assert.equal(calcPrice('1', 175, NaN), null);
  });
  it('a price above what the import accepts is not a price', () => assert.equal(calcPrice('100000', 100_000, 0), null));
});

describe('the percent markup', () => {
  it('adds the percent on top of cost x rate', () => {
    assert.equal(calcPrice('1', 175, 10), 193); // 192.5
    assert.equal(calcPrice('1', 200, 25), 250);
    assert.equal(calcPrice('1', 200, 100), 400);
  });
  it('a negative percent is a discount', () => {
    assert.equal(calcPrice('1', 200, -10), 180);
    assert.equal(calcPrice('1', 175, -10), 158); // 157.5
  });
  it('is applied once, to the cost: 10% then 10% is not 21%', () => assert.equal(calcPrice('1', 100, 10), 110));
});

describe('parsing what the admin types', () => {
  it('a rate is a positive number with up to four decimals', () => {
    assert.equal(parseRate('175'), 175);
    assert.equal(parseRate(' 181.5 '), 181.5);
    assert.equal(parseRate('1,250.25'), 1250.25);
    assert.equal(parseRate('175.123456'), 175.1235);
  });
  it('a rate that is empty, zero, negative, not a number or too big is refused', () => {
    for (const bad of ['', '  ', '0', '-3', 'abc', '1e999', String(RATE_MAX + 1)]) assert.equal(parseRate(bad), null, bad);
    assert.equal(parseRate(String(RATE_MAX)), RATE_MAX);
  });
  it('a percent may be negative or fractional, and empty means 0', () => {
    assert.equal(parsePercent('10'), 10);
    assert.equal(parsePercent('-5'), -5);
    assert.equal(parsePercent('2.5'), 2.5);
    assert.equal(parsePercent(''), 0);
    assert.equal(parsePercent(' '), 0);
  });
  it('a percent outside the range, or not a number, is refused', () => {
    for (const bad of ['abc', String(PERCENT_MIN - 1), String(PERCENT_MAX + 1), '1e999']) assert.equal(parsePercent(bad), null, bad);
    assert.equal(parsePercent(String(PERCENT_MIN)), PERCENT_MIN);
    assert.equal(parsePercent(String(PERCENT_MAX)), PERCENT_MAX);
  });
});

describe('the + and - buttons', () => {
  it('step by one', () => {
    assert.equal(stepPercent(0, 1), 1);
    assert.equal(stepPercent(0, -1), -1);
    assert.equal(stepPercent(9, 1), 10);
  });
  it('a fractional percent steps without floating-point dust', () => {
    assert.equal(stepPercent(2.5, 1), 3.5);
    assert.equal(stepPercent(0.1, 1), 1.1);
    assert.equal(stepPercent(1.1, -1), 0.1);
  });
  it('stop at the ends of the range', () => {
    assert.equal(stepPercent(PERCENT_MAX, 1), PERCENT_MAX);
    assert.equal(stepPercent(PERCENT_MIN, -1), PERCENT_MIN);
  });
});

describe('ticking a pack', () => {
  it('fills in the calculated price, at a percent of 0 by default', () => {
    assert.deepEqual(withTick(undefined, offer('a', '0.9456'), RATE, true), { ticked: true, price: '166', manual: false });
    assert.equal(percentOf(withTick(undefined, offer('a', '1'), RATE, true)), 0);
  });
  it('uses the pack\'s OWN percent', () => assert.equal(withTick({ ticked: false, price: '', percent: 10 }, offer('a', '1'), RATE, true).price, '193'));
  it('with no rate known nothing is filled in, and nothing is invented', () => {
    assert.equal(priceText('1', null, 0), '');
    assert.deepEqual(withTick(undefined, offer('a', '1'), null, true), { ticked: true, price: '', manual: false });
  });
  it('a pack with no usable cost is left empty for the admin to type', () => assert.equal(withTick(undefined, offer('a', ''), RATE, true).price, ''));
  it('keeps the pack\'s other fields (its category)', () => assert.equal(withTick({ ticked: false, price: '', categoryKey: 'uc' }, offer('a', '1'), RATE, true).categoryKey, 'uc'));
  it('a TYPED price stays', () => {
    const typed = withTypedPrice(undefined, '500');
    assert.deepEqual(withTick({ ...typed, ticked: false }, offer('a', '1'), RATE, true), { ticked: true, price: '500', manual: true });
  });
  it('unticking changes only the tick; re-ticking recalculates at today\'s rate', () => {
    let d = withTick(undefined, offer('a', '1'), RATE, true);
    d = withTick(d, offer('a', '1'), RATE, false);
    assert.deepEqual(d, { ticked: false, price: '175', manual: false });
    assert.equal(withTick(d, offer('a', '1'), 200, true).price, '200');
  });
});

describe('each pack has its own stepper', () => {
  const a = offer('a', '1');
  const b = offer('b', '2');
  const both = () => ({ a: withTick(undefined, a, RATE, true), b: withTick(undefined, b, RATE, true) });

  it('a press moves that pack\'s percent and price', () => {
    const d = withStep(both().a, a, RATE, 1);
    assert.deepEqual([d.percent, d.price], [1, '177']); // 176.75
  });
  it('the other pack is not disturbed: same object, same price, same percent', () => {
    const drafts = both();
    const before = drafts.b;
    const next = { ...drafts, a: withStep(drafts.a, a, RATE, 1) };
    assert.equal(next.b, before);
    assert.deepEqual([next.b.percent, next.b.price], [undefined, '350']);
  });
  it('two packs end up at different percents and prices', () => {
    let drafts = both();
    for (let i = 0; i < 10; i++) drafts = { ...drafts, a: withStep(drafts.a, a, RATE, 1) };
    for (let i = 0; i < 5; i++) drafts = { ...drafts, b: withStep(drafts.b, b, RATE, -1) };
    assert.deepEqual([drafts.a.percent, drafts.a.price], [10, '193']); // 192.5
    assert.deepEqual([drafts.b.percent, drafts.b.price], [-5, '333']); // 332.5
  });
  it('typing a percent works like pressing the buttons', () => assert.equal(withPercent(both().a, a, RATE, 25).price, '219')); // 218.75
  it('stepping stops at the ends of the range', () => {
    let d = withPercent(both().a, a, RATE, PERCENT_MAX);
    assert.equal(withStep(d, a, RATE, 1).percent, PERCENT_MAX);
    d = withPercent(d, a, RATE, PERCENT_MIN);
    assert.equal(withStep(d, a, RATE, -1).percent, PERCENT_MIN);
  });
  it('with no rate the percent still moves and the price is left alone', () => {
    const d = withStep({ ticked: true, price: '123', manual: false }, a, null, 1);
    assert.deepEqual([d.percent, d.price], [1, '123']);
  });
});

describe('a typed price sticks', () => {
  const a = offer('a', '1');
  const typed = () => withTypedPrice({ ...withTick(undefined, a, RATE, true), percent: 5 }, '999');

  it('typing marks the price as theirs, clearing gives it back', () => {
    assert.equal(withTypedPrice(undefined, '999').manual, true);
    assert.equal(withTypedPrice(withTypedPrice(undefined, '999'), '').manual, false);
    assert.equal(withTypedPrice(withTypedPrice(undefined, '999'), '  ').manual, false);
  });
  it('typing the same number the calculator gave still counts as typed', () => assert.equal(withTypedPrice({ ticked: true, price: '175', manual: false }, '175').manual, true));

  it('THE STEPPER on a typed pack moves its percent but never its price', () => {
    let d = typed();
    for (const dir of [1, 1, 1, -1, -1, 1, 1, 1, 1]) d = withStep(d, a, RATE, dir);
    assert.deepEqual([d.price, d.manual], ['999', true]);
    assert.equal(d.percent, 10); // 5, then +1 +1 +1 -1 -1 +1 +1 +1 +1 = +5
  });
  it('typing a percent on a typed pack keeps the price too', () => assert.equal(withPercent(typed(), a, RATE, 40).price, '999'));
  it('and "use it" is what brings it back, at the pack\'s percent', () => {
    const d = withReset(withPercent(typed(), a, RATE, 20), a, RATE);
    assert.deepEqual([d.price, d.manual, d.percent], ['210', false, 20]);
  });
  it('once it is the calculator\'s again, the stepper moves the price', () => {
    const back = withReset(typed(), a, RATE);
    assert.equal(withStep(back, a, RATE, 1).price, '186'); // 175 x 1.06 = 185.5
  });
  it('"use it" with no rate changes nothing', () => assert.deepEqual(withReset(typed(), a, null), typed()));
});

describe('a new shared rate', () => {
  const offers = [offer('a', '1'), offer('b', '2'), offer('c', '3'), offer('d', '4')];
  const start = () => {
    let drafts = {};
    for (const o of offers.slice(0, 3)) drafts[o.ref] = withTick(undefined, o, RATE, true); // d stays unticked
    drafts.a = withStep(withStep(drafts.a, offers[0], RATE, 1), offers[0], RATE, 1); // a: +2%
    drafts.b = withTypedPrice(drafts.b, '999'); // the admin's own price for b
    return drafts;
  };

  it('recalculates every ticked pack at ITS OWN percent, and keeps the typed one', () => {
    const out = recalcDrafts(start(), offers, 200);
    assert.equal(out.drafts.a.price, '204'); // 200 x 1.02
    assert.equal(out.drafts.c.price, '600'); // 0%
    assert.deepEqual(out.drafts.b, { ticked: true, price: '999', manual: true });
    assert.deepEqual([out.changed, out.kept], [2, 1]);
  });
  it('every percent survives it', () => assert.equal(recalcDrafts(start(), offers, 300).drafts.a.percent, 2));
  it('many rate changes in a row never disturb the typed price', () => {
    let drafts = start();
    for (const rate of [150, 190, 175, 210]) drafts = recalcDrafts(drafts, offers, rate).drafts;
    assert.deepEqual(drafts.b, { ticked: true, price: '999', manual: true });
  });
  it('an unticked pack is not touched', () => {
    const drafts = { ...start(), d: { ticked: false, price: '7', manual: false } };
    assert.deepEqual(recalcDrafts(drafts, offers, 500).drafts.d, { ticked: false, price: '7', manual: false });
  });
  it('with no rate known a recalculation changes nothing', () => {
    const drafts = start();
    const out = recalcDrafts(drafts, offers, null);
    assert.equal(out.drafts, drafts);
    assert.deepEqual([out.changed, out.kept], [0, 0]);
  });
  it('it never mutates what it was given', () => {
    const drafts = start();
    const before = JSON.stringify(drafts);
    recalcDrafts(drafts, offers, 300);
    assert.equal(JSON.stringify(drafts), before);
  });
});

describe('telling the admin a price differs from the calculator', () => {
  const a = offer('a', '1');
  it('a typed price that differs is flagged, and one that matches is not', () => {
    assert.equal(differsFromCalculated({ ticked: true, price: '999', manual: true }, a, RATE), true);
    assert.equal(differsFromCalculated({ ticked: true, price: '175', manual: true }, a, RATE), false);
    assert.equal(differsFromCalculated({ ticked: true, price: '1,750', manual: true }, offer('a', '10'), RATE), false);
  });
  it('is measured at the pack\'s own percent', () => {
    assert.equal(differsFromCalculated({ ticked: true, price: '193', manual: true, percent: 10 }, a, RATE), false);
    assert.equal(differsFromCalculated({ ticked: true, price: '193', manual: true, percent: 0 }, a, RATE), true);
  });
  it('an empty price, a missing draft or no rate is never flagged', () => {
    assert.equal(differsFromCalculated(undefined, a, RATE), false);
    assert.equal(differsFromCalculated({ ticked: true, price: '' }, a, RATE), false);
    assert.equal(differsFromCalculated({ ticked: true, price: '5', manual: true }, a, null), false);
  });
});

describe('the markup a saved price already contains (the edit screen)', () => {
  it('is the price over cost x rate, as a percent', () => {
    assert.equal(impliedPercent(175, '1', 175), 0);
    assert.equal(impliedPercent(193, '1', 175), 10.29);
    assert.equal(impliedPercent(158, '1', 175), -9.71);
  });
  it('a placeholder price shows up as a huge markup, not a crash', () => assert.equal(impliedPercent(9999, '1', 175), 5613.71));
  it('is null with no usable cost, rate or price', () => {
    assert.equal(impliedPercent(100, '1', null), null);
    assert.equal(impliedPercent(100, '', 175), null);
    assert.equal(impliedPercent(100, '0', 175), null);
    assert.equal(impliedPercent(0, '1', 175), null);
    assert.equal(impliedPercent(NaN, '1', 175), null);
  });
  it('a step from it lands on a price the same formula gives', () => {
    const start = impliedPercent(193, '1', 175);
    assert.equal(calcPrice('1', 175, stepPercent(start, 1)), 195); // 175 x 1.1129 = 194.76, rounded up
  });
});
