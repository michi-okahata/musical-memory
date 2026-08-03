import type { Argument, Mark, Placed } from "./types";

/**
 * Turning a flow into grid coordinates. All pure functions over plain data —
 * no React, no DOM — so the geometry can be reasoned about and tested on its
 * own, and the navigation keymap can share it with the renderer.
 */

// span(node) = max(1, max over column-groups of sum of child spans).
function computeSpans(roots: Argument[]): Map<string, number> {
  const spans = new Map<string, number>();

  const span = (node: Argument): number => {
    const cached = spans.get(node.id);
    if (cached !== undefined) return cached;

    const byColumn = new Map<number, number>();
    for (const child of node.children) {
      byColumn.set(child.speech, (byColumn.get(child.speech) ?? 0) + span(child));
    }

    const s = Math.max(1, ...byColumn.values());
    spans.set(node.id, s);
    return s;
  };

  roots.forEach(span);
  return spans;
}

/** How many siblings sit in each speech column, keyed by column. */
function groupSizes(siblings: Argument[]): Map<number, number> {
  const sizes = new Map<number, number>();
  for (const s of siblings) sizes.set(s.speech, (sizes.get(s.speech) ?? 0) + 1);
  return sizes;
}

export function layoutFlow(roots: Argument[]): Placed[] {
  const spans = computeSpans(roots);
  const placed: Placed[] = [];

  const place = (
    node: Argument,
    row: number,
    depth: number,
    index: number | null,
  ): void => {
    placed.push({
      id: node.id,
      col: node.speech,
      row,
      span: spans.get(node.id)!,
      depth,
      index,
    });

    const cursors = new Map<number, number>(); // per-column row cursor
    const seq = new Map<number, number>(); // per-column "1., 2., 3." counter
    const sizes = groupSizes(node.children);
    for (const child of node.children) {
      const r = cursors.get(child.speech) ?? row;
      const n = (seq.get(child.speech) ?? 0) + 1;
      seq.set(child.speech, n);
      place(child, r, depth + 1, sizes.get(child.speech)! > 1 ? n : null);
      cursors.set(child.speech, r + spans.get(child.id)!);
    }
  };

  let nextRow = 0;
  const seq = new Map<number, number>();
  const sizes = groupSizes(roots);
  for (const root of roots) {
    const n = (seq.get(root.speech) ?? 0) + 1;
    seq.set(root.speech, n);
    place(root, nextRow, 0, sizes.get(root.speech)! > 1 ? n : null);
    nextRow += spans.get(root.id)!;
  }
  return placed;
}

/**
 * What to write beside a card: its place in its group, in the notation the
 * group is marked with. Empty for a card that isn't marked — either because
 * its group says not to, or because `layoutFlow` found nothing to count it
 * against (a group of one, where a bare "1." is just noise).
 *
 * Letters run a, b, … z, aa, ab — the spreadsheet column sequence. A flow will
 * never get there, but a rule that runs out is worse than one that doesn't.
 */
export function markerOf(index: number | null, mark: Mark): string {
  if (index === null || mark === "none") return "";
  if (mark === "num") return String(index);

  let n = index;
  let out = "";
  while (n > 0) {
    n--;
    out = String.fromCharCode(97 + (n % 26)) + out;
    n = Math.floor(n / 26);
  }
  return out;
}

/**
 * Size the grid's rows from the cards' real heights.
 *
 * Left to CSS, a card taller than its subtree's rows (a long argument next to
 * short replies) makes Grid inflate *every* row it spans, and that slack lands
 * between siblings — pushing replies to the same parent apart. So we measure
 * instead: each row takes its height from the single-row cards in it, and a
 * spanning card's leftover height is added to its LAST row only. Siblings stay
 * flush and the slack falls after the last one.
 *
 * `rowGap` is the grid's row gap. A card spanning n rows also covers the n-1
 * gaps between them, so counting them is the difference between a tight sheet
 * and one that grows a few pixels of slack under every tall argument.
 */
export function measureRows(
  placed: Placed[],
  heights: Map<string, number>,
  rowGap = 0,
): number[] {
  const rowCount = placed.reduce((n, p) => Math.max(n, p.row + p.span), 0);
  const rows = new Array<number>(rowCount).fill(0);

  for (const p of placed) {
    if (p.span === 1) rows[p.row] = Math.max(rows[p.row], heights.get(p.id) ?? 0);
  }

  // Shortest spans first, so nested spans settle before the ones containing them.
  for (const p of [...placed].filter((x) => x.span > 1).sort((a, b) => a.span - b.span)) {
    let total = rowGap * (p.span - 1);
    for (let r = p.row; r < p.row + p.span; r++) total += rows[r];
    const deficit = (heights.get(p.id) ?? 0) - total;
    if (deficit > 0) rows[p.row + p.span - 1] += deficit;
  }
  return rows;
}
