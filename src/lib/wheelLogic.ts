/**
 * Prize wheel maths: how big each slice is drawn, the rotation that lands the wheel on the server's winner, and the
 * admin's odds display. Pure, no runtime imports (Node tests it directly). The ANIMATION never decides the prize --
 * spin_wheel() already has, server-side, before any of this runs; this only turns "prize X won" into a rotation.
 */

export const sliceAngleDeg = (totalSlices: number): number => (totalSlices > 0 ? 360 / totalSlices : 0);

/**
 * The smallest a slice is ever DRAWN, in degrees. Slices are drawn in proportion to their real weight (a 50% prize is
 * half the wheel), EXCEPT that nothing is drawn thinner than this, or a 1-2% prize becomes an unreadable hairline.
 *
 * This floor is the one place the drawing departs from the true odds, and it only applies to a prize whose real share
 * is under 10/360 = 2.8% of the total weight. It never touches the odds themselves (spin_wheel() picks by the raw
 * weights and knows nothing about drawing), and it keeps the order honest: a rarer prize is never drawn bigger than
 * a commoner one.
 *
 * Why 10: at the wheel's 280pt size, the label band of a 10deg slice is ~17pt wide at mid-radius, enough for one line
 * of 11-12pt bold text running along the radius. 8deg (~13pt) was too tight for that; above 10 the distortion of
 * real odds grows for no legibility gain.
 */
export const MIN_SLICE_DEG = 10;

export type SliceArc = { start: number; sweep: number; center: number };

/**
 * Each slice's arc, clockwise from 12 o'clock, in the given (server) order. Proportional to weight, with any slice
 * that would fall under `minDeg` raised to exactly `minDeg` and the rest shrunk proportionally to make room --
 * repeated, because shrinking can push another slice under the floor. Always sums to 360.
 *
 * Falls back to equal slices when there is no usable weight, or when the floor alone can't fit (more than 36
 * prizes at 10deg), rather than drawing something that isn't a wheel.
 */
export function sliceLayout(weights: readonly number[], minDeg: number = MIN_SLICE_DEG): SliceArc[] {
  const n = weights.length;
  if (n === 0) return [];
  const w = weights.map((x) => (Number.isFinite(x) && x > 0 ? x : 0));
  const total = w.reduce((a, b) => a + b, 0);

  let sweeps: number[];
  if (total <= 0 || minDeg * n >= 360) {
    sweeps = w.map(() => 360 / n);
  } else {
    const floored = w.map(() => false);
    for (;;) {
      const flooredCount = floored.filter(Boolean).length;
      const freeWeight = w.reduce((a, x, i) => (floored[i] ? a : a + x), 0);
      const freeDeg = 360 - minDeg * flooredCount;
      let changed = false;
      for (let i = 0; i < n; i++) {
        if (!floored[i] && (freeWeight <= 0 || (w[i] / freeWeight) * freeDeg < minDeg)) {
          floored[i] = true;
          changed = true;
        }
      }
      if (!changed) {
        sweeps = w.map((x, i) => (floored[i] ? minDeg : (x / freeWeight) * freeDeg));
        break;
      }
    }
  }

  let start = 0;
  return sweeps.map((sweep) => {
    const arc = { start, sweep, center: start + sweep / 2 };
    start += sweep;
    return arc;
  });
}

/**
 * The wheel's next resting rotation that puts the point at `centerDeg` (measured clockwise from 12 o'clock on the
 * unrotated wheel) under the fixed top pointer. Always >= currentRotation, so the wheel only ever spins forward;
 * extraSpins adds whole revolutions on top, purely for how the spin feels.
 */
export function rotationToAngle(params: { centerDeg: number; currentRotation: number; extraSpins: number }): number {
  const { centerDeg, currentRotation, extraSpins } = params;
  // R such that (centerDeg + R) mod 360 === 0.
  const targetMod = (360 - (((centerDeg % 360) + 360) % 360)) % 360;
  const currentMod = ((currentRotation % 360) + 360) % 360;
  let delta = targetMod - currentMod;
  if (delta < 0) delta += 360;
  return currentRotation + delta + Math.max(0, extraSpins) * 360;
}

/** Equal-slice special case of rotationToAngle, kept for its existing callers and tests. */
export function finalRotationDeg(params: { index: number; totalSlices: number; currentRotation: number; extraSpins: number }): number {
  const { index, totalSlices, currentRotation, extraSpins } = params;
  if (totalSlices <= 0) return currentRotation;
  return rotationToAngle({ centerDeg: (index + 0.5) * sliceAngleDeg(totalSlices), currentRotation, extraSpins });
}

/**
 * The one slice drawn as the "rare prize" (the reference's special wedge): the lowest weight, ties broken by the
 * bigger discount. -1 when there's nothing to single out (fewer than two prizes, or every prize identical).
 */
export function standoutIndex(prizes: readonly { weight: number; discountBirr: number }[]): number {
  if (prizes.length < 2) return -1;
  let best = 0;
  for (let i = 1; i < prizes.length; i++) {
    const a = prizes[i];
    const b = prizes[best];
    if (a.weight < b.weight || (a.weight === b.weight && a.discountBirr > b.discountBirr)) best = i;
  }
  const allSame = prizes.every((p) => p.weight === prizes[best].weight && p.discountBirr === prizes[best].discountBirr);
  return allSame ? -1 : best;
}

/** "-20 birr" -> ["-20", "birr"]: the value big, the unit small, like the reference's "50% / OFF". A one-word label
 * stays one line. Labels are free admin text, so this is one predictable rule (split at the LAST space) rather than
 * an attempt to parse them. */
export function splitLabel(label: string): [string] | [string, string] {
  const s = label.trim();
  const cut = s.lastIndexOf(' ');
  return cut > 0 ? [s.slice(0, cut), s.slice(cut + 1)] : [s];
}

/** A font size that fits `text` into `maxWidth`, estimated from its length (bold Latin digits run ~0.62em wide),
 * clamped to [minSize, maxSize]. An estimate on purpose: there is no text measurement inside an SVG on native. */
export function fitFontSize(text: string, maxWidth: number, maxSize: number, minSize: number): number {
  const chars = Math.max(1, [...text].length);
  return Math.max(minSize, Math.min(maxSize, maxWidth / (chars * 0.62)));
}

/** A prize's share of the wheel, as a whole-number percent, for the admin's own sanity-check display. null if there
 * is nothing to divide by (no active weight at all). */
export function oddsPercent(weight: number, totalActiveWeight: number): number | null {
  if (!Number.isFinite(weight) || !Number.isFinite(totalActiveWeight) || totalActiveWeight <= 0) return null;
  return Math.round((weight / totalActiveWeight) * 1000) / 10;
}
