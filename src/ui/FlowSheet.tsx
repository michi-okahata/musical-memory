import React, {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { layoutFlow, markerOf, measureRows } from "../layout/grid";
import { selectionRange, threadOf } from "../layout/navigate";
import { FOCUS_REACH, type Argument, type Placed, type Speech } from "../model/types";
import type { Peer } from "../sync/presence";

/**
 * The row gap lives here rather than in the stylesheet because the row heights
 * are computed, not authored: `measureRows` has to count the gaps a spanning
 * argument covers. The column gap is pure presentation and stays in CSS.
 */
const ROW_GAP = 2;

/**
 * Zoom scales the sheet through a CSS custom property (see the stylesheet), but
 * the row gap can't ride along with it: `measureRows` does arithmetic with it,
 * so it has to be a number rather than something left for CSS to resolve.
 */
const scaled = (px: number, zoom: number) => px * zoom;

/**
 * The window of columns `f` actually draws: `focus` and `FOCUS_REACH` on
 * either side, clamped to the columns that exist rather than simply dropping
 * whichever half of the reach has nowhere to go.
 *
 * Pinning an end speech used to mean a *narrower* window — the 1AC has no
 * column at -1, so reaching one short of it drew two columns instead of
 * three, at exactly the two speeches (the 1AC, the 2AR) a debater is likeliest
 * to pin. Sliding the window inward instead keeps every pin the same width:
 * the promise `f` makes is "this speech and its neighbours", and at the edge
 * that has to mean the neighbour on the one side there is, doubled, not a
 * promise quietly kept half as well.
 */
function focusRange(focus: number, count: number): [number, number] {
  let lo = focus - FOCUS_REACH;
  let hi = focus + FOCUS_REACH;
  if (lo < 0) {
    hi += -lo;
    lo = 0;
  }
  if (hi > count - 1) {
    lo -= hi - (count - 1);
    hi = count - 1;
  }
  return [Math.max(0, lo), hi];
}

const inFocus = (col: number, range: [number, number] | null) =>
  range === null || (col >= range[0] && col <= range[1]);

interface FlowSheetProps {
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
  /** The argument to keep on screen. The sheet scrolls to follow it. */
  cursorId?: string | null;
  /**
   * Where a visual selection began, or null/undefined when there isn't one.
   * The selected arguments are derived from this and `cursorId` (see
   * `selectionRange`) rather than passed as a list — same reasoning as the
   * editor state that owns it (see `EditorState.selectAnchor`).
   */
  selectAnchor?: string | null;
  /**
   * How large to draw the sheet, as a multiple of its authored size. The type
   * itself is scaled in CSS; this is here for the metrics that can't be.
   */
  zoom?: number;
  /**
   * Everyone else in the room. Drawn where their cursors are — the sheet is
   * the only place that answer means anything, and a list of names in a corner
   * would make you look away from the flow to read it.
   */
  peers?: Peer[];
}

export function FlowSheet({
  roots,
  speeches,
  renderArgument,
  placed: placedProp,
  cursorId,
  selectAnchor = null,
  focus = null,
  zoom = 1,
  peers = [],
}: FlowSheetProps): React.ReactElement {
  const ownPlaced = useMemo(
    () => (placedProp ? [] : layoutFlow(roots)),
    [roots, placedProp],
  );
  const placed = placedProp ?? ownPlaced;

  // The selected arguments, if any — everything between the anchor and the
  // cursor, top to bottom (`selectionRange` walks the column in that order
  // regardless of which end the anchor is on). Drawn as one band spanning the
  // first to the last, below, rather than a wash per cell: a selection is one
  // idea, and a gap of bare sheet between two selected cells read as "these
  // are two separate things," not "here is what's selected."
  const selection = useMemo(
    () => selectionRange(placed, selectAnchor, cursorId ?? null),
    [placed, selectAnchor, cursorId],
  );

  // What the cursor's argument answers, and what answers it — drawn as a
  // tinted rule on each, so the exchange the cursor is in can be read off the
  // sheet without moving it. See `threadOf`.
  const thread = useMemo(() => threadOf(roots, cursorId ?? null), [roots, cursorId]);

  // Which speech the cursor is in, so its header can say so. The headers are
  // sticky and therefore the one part of a column that is always on screen —
  // which makes them the cheapest possible answer to "where am I", and the only
  // one that survives scrolling to the bottom of a long flow.
  const cursorCol = useMemo(
    () => placed.find((p) => p.id === cursorId)?.col ?? null,
    [placed, cursorId],
  );

  const byId = useMemo(() => {
    const m = new Map<string, Argument>();
    const walk = (n: Argument) => {
      m.set(n.id, n);
      n.children.forEach(walk);
    };
    roots.forEach(walk);
    return m;
  }, [roots]);

  // Where everyone else is, keyed by the argument they're on — grouped,
  // because two peers can be on one argument and the cell has to be told
  // about that rather than styled twice.
  //
  // Peers on an argument this sheet hasn't got yet are dropped: a cursor
  // arrives in a presence message, which can beat the argument it points at
  // through the relay by a tick.
  const peersByArgument = useMemo(() => {
    const placedIds = new Set(placed.map((p) => p.id));
    const groups = new Map<string, Peer[]>();
    for (const peer of peers) {
      if (!peer.cursorId || !placedIds.has(peer.cursorId)) continue;
      const group = groups.get(peer.cursorId);
      if (group) group.push(peer);
      else groups.set(peer.cursorId, [peer]);
    }
    return groups;
  }, [peers, placed]);

  // Cells are `align-self: start`, so each cell's box is its argument's
  // natural height — measuring it can't feed back into the track sizes we set.
  const cellRefs = useRef(new Map<string, HTMLDivElement>());
  const gridRef = useRef<HTMLDivElement | null>(null);
  const [rowHeights, setRowHeights] = useState<number[]>([]);

  const rowGap = scaled(ROW_GAP, zoom);

  // The range `focus` draws, clamped to the sheet — see `focusRange`. Computed
  // once so the three call sites below (visibleCols, the row-0 flush, and the
  // cell filter) can't disagree about which columns are on screen.
  const range = useMemo(
    () => (focus === null ? null : focusRange(focus, speeches.length)),
    [focus, speeches.length],
  );

  // The columns actually drawn, and where each lands in the grid. Out-of-focus
  // speeches aren't narrowed, they're gone — no track, no gap, nothing to
  // paint — so the ones in focus get the whole sheet rather than sharing it
  // with slivers. Safe to drop entirely: `followFocus` (see editor/state.ts)
  // slides `focus` along the moment the cursor would leave this range, so
  // nothing ever points at a column that isn't rendered.
  const visibleCols = useMemo(
    () => speeches.map((_, i) => i).filter((i) => inFocus(i, range)),
    [speeches, range],
  );
  const colPos = useMemo(() => {
    const m = new Map<number, number>();
    visibleCols.forEach((col, i) => m.set(col, i + 1));
    return m;
  }, [visibleCols]);

  useLayoutEffect(() => {
    const remeasure = () => {
      const heights = new Map<string, number>();
      for (const p of placed) {
        const el = cellRefs.current.get(p.id);
        if (!el) continue;
        const height = el.getBoundingClientRect().height;
        // Row 0 pads itself down by `rowGap` to stay flush with the header
        // rule (see the cell's own style, below) — that padding is real
        // border-box height, so left in here it inflates row 0's track by
        // `rowGap` more than the cell actually occupies, and the difference
        // shows up as a stray gap between row 0 and row 1. Taken back out
        // before it reaches `measureRows`.
        const flush = p.row === 0 && inFocus(p.col, range) ? rowGap : 0;
        heights.set(p.id, height - flush);
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
    // `range` is a dependency and the observer cannot stand in for it: changing
    // it redistributes width *between* columns without changing the grid's own
    // size, so nothing resizes and the rows would keep the heights they were
    // given at the previous set of column widths.
    //
    // `rowGap` carries zoom, and it is a dependency for the same reason, more
    // sharply: zooming changes every argument's height but not the grid's
    // width, and the grid's own height is whatever these row tracks say it is
    // — so the observer would be waiting on a resize that only this effect can
    // cause. Left out, the sheet would change type size and keep the old rows.
  }, [placed, range, rowGap]);

  // Keep the cursor on screen. `nearest` means this only scrolls when the
  // argument has actually gone off the edge — moving around inside the
  // visible sheet doesn't drag the page around. Re-runs on `rowHeights` too,
  // since an argument that grows while being typed in can push itself out of
  // frame.
  useEffect(() => {
    if (!cursorId) return;
    cellRefs.current
      .get(cursorId)
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [cursorId, rowHeights]);

  const headerOffset = 1;
  // A `1fr` track after the last argument, holding no arguments and existing
  // only to take up whatever height is left: it is what lets the side bands
  // run to the bottom of the window on a flow that doesn't fill it. Without it
  // the grid is exactly as tall as its arguments, and the bands stop in
  // mid-air at the last row — which reads as the sheet ending rather than the
  // speech being empty.
  //
  // `rowHeights.length` stands in for "the first measurement has landed", so
  // the template stays `undefined` (and the bands sit on the header alone —
  // see .flow-band) until it has. That signal never fires on a genuinely
  // empty flow: there is nothing to measure, so the *correct* measurement is
  // itself a zero-length array, indistinguishable from "not measured yet".
  // `placed.length === 0` is decidable up front, without waiting on an
  // effect, so it skips the wait rather than hanging in it forever.
  const gridTemplateRows =
    placed.length === 0
      ? "auto 1fr"
      : rowHeights.length
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
        gridTemplateColumns: visibleCols
          .map((i) => `minmax(0, ${speeches[i].weight}fr)`)
          .join(" "),
        gridTemplateRows,
        rowGap: `${rowGap}px`,
      }}
    >
      {/* The side bands, first so everything else paints over them. Each one
          runs the full height of its column, filler track included: the empty
          parts of a speech are as much a part of reading it as the arguments
          are.

          `1 / -1` needs an explicit grid to reach the end of, and there isn't
          one on the first paint — before the arguments are measured there are
          no row tracks, so the band spans the header row alone until the
          measure lands a tick later. */}
      {visibleCols.map((i) => (
        <div
          key={`b-${i}`}
          className={`flow-band is-${speeches[i].side}`}
          style={{
            gridColumn: colPos.get(i),
            gridRow: gridTemplateRows ? "1 / -1" : "1 / span 1",
          }}
        />
      ))}

      {visibleCols.map((i) => (
        <div
          key={`h-${i}`}
          className={`flow-header is-${speeches[i].side}${
            i === cursorCol ? " is-current" : ""
          }`}
          style={{ gridColumn: colPos.get(i) }}
        >
          {speeches[i].label}
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

      {/* The selection, one band from the first selected argument to the last
          — a `gridRow` range rather than `span`, so it covers the row gaps
          between them too, the same way a spanning argument's own box does.
          Behind the cells (it comes first here), so the cursor's own,
          stronger highlight still shows through on top of it. */}
      {selection.length > 0 && (
        <div
          className="flow-selection"
          style={{
            gridColumn: colPos.get(selection[0].col),
            gridRow: `${selection[0].row + 1 + headerOffset} / ${
              selection[selection.length - 1].row +
              selection[selection.length - 1].span +
              1 +
              headerOffset
            }`,
          }}
        />
      )}

      {placed
        // Out-of-focus columns aren't drawn at all — see `visibleCols` above.
        .filter((p) => inFocus(p.col, range))
        .map((p) => {
          const arg = byId.get(p.id)!;
          const marker = markerOf(p.index, arg.mark);
          // Somebody else's cursor, if one is here. Their cursor is drawn the
          // way yours is — the rule, the wash, the hairline — in their colour
          // instead of the accent, so "where is my partner" is answered by
          // the same shape you already read your own position from, and
          // nothing is added to the sheet that has to be looked at
          // separately. Who they are is on the status line; the sheet only
          // says where.
          //
          // The first of them when several share an argument: the colour has
          // one slot, and the list of names is downstairs.
          const peer = peersByArgument.get(p.id)?.[0];
          return (
            <div
              key={p.id}
              ref={(el) => {
                if (el) cellRefs.current.set(p.id, el);
                else cellRefs.current.delete(p.id);
              }}
              // The cursor is worn by the cell rather than by the argument,
              // so that the number is inside the highlight — see the
              // stylesheet. Selection itself isn't a per-cell class any more
              // — see `.flow-selection`, above.
              className={`flow-cell${p.id === cursorId ? " is-cursor" : ""}${
                thread.has(p.id) ? " is-thread" : ""
              }${arg.support === "analytic" ? " is-analytic" : ""}${
                peer ? " is-peer" : ""
              }${peer?.editing ? " is-peer-editing" : ""}`}
              title={
                peer ? `${peer.name}${peer.editing ? " is writing here" : " is here"}` : undefined
              }
              // Placement comes from `layoutFlow` — inherently per-node, so it
              // cannot live in a stylesheet.
              style={{
                gridColumn: colPos.get(p.col),
                gridRow: `${p.row + 1 + headerOffset} / span ${p.span}`,
                // The peer's own colour, handed to the stylesheet — it is per
                // peer, so it cannot be authored there. See peers.css.
                ...(peer && ({ "--peer": peer.color } as CSSProperties)),
              }}
            >
              {/* Only when there is one to draw. The mark is text now — it
                  takes the room its characters need and no more — so an
                  unmarked argument simply starts with its first word. */}
              {marker && <span className="flow-num">{marker}</span>}
              {renderArgument ? renderArgument(arg) : <DefaultArgument text={arg.text} />}
            </div>
          );
        })}

      {/* A sheet with nothing on it yet. `:new` opens one mid-round, and what
          it opens onto is seven empty columns and no cursor — nothing on
          screen to say that a key would do anything, on the app's most modal
          surface. So the two that matter go in the slot the first argument
          will take, which is the one place a hint can sit without costing the
          flow anything: it is gone the moment there is a flow. */}
      {placed.length === 0 && (
        <dl
          className="flow-empty"
          style={{ gridColumn: colPos.get(visibleCols[0] ?? 0) ?? 1, gridRow: 2 }}
        >
          {/* Key against gloss, the same shape the keymap panel uses, because
              the second of these is how you get to that panel and the two
              should read as the same kind of writing. A line apiece rather
              than one sentence: a speech column is about twenty-five
              characters wide, and a sentence wraps in the middle of itself. */}
          <dt>
            <kbd>n</kbd>
          </dt>
          <dd>starts an argument</dd>
          <dt>
            <kbd>:?</kbd>
          </dt>
          <dd>what the keys do</dd>
        </dl>
      )}
    </div>
  );
}

function DefaultArgument({ text }: { text: string }): React.ReactElement {
  return <div className="flow-argument">{text}</div>;
}
