/** Product grid sizing. Pure functions with no imports. */

export const GRID_GAP = 10;

/**
 * Columns in every product grid (home sections, "See all", search results). Change this ONE number to change them all.
 * 3 is what the home screen asks for. It only works with a picture-over-name tile: on a 360pt phone a 3-column tile is ~96pt
 * wide, far too narrow for a picture AND a name side by side.
 */
export const HOME_COLUMNS = 3;

/**
 * A tile at least this wide is drawn as a ROW: picture on the left in a fixed rounded square, name on the right. Narrower
 * tiles stack the picture over the name. (With HOME_COLUMNS = 2 a phone tile is ~150pt, so the row layout returns by itself.)
 */
export const ROW_TILE_MIN_WIDTH = 150;

/** Row layout: the picture and its padding. The picture is not boxed (no border, no background of its own): it fills as
 * much of the fixed-height row as it can, with only a little breathing room on each side. */
export const TILE_ART = 64;
export const TILE_HEIGHT = 72;

/** Stacked layout: padding around the tile, gap between picture and name, and how many name lines are kept. Small, so the
 * picture (see stackArt) fills nearly the whole tile width instead of sitting in a visibly framed box. */
export const STACK_PAD = 4;
export const STACK_GAP = 6;
export const STACK_NAME_LINES = 2;
export const STACK_NAME_LINE_HEIGHT = 15;

export type TileLayout = 'row' | 'stack';

export const tileLayout = (width: number): TileLayout => (width >= ROW_TILE_MIN_WIDTH ? 'row' : 'stack');

/**
 * Columns for a content column `contentWidth` wide (before its side padding). Always HOME_COLUMNS, except when there is
 * no usable width at all, where it falls back to one so nothing can be laid out negative.
 */
export function gridColumns(contentWidth: number, sidePadding: number): number {
  const room = contentWidth - sidePadding * 2;
  return Number.isFinite(room) && room > 0 ? HOME_COLUMNS : 1;
}

/**
 * Width of one tile so that `columns` tiles plus the gaps fit the content area
 * exactly (never wider, so a row can't wrap early).
 */
export function tileWidth(contentWidth: number, sidePadding: number, columns: number, gap = GRID_GAP): number {
  const room = contentWidth - sidePadding * 2 - gap * (columns - 1);
  return Number.isFinite(room) ? Math.max(0, Math.floor(room / columns)) : 0;
}

/** The picture in a stacked tile: as wide as the tile allows (minus the small padding), between 40 and 120pt. The row
 * layout takes over at ROW_TILE_MIN_WIDTH (150) anyway, so 120 is already close to the widest a stacked tile ever gets. */
export function stackArt(width: number): number {
  return Math.max(40, Math.min(120, Math.floor(width - STACK_PAD * 2)));
}

/** Height of a tile. Fixed per width, so every tile in a row is the same height whether its name is one line or two. */
export function tileHeight(width: number): number {
  if (tileLayout(width) === 'row') return TILE_HEIGHT;
  return STACK_PAD * 2 + stackArt(width) + STACK_GAP + STACK_NAME_LINES * STACK_NAME_LINE_HEIGHT;
}

/** How many tiles a home-screen section shows before "See all": two full rows. */
export function sectionLimit(columns: number): number {
  return Math.max(1, columns) * 2;
}
