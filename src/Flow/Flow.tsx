import React, { useLayoutEffect, useMemo, useRef, useState } from "react";

// TODO
// get rid of space on side
// color? how to maximize visual information

export interface Argument {
  id: string;
  speech: number;
  text: string;
  children: Argument[];
}

export interface Placed {
  id: string;
  col: number;
  row: number;
  span: number;
}

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
function measureRows(placed: Placed[], heights: Map<string, number>): number[] {
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

interface DebateFlowProps {
  roots: Argument[];
  speechCount: number;
  speechLabels?: string[];
  renderArgument?: (arg: Argument) => React.ReactNode;
}

export function DebateFlow({
  roots,
  speechCount,
  speechLabels,
  renderArgument,
}: DebateFlowProps): React.ReactElement {
  const placed = useMemo(() => layoutFlow(roots), [roots]);

  const byId = useMemo(() => {
    const m = new Map<string, Argument>();
    const walk = (n: Argument) => {
      m.set(n.id, n);
      n.children.forEach(walk);
    };
    roots.forEach(walk);
    return m;
  }, [roots]);

  // Cells are `align-self: start`, so each cell's box is its card's natural
  // height — measuring it can't feed back into the track sizes we set.
  const cellRefs = useRef(new Map<string, HTMLDivElement>());
  const gridRef = useRef<HTMLDivElement | null>(null);
  const [rowHeights, setRowHeights] = useState<number[]>([]);

  useLayoutEffect(() => {
    const remeasure = () => {
      const heights = new Map<string, number>();
      for (const p of placed) {
        const el = cellRefs.current.get(p.id);
        if (el) heights.set(p.id, el.getBoundingClientRect().height);
      }
      const next = measureRows(placed, heights);
      setRowHeights((prev) =>
        prev.length === next.length && prev.every((h, i) => Math.abs(h - next[i]) < 0.5)
          ? prev
          : next,
      );
    };

    remeasure();
    // Column width drives text wrapping, which drives height — re-measure on resize.
    const ro = new ResizeObserver(remeasure);
    if (gridRef.current) ro.observe(gridRef.current);
    return () => ro.disconnect();
  }, [placed]);

  const headerOffset = speechLabels ? 1 : 0;
  const gridTemplateRows = rowHeights.length
    ? [...(headerOffset ? ["auto"] : []), ...rowHeights.map((h) => `${h}px`)].join(" ")
    : undefined;

  return (
    // Only the column track list is inline — it depends on `speechCount`.
    // Every speech column shares the width equally (minmax(0,1fr) lets them
    // shrink below content width) so a full policy round stays in frame.
    <div
      ref={gridRef}
      className="flow-grid"
      style={{
        gridTemplateColumns: `repeat(${speechCount}, minmax(0, 1fr))`,
        gridTemplateRows,
      }}
    >
      {speechLabels?.map((label, i) => (
        <div key={`h-${i}`} className="flow-header" style={{ gridColumn: i + 1 }}>
          {label}
        </div>
      ))}

      {placed.map((p) => {
        const arg = byId.get(p.id)!;
        return (
          <div
            key={p.id}
            ref={(el) => {
              if (el) cellRefs.current.set(p.id, el);
              else cellRefs.current.delete(p.id);
            }}
            className="flow-cell"
            // Placement comes from `layoutFlow` — inherently per-node, so it
            // cannot live in a stylesheet.
            style={{
              gridColumn: p.col + 1,
              gridRow: `${p.row + 1 + headerOffset} / span ${p.span}`,
            }}
          >
            {renderArgument ? renderArgument(arg) : <DefaultCard text={arg.text} />}
          </div>
        );
      })}
    </div>
  );
}

function DefaultCard({ text }: { text: string }): React.ReactElement {
  return <div className="flow-card">{text}</div>;
}