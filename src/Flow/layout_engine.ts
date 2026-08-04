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
 * What to write beside each of `siblings`, keyed by id: its place in whatever
 * sequence its mark belongs to, or null when it's the only one of its kind and
 * a bare "1." would be noise.
 *
 * `num` and `alpha` are not symmetric, on purpose — they answer different
 * questions. `num` is the outline's backbone: the sequence of responses to one
 * line of argument, and it survives anything that interrupts it, because a
 * digression doesn't end the argument you were making:
 *
 *     1. permutation                 num   → 1
 *     2. link turn                   num   → 2
 *     a. and it's non-unique         alpha → a
 *     b. …their own ev says so       alpha → b
 *     3. no impact                   num   → 3   ← not 1, continues
 *
 * `alpha` is always a *local* aside — a breakdown of whichever numbered point
 * is current — so a fresh `num` starts a fresh alphabet, the way "1. a. b. /
 * 2. a. b." works in any outline. Continuing a) b) c) into d) e) f) across an
 * intervening numbered point would say the two asides were one list, which
 * they aren't: they're about different points.
 *
 *     1. permutation                 num   → 1
 *     a. non-unique                  alpha → a
 *     b. no link                     alpha → b
 *     2. link turn                   num   → 2   ← breaks the alphabet
 *     a. concedes the impact         alpha → a   ← not c, starts over
 *
 * An unmarked argument passes through either sequence without consuming a
 * place in it or breaking it — it isn't a digression, it's simply not part of
 * either list.
 *
 * Grouped by speech first because siblings mix every column together in
 * document order — an argument's neighbours are its column's slice of that
 * order, not the whole of it.
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
    const numTotal = column.filter((c) => c.mark === "num").length;
    let numSeen = 0;

    // The run `alpha` is currently counting — cleared every time a `num`
    // breaks it, carried through everything else (including an unmarked
    // argument, which never touches it at all).
    let run: Argument[] = [];
    const flushRun = () => {
      run.forEach((c, i) => out.set(c.id, run.length > 1 ? i + 1 : null));
      run = [];
    };

    for (const c of column) {
      if (c.mark === "num") {
        flushRun();
        numSeen++;
        out.set(c.id, numTotal > 1 ? numSeen : null);
      } else if (c.mark === "alpha") {
        run.push(c);
      } else {
        out.set(c.id, null); // "none" never draws a mark
      }
    }
    flushRun();
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
 * What to write beside an argument: its place among the arguments marked as it
 * is, in the notation it is marked with. Empty when the argument carries no
 * mark, or when `layoutFlow` found nothing to count it against — the only one
 * of its kind in the column, where a bare "1." is just noise.
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
 * Size the grid's rows from the arguments' real heights.
 *
 * Left to CSS, an argument taller than its subtree's rows (a long one next to
 * short replies) makes Grid inflate *every* row it spans, and that slack lands
 * between siblings — pushing replies to the same parent apart. So we measure
 * instead: each row takes its height from the single-row arguments in it, and
 * a spanning argument's leftover height is added to its LAST row only.
 * Siblings stay flush and the slack falls after the last one.
 *
 * `rowGap` is the grid's row gap. An argument spanning n rows also covers the
 * n-1 gaps between them, so counting them is the difference between a tight
 * sheet and one that grows a few pixels of slack under every tall argument.
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
