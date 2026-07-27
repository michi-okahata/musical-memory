import type { Argument, Placed } from "./types";

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

export function layoutFlow(roots: Argument[]): Placed[] {
  const spans = computeSpans(roots);
  const placed: Placed[] = [];

  const place = (node: Argument, row: number): void => {
    placed.push({ id: node.id, col: node.speech, row, span: spans.get(node.id)! });

    const cursors = new Map<number, number>(); // per-column row cursor
    for (const child of node.children) {
      const r = cursors.get(child.speech) ?? row;
      place(child, r);
      cursors.set(child.speech, r + spans.get(child.id)!);
    }
  };

  let nextRow = 0;
  for (const root of roots) {
    place(root, nextRow);
    nextRow += spans.get(root.id)!;
  }
  return placed;
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
 */
export function measureRows(
  placed: Placed[],
  heights: Map<string, number>,
): number[] {
  const rowCount = placed.reduce((n, p) => Math.max(n, p.row + p.span), 0);
  const rows = new Array<number>(rowCount).fill(0);

  for (const p of placed) {
    if (p.span === 1) rows[p.row] = Math.max(rows[p.row], heights.get(p.id) ?? 0);
  }

  // Shortest spans first, so nested spans settle before the ones containing them.
  for (const p of [...placed].filter((x) => x.span > 1).sort((a, b) => a.span - b.span)) {
    let total = 0;
    for (let r = p.row; r < p.row + p.span; r++) total += rows[r];
    const deficit = (heights.get(p.id) ?? 0) - total;
    if (deficit > 0) rows[p.row + p.span - 1] += deficit;
  }
  return rows;
}
