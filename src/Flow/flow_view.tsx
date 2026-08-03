import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { layoutFlow, measureRows } from "./layout_engine";
import { FOCUS_REACH, type Argument, type Placed, type Speech } from "./types";

/**
 * The row gap lives here rather than in the stylesheet because the row heights
 * are computed, not authored: `measureRows` has to count the gaps a spanning
 * card covers. The column gap is pure presentation and stays in CSS.
 */
const ROW_GAP = 2;

/**
 * Zoom scales the sheet through a CSS custom property (see the stylesheet), but
 * these two metrics can't ride along: the row gap has to be a number because
 * `measureRows` does arithmetic with it, and the collapsed width has to be a
 * number because it goes into a track list beside `fr` units. Both are scaled
 * here instead, from the same multiplier, so a zoomed sheet stays in proportion.
 */
const scaled = (px: number, zoom: number) => px * zoom;

/**
 * How wide a speech gets once it's out of focus: a sliver, with its cards drawn
 * as rectangles rather than text.
 *
 * Fixed pixels rather than a fraction, deliberately. A share of the width would
 * grow with the window, and the whole point is to hand the sheet to the three
 * speeches in focus — a collapsed speech should cost the same on any screen.
 * What survives is the shape of the flow: which arguments got answered where.
 */
const COLLAPSED_PX = 24;

const inFocus = (col: number, focus: number | null) =>
  focus === null || Math.abs(col - focus) <= FOCUS_REACH;

interface DebateFlowProps {
  roots: Argument[];
  /** The columns, in order: what each speech is called and how wide it gets. */
  speeches: Speech[];
  /**
   * The speech to build the sheet around — the rest are narrowed. Null leaves
   * every speech at its natural width.
   */
  focus?: number | null;
  renderArgument?: (arg: Argument) => React.ReactNode;
  /**
   * The layout for `roots`. Optional — pass it when the caller already needs
   * the layout (for cursor navigation, say) so it isn't computed twice.
   */
  placed?: Placed[];
  /** The card to keep on screen. The sheet scrolls to follow it. */
  cursorId?: string | null;
  /**
   * How large to draw the sheet, as a multiple of its authored size. The type
   * itself is scaled in CSS; this is here for the metrics that can't be.
   */
  zoom?: number;
}

export function DebateFlow({
  roots,
  speeches,
  renderArgument,
  placed: placedProp,
  cursorId,
  focus = null,
  zoom = 1,
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

  const rowGap = scaled(ROW_GAP, zoom);
  const collapsedPx = scaled(COLLAPSED_PX, zoom);

  useLayoutEffect(() => {
    const remeasure = () => {
      const heights = new Map<string, number>();
      for (const p of placed) {
        const el = cellRefs.current.get(p.id);
        if (el) heights.set(p.id, el.getBoundingClientRect().height);
      }
      const next = measureRows(placed, heights, rowGap);
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
    // `focus` is a dependency and the observer cannot stand in for it: changing
    // focus redistributes width *between* columns without changing the grid's
    // own size, so nothing resizes and the rows would keep the heights they
    // were given at the previous set of column widths.
    //
    // `rowGap` carries zoom, and it is a dependency for the same reason, more
    // sharply: zooming changes every card's height but not the grid's width,
    // and the grid's own height is whatever these row tracks say it is — so
    // the observer would be waiting on a resize that only this effect can
    // cause. Left out, the sheet would change type size and keep the old rows.
  }, [placed, focus, rowGap]);

  // Keep the cursor on screen. `nearest` means this only scrolls when the card
  // has actually gone off the edge — moving around inside the visible sheet
  // doesn't drag the page around. Re-runs on `rowHeights` too, since a card
  // that grows while being typed in can push itself out of frame.
  useEffect(() => {
    if (!cursorId) return;
    cellRefs.current
      .get(cursorId)
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [cursorId, rowHeights]);

  const headerOffset = 1;
  // A `1fr` track after the last card, holding no cards and existing only to
  // take up whatever height is left: it is what lets the side bands run to the
  // bottom of the window on a flow that doesn't fill it. Without it the grid
  // is exactly as tall as its cards, and the bands stop in mid-air at the last
  // row — which reads as the sheet ending rather than the speech being empty.
  const gridTemplateRows = rowHeights.length
    ? ["auto", ...rowHeights.map((h) => `${h}px`), "1fr"].join(" ")
    : undefined;

  return (
    // Only the track lists are inline — they depend on the speeches. Every
    // column is `minmax(0, …)` so it can shrink below its content width and a
    // full policy round stays in frame.
    <div
      ref={gridRef}
      className="flow-grid"
      style={{
        gridTemplateColumns: speeches
          .map((s, i) =>
            inFocus(i, focus)
              ? `minmax(0, ${s.weight}fr)`
              : `${collapsedPx}px`,
          )
          .join(" "),
        gridTemplateRows,
        rowGap: `${rowGap}px`,
      }}
    >
      {/* The side bands, first so everything else paints over them. Each one
          runs the full height of its column, filler track included: the empty
          parts of a speech are as much a part of reading it as the cards are.

          `1 / -1` needs an explicit grid to reach the end of, and there isn't
          one on the first paint — before the cards are measured there are no
          row tracks, so the band spans the header row alone until the measure
          lands a tick later. */}
      {speeches.map((speech, i) => (
        <div
          key={`b-${i}`}
          className={`flow-band is-${speech.side}`}
          style={{
            gridColumn: i + 1,
            gridRow: gridTemplateRows ? "1 / -1" : "1 / span 1",
          }}
        />
      ))}

      {speeches.map((speech, i) => (
        <div
          key={`h-${i}`}
          className={`flow-header is-${speech.side}${
            inFocus(i, focus) ? "" : " is-collapsed"
          }`}
          style={{ gridColumn: i + 1 }}
        >
          {speech.label}
        </div>
      ))}

      {/* A rule across the sheet wherever a new argument starts, so separate
          positions read as separate rather than as one long column. */}
      {placed
        .filter((p) => p.depth === 0 && p.row > 0)
        .map((p) => (
          <div
            key={`r-${p.id}`}
            className="flow-rule"
            style={{ gridColumn: "1 / -1", gridRow: p.row + 1 + headerOffset }}
          />
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
            // A collapsed card is drawn as a fixed-height rectangle (see the
            // stylesheet), which is also what keeps the rows honest: left to
            // rewrap in a 24px column it would run enormously tall, and rows
            // are shared, so it would drag the speech you're working in down
            // the page with it. The card element itself stays — clicking a
            // rectangle still puts the cursor there, which re-focuses it.
            className={`flow-cell${inFocus(p.col, focus) ? "" : " is-collapsed"}`}
            // Placement comes from `layoutFlow` — inherently per-node, so it
            // cannot live in a stylesheet.
            style={{
              gridColumn: p.col + 1,
              gridRow: `${p.row + 1 + headerOffset} / span ${p.span}`,
            }}
          >
            {/* The gutter is always drawn, empty or not: a numbered card and
                an unnumbered one in the same column must start at the same
                left edge. */}
            <span className="flow-num">{p.index ?? ""}</span>
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
