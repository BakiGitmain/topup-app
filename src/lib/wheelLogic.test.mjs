// Run with: npm run test:unit
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MIN_SLICE_DEG,
  finalRotationDeg,
  fitFontSize,
  oddsPercent,
  rotationToAngle,
  sliceAngleDeg,
  sliceLayout,
  splitLabel,
  standoutIndex,
} from './wheelLogic.ts';

const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg ?? ''} expected ${b}, got ${a}`);
const sum = (arcs) => arcs.reduce((s, a) => s + a.sweep, 0);

describe('sliceLayout: slices drawn in proportion to their real weight', () => {
  it('the live wheel (50/25/15/7/3) is exactly proportional -- no slice is under the floor, so nothing is adjusted', () => {
    const arcs = sliceLayout([50, 25, 15, 7, 3]);
    [180, 90, 54, 25.2, 10.8].forEach((deg, i) => close(arcs[i].sweep, deg, `slice ${i}`));
    close(sum(arcs), 360);
  });
  it('arcs are contiguous, clockwise from 12 o\'clock, and each centre is the middle of its own arc', () => {
    const arcs = sliceLayout([50, 25, 15, 7, 3]);
    close(arcs[0].start, 0);
    for (let i = 1; i < arcs.length; i++) close(arcs[i].start, arcs[i - 1].start + arcs[i - 1].sweep);
    for (const a of arcs) close(a.center, a.start + a.sweep / 2);
  });
  it('a 1% prize is raised to the floor, not drawn as a hairline, and the others shrink to make room', () => {
    const arcs = sliceLayout([60, 39, 1]);
    close(arcs[2].sweep, MIN_SLICE_DEG);
    close(sum(arcs), 360);
    // The two big ones keep their exact ratio to each other.
    close(arcs[0].sweep / arcs[1].sweep, 60 / 39);
  });
  it('the floor never reorders anything: a rarer prize is never drawn bigger than a commoner one', () => {
    const weights = [40, 1, 2, 30, 20, 5, 2];
    const arcs = sliceLayout(weights);
    for (let i = 0; i < weights.length; i++) {
      for (let j = 0; j < weights.length; j++) {
        if (weights[i] < weights[j]) assert.ok(arcs[i].sweep <= arcs[j].sweep + 1e-9, `${weights[i]} vs ${weights[j]}`);
      }
    }
    close(sum(arcs), 360);
    for (const a of arcs) assert.ok(a.sweep >= MIN_SLICE_DEG - 1e-9);
  });
  it('re-checks after shrinking: a slice pushed under the floor by someone else\'s floor is floored too', () => {
    // 2.85% alone is 10.26deg (above the floor); once the 0.1% slice is raised to 10deg it would shrink to 9.99deg,
    // so it must be floored as well.
    close(sliceLayout([97.15, 2.85])[1].sweep, 10.26);
    const arcs = sliceLayout([97.05, 2.85, 0.1]);
    close(arcs[1].sweep, MIN_SLICE_DEG);
    close(arcs[2].sweep, MIN_SLICE_DEG);
    close(sum(arcs), 360);
  });
  it('one prize is the whole wheel; none is an empty layout', () => {
    const [only] = sliceLayout([7]);
    close(only.sweep, 360);
    assert.deepEqual(sliceLayout([]), []);
  });
  it('falls back to equal slices when there is no usable weight, or the floor alone cannot fit', () => {
    sliceLayout([0, 0, 0]).forEach((a) => close(a.sweep, 120));
    const many = sliceLayout(Array.from({ length: 40 }, (_, i) => i + 1));
    many.forEach((a) => close(a.sweep, 9));
  });
});

describe('rotationToAngle: landing on a slice of any size', () => {
  it('puts the given centre under the top pointer, forward only', () => {
    const arcs = sliceLayout([50, 25, 15, 7, 3]);
    for (const [i, a] of arcs.entries()) {
      const r = rotationToAngle({ centerDeg: a.center, currentRotation: 1234, extraSpins: 6 });
      close(((a.center + r) % 360 + 360) % 360, 0, `slice ${i}`);
      assert.ok(r >= 1234 + 6 * 360);
    }
  });
  it('finalRotationDeg (equal slices) is the same maths', () => {
    assert.equal(finalRotationDeg({ index: 2, totalSlices: 4, currentRotation: 0, extraSpins: 0 }), rotationToAngle({ centerDeg: 225, currentRotation: 0, extraSpins: 0 }));
  });
});

describe('standoutIndex: the one "rare prize" wedge', () => {
  it('is the lowest weight', () => {
    assert.equal(standoutIndex([{ weight: 50, discountBirr: 20 }, { weight: 3, discountBirr: 500 }, { weight: 7, discountBirr: 300 }]), 1);
  });
  it('ties go to the bigger discount', () => {
    assert.equal(standoutIndex([{ weight: 5, discountBirr: 100 }, { weight: 5, discountBirr: 400 }, { weight: 90, discountBirr: 10 }]), 1);
  });
  it('nothing stands out when there is one prize, or they are all identical', () => {
    assert.equal(standoutIndex([{ weight: 1, discountBirr: 1 }]), -1);
    assert.equal(standoutIndex([{ weight: 2, discountBirr: 9 }, { weight: 2, discountBirr: 9 }]), -1);
  });
});

describe('label helpers', () => {
  it('splits value from unit at the last space; one word stays one line', () => {
    assert.deepEqual(splitLabel(' -20 birr '), ['-20', 'birr']);
    assert.deepEqual(splitLabel('Jackpot'), ['Jackpot']);
  });
  it('fits by length and clamps', () => {
    assert.equal(fitFontSize('-20', 1000, 22, 9), 22);
    assert.equal(fitFontSize('-100000000', 10, 22, 9), 9);
    close(fitFontSize('abcd', 62, 99, 1), 25);
  });
});

describe('sliceAngleDeg', () => {
  it('360 divided evenly by the slice count', () => {
    assert.equal(sliceAngleDeg(4), 90);
    assert.equal(sliceAngleDeg(8), 45);
    assert.equal(sliceAngleDeg(3), 120);
  });
  it('0 slices -> 0, never a division by zero throw', () => {
    assert.equal(sliceAngleDeg(0), 0);
  });
});

describe('finalRotationDeg', () => {
  it('lands slice 0 of 4 (centered at 45deg) under the top pointer, starting from rest', () => {
    const r = finalRotationDeg({ index: 0, totalSlices: 4, currentRotation: 0, extraSpins: 0 });
    // Rotating by 315 puts the 45deg-centered slice at (45+315) mod 360 = 0, under the pointer.
    assert.equal(r, 315);
  });
  it('lands slice 2 of 4 (centered at 225deg) under the pointer', () => {
    const r = finalRotationDeg({ index: 2, totalSlices: 4, currentRotation: 0, extraSpins: 0 });
    assert.equal(r, 135); // (225 + 135) mod 360 = 0
  });
  it('adds extraSpins as full 360deg revolutions on top', () => {
    const withoutSpins = finalRotationDeg({ index: 0, totalSlices: 4, currentRotation: 0, extraSpins: 0 });
    const withSpins = finalRotationDeg({ index: 0, totalSlices: 4, currentRotation: 0, extraSpins: 5 });
    assert.equal(withSpins, withoutSpins + 5 * 360);
  });
  it('always moves forward (>= currentRotation), never backward, even after several spins', () => {
    let rotation = 0;
    for (const index of [3, 0, 1, 0, 2]) {
      const next = finalRotationDeg({ index, totalSlices: 4, currentRotation: rotation, extraSpins: 2 });
      assert.ok(next >= rotation, `expected ${next} >= ${rotation}`);
      rotation = next;
    }
  });
  it('landing on the SAME slice twice in a row still advances by at least a full revolution\'s worth of extraSpins', () => {
    const first = finalRotationDeg({ index: 1, totalSlices: 4, currentRotation: 0, extraSpins: 3 });
    const second = finalRotationDeg({ index: 1, totalSlices: 4, currentRotation: first, extraSpins: 3 });
    assert.ok(second > first);
    assert.equal(second - first, 3 * 360); // same slice again -> delta is 0, so the gain is exactly the extra spins
  });
  it('0 slices is a no-op, not a throw', () => {
    assert.equal(finalRotationDeg({ index: 0, totalSlices: 0, currentRotation: 40, extraSpins: 3 }), 40);
  });
});

describe('oddsPercent', () => {
  it('a straightforward share', () => {
    assert.equal(oddsPercent(1, 4), 25);
    assert.equal(oddsPercent(3, 4), 75);
  });
  it('rounds to one decimal place', () => {
    assert.equal(oddsPercent(1, 3), 33.3);
  });
  it('no active weight at all -> null, not Infinity or NaN', () => {
    assert.equal(oddsPercent(1, 0), null);
    assert.equal(oddsPercent(1, -5), null);
  });
});
