import type { Placed } from "./types";

export type Motion = "h" | "j" | "k" | "l";

/**
 * Vim-style spatial navigation over the laid-out flow grid.
 *
 * - `j` / `k`: next / previous argument in the same column (by row).
 * - `h` / `l`: jump to the nearest non-empty column left / right, landing on
 *   the argument whose vertical span is closest to the current one.
 *
 * Returns the id to move the cursor to (unchanged if there's nowhere to go).
 */

const mid = (p: Placed) => p.row + p.span / 2;

/** The argument in `col` sitting closest, vertically, to `to`. */
function nearestInColumn(
  placed: Placed[],
  col: number,
  to: number,
): Placed | undefined {
  let best: Placed | undefined;
  for (const p of placed) {
    if (p.col !== col) continue;
    if (!best || Math.abs(mid(p) - to) < Math.abs(mid(best) - to)) best = p;
  }
  return best;
}

/**
 * Everything in `col`, top to bottom. What `j`/`k` step through, and the axis
 * a visual selection (see `selectionRange`) ranges over — both care about the
 * column's reading order, not the tree it came from.
 */
export function columnOrder(placed: Placed[], col: number): Placed[] {
  return placed.filter((p) => p.col === col).sort((a, b) => a.row - b.row);
}

/**
 * Everything from `anchorId` to `cursorId`, inclusive, in column order — the
 * arguments a visual selection covers. Empty whenever that's not a
 * well-formed range: either id missing (an argument the selection pointed to
 * got deleted out from under it), or the two no longer share a column.
 *
 * That second case is normal, not a bug to guard against: `h`/`l` jump columns
 * outright, so the keymap drops the selection the moment this goes empty (see
 * `releaseSelection`) rather than trying to mean something across two columns
 * with no shared order to range over.
 */
export function selectionRange(
  placed: Placed[],
  anchorId: string | null,
  cursorId: string | null,
): Placed[] {
  if (!anchorId || !cursorId) return [];
  const anchor = placed.find((p) => p.id === anchorId);
  const cursor = placed.find((p) => p.id === cursorId);
  if (!anchor || !cursor || anchor.col !== cursor.col) return [];

  const column = columnOrder(placed, cursor.col);
  const ai = column.findIndex((p) => p.id === anchor.id);
  const ci = column.findIndex((p) => p.id === cursor.id);
  const [lo, hi] = ai <= ci ? [ai, ci] : [ci, ai];
  return column.slice(lo, hi + 1);
}

/**
 * Move the cursor `count` steps. Stops early where the motion runs out of grid
 * rather than wrapping — `10j` in a short column lands on its last argument.
 */
export function moveCursor(
  placed: Placed[],
  currentId: string | null,
  motion: Motion,
  count = 1,
): string | null {
  let id = currentId;
  for (let i = 0; i < Math.max(1, count); i++) {
    const next = step(placed, id, motion);
    if (next === id) break;
    id = next;
  }
  return id;
}

function step(
  placed: Placed[],
  currentId: string | null,
  motion: Motion,
): string | null {
  if (placed.length === 0) return null;

  const cur = placed.find((p) => p.id === currentId);
  if (!cur) {
    // No cursor yet: land on the top-left-most argument.
    return [...placed].sort((a, b) => a.col - b.col || a.row - b.row)[0].id;
  }

  if (motion === "j" || motion === "k") {
    const column = columnOrder(placed, cur.col);
    const i = column.findIndex((p) => p.id === cur.id);
    const next = motion === "j" ? column[i + 1] : column[i - 1];
    return next?.id ?? cur.id;
  }

  // h / l: scan outward to the nearest column that actually has arguments.
  const columns = [...new Set(placed.map((p) => p.col))].sort((a, b) => a - b);
  const candidates =
    motion === "l"
      ? columns.filter((c) => c > cur.col)
      : columns.filter((c) => c < cur.col).reverse();

  for (const c of candidates) {
    const next = nearestInColumn(placed, c, mid(cur));
    if (next) return next.id;
  }
  return cur.id;
}

/**
 * Jump straight to a speech, keeping roughly the same place down the sheet.
 *
 * Stepping `l` across six columns to reach the 2NR is the wrong tool when the
 * round is already in the 2NR; naming the speech is a single keystroke.
 * Returns the cursor unchanged if that speech has nothing in it yet.
 */
export function moveToColumn(
  placed: Placed[],
  currentId: string | null,
  col: number,
): string | null {
  if (placed.length === 0) return null;
  const cur = placed.find((p) => p.id === currentId);
  return nearestInColumn(placed, col, cur ? mid(cur) : 0)?.id ?? currentId;
}
