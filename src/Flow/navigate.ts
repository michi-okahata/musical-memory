import type { Placed } from "./Flow.tsx";

export type Motion = "h" | "j" | "k" | "l";

/**
 * Vim-style spatial navigation over the laid-out flow grid.
 *
 * - `j` / `k`: next / previous card in the same column (by row).
 * - `h` / `l`: jump to the nearest non-empty column left / right, landing on
 *   the card whose vertical span is closest to the current one.
 *
 * Returns the id to move the cursor to (unchanged if there's nowhere to go).
 */
export function moveCursor(
  placed: Placed[],
  currentId: string | null,
  motion: Motion,
): string | null {
  if (placed.length === 0) return null;

  const cur = placed.find((p) => p.id === currentId);
  if (!cur) {
    // No cursor yet: land on the top-left-most card.
    return [...placed].sort((a, b) => a.col - b.col || a.row - b.row)[0].id;
  }

  const mid = (p: Placed) => p.row + p.span / 2;
  const curMid = mid(cur);

  if (motion === "j" || motion === "k") {
    const column = placed
      .filter((p) => p.col === cur.col)
      .sort((a, b) => a.row - b.row);
    const i = column.findIndex((p) => p.id === cur.id);
    const next = motion === "j" ? column[i + 1] : column[i - 1];
    return next?.id ?? cur.id;
  }

  // h / l: scan outward to the nearest column that actually has cards.
  const columns = [...new Set(placed.map((p) => p.col))].sort((a, b) => a - b);
  const candidates =
    motion === "l"
      ? columns.filter((c) => c > cur.col)
      : columns.filter((c) => c < cur.col).reverse();

  for (const c of candidates) {
    const inColumn = placed.filter((p) => p.col === c);
    if (inColumn.length === 0) continue;
    inColumn.sort(
      (a, b) => Math.abs(mid(a) - curMid) - Math.abs(mid(b) - curMid),
    );
    return inColumn[0].id;
  }
  return cur.id;
}
