/** The scroll maths behind useScrollToHighlight. Pure, no runtime imports (Node tests it directly). */

/** Breathing room kept between a revealed item and the edge of its scroll area. */
export const REVEAL_MARGIN = 16;

export type RevealInput = {
  /** The item's top and height on screen (measureInWindow). */
  itemTop: number;
  itemHeight: number;
  /** The scroll area's own top and height on screen. */
  viewTop: number;
  viewHeight: number;
  /** How far the area is scrolled now, and how tall its content is (0 = not known yet). */
  offset: number;
  contentHeight: number;
  /** How much of the area's bottom is covered by something floating over it (a tab bar). */
  insetBottom?: number;
};

/**
 * The scroll offset that brings an item into view: unchanged when it is already fully visible, otherwise centred
 * (or top-aligned, when it is taller than the area), never past either end of the content.
 */
export function revealOffset({ itemTop, itemHeight, viewTop, viewHeight: frame, offset, contentHeight, insetBottom = 0 }: RevealInput): number {
  if (!(frame > 0)) return offset;
  // What is actually visible; the content can still scroll all the way to the frame's own bottom.
  const viewHeight = Math.max(1, frame - Math.max(0, insetBottom));
  const rel = itemTop - viewTop;
  if (rel >= 0 && rel + itemHeight <= viewHeight) return offset;
  const fits = itemHeight <= viewHeight - REVEAL_MARGIN * 2;
  const wanted = offset + rel - (fits ? (viewHeight - itemHeight) / 2 : REVEAL_MARGIN);
  const max = contentHeight > 0 ? Math.max(0, contentHeight - frame) : Number.POSITIVE_INFINITY;
  return Math.round(Math.min(Math.max(0, wanted), max));
}
