import React, { useLayoutEffect, useMemo, useRef, useState } from "react";
import { layoutFlow, measureRows } from "./layout_engine";
import type { Argument, Placed } from "./types";

// TODO
// get rid of space on side
// color? how to maximize visual information

interface DebateFlowProps {
  roots: Argument[];
  speechCount: number;
  speechLabels?: string[];
  renderArgument?: (arg: Argument) => React.ReactNode;
  /**
   * The layout for `roots`. Optional — pass it when the caller already needs
   * the layout (for cursor navigation, say) so it isn't computed twice.
   */
  placed?: Placed[];
}

export function DebateFlow({
  roots,
  speechCount,
  speechLabels,
  renderArgument,
  placed: placedProp,
}: DebateFlowProps): React.ReactElement {
  const ownPlaced = useMemo(
    () => (placedProp ? [] : layoutFlow(roots)),
    [roots, placedProp],
  );
  const placed = placedProp ?? ownPlaced;

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
