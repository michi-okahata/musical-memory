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

/**
 * What to write beside each of `siblings`, keyed by id: position within its
 * *run* — the maximal stretch of same-speech neighbours marked alike — or
 * null for a run of one, where a bare "1." would be noise.
 *
 * A column no longer numbers as a single block. Two siblings can be marked
 * differently (a card `#`-cycled away from its neighbours), and a card not
 * sharing a parent with anything beside it is exactly as valid a member of a
 * run as one that does — the "group" a mark applies to was retired along with
 * the `#` binding it used to mean; what is left is only this: a contiguous
 * same-speech, same-mark stretch counts together, and anything else doesn't.
 *
 * Grouped by speech first because siblings mix every column together in
 * document order — the run has to be found inside one column's slice of that
 * order, not across it.
 */
function markIndices(siblings: Argument[]): Map<string, number | null> {
  const bySpeech = new Map<number, Argument[]>();
  for (const s of siblings) {
    const col = bySpeech.get(s.speech);
    if (col) col.push(s);
    else bySpeech.set(s.speech, [s]);
  }

  const out = new Map<string, number | null>();
  for (const column of bySpeech.values()) {
    let i = 0;
    while (i < column.length) {
      let j = i;
      while (j < column.length && column[j].mark === column[i].mark) j++;
      const runLength = j - i;
      for (let k = i; k < j; k++) {
        out.set(column[k].id, runLength > 1 ? k - i + 1 : null);
      }
      i = j;
    }
  }
  return out;
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
    const indices = markIndices(node.children);
    for (const child of node.children) {
      const r = cursors.get(child.speech) ?? row;
      place(child, r, depth + 1, indices.get(child.id) ?? null);
      cursors.set(child.speech, r + spans.get(child.id)!);
    }
  };

  let nextRow = 0;
  const indices = markIndices(roots);
  for (const root of roots) {
    place(root, nextRow, 0, indices.get(root.id) ?? null);
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
