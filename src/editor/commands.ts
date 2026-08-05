import { type Mark, type Speech } from "../model/types";
import { moveCursor, moveToColumn, selectionRange, type Motion } from "../layout/navigate";
import {
  openSheet,
  releaseFocus,
  releaseSelection,
  type Command,
  type CommandContext,
  type EditorState,
} from "./state";

/**
 * Vim-style editing on top of a `Flow`.
 *
 * Every key is one `Command`: a function from the current editor state to the
 * next one (see state.ts for what that state is). Commands may mutate the flow
 * (that's the point), but the state transition itself is pure, so the whole
 * keymap is testable without a DOM — build a `Flow`, lay it out, and assert on
 * the state a command returns.
 */

/**
 * The speech the pending count names, counting from 1 the way the column
 * headers read. Null when no count is pending or it names no real speech, so
 * every caller falls back to its own default rather than to the 1AC.
 */
function counted({ state, speeches }: CommandContext): number | null {
  const c = state.count;
  return c !== null && c >= 1 && c <= speeches.length ? c - 1 : null;
}

/** Spatial cursor movement. Never mutates the flow. */
const motion =
  (m: Motion): Command =>
  ({ state, placed }) => ({
    ...state,
    cursorId: moveCursor(placed, state.cursorId, m, state.count ?? 1),
  });

/**
 * Open the command line. It takes a speech by name — `:2ac` — which is the one
 * thing you want to say to a flow that isn't a single keystroke, and reads as
 * what it is at the cost of one extra character over a positional count.
 */
const openCommand: Command = ({ state }) => ({ ...state, command: "" });

/**
 * What the command line can say that isn't the name of a speech: everything to
 * do with the room, which is everything that has an effect outside the editor's
 * own state.
 *
 * They are parsed here and run by the caller, rather than by a `Command` like
 * every other key, precisely because of that. A `Command` is a pure transition
 * from one editor state to the next — that is what makes the keymap testable
 * without a DOM — and opening a socket is neither pure nor a transition. So the
 * command line asks this what was typed, and App does it.
 */
export type SessionCommand =
  | { kind: "share" }
  | { kind: "host" }
  | { kind: "join"; invitation: string }
  | { kind: "relay"; host: string }
  | { kind: "leave" }
  | { kind: "name"; name: string }
  /** A new sheet. Untitled is allowed — you can name it once you know. */
  | { kind: "new"; title: string }
  | { kind: "rename"; title: string }
  | { kind: "sheet"; name: string }
  | { kind: "delete" };

/**
 * Read a session command, or null if the line says something else (a speech
 * name, most likely).
 *
 * Nothing here validates an address or a room code. What is well-formed is one
 * question and what actually answers is another — only the relay can settle the
 * second — so the whole of it is decided in one place, and this only has to
 * work out which command was meant.
 */
export function parseSessionCommand(text: string): SessionCommand | null {
  const [word, ...rest] = text.trim().split(/\s+/);
  const argument = rest.join(" ").trim();
  switch (word.toLowerCase()) {
    // Host a relay here and open a room on it — no server anywhere else.
    case "host":
      return { kind: "host" };
    // Open a room on whichever relay this app is pointed at.
    case "share":
      return { kind: "share" };
    // The whole invitation, as read out: `k7fmqp` or `192.168.1.42/k7fmqp`.
    case "join":
      return argument ? { kind: "join", invitation: argument } : null;
    // Point at somebody else's relay without joining a room yet. Bare `:relay`
    // goes back to the default, which is the way out of a wrong address.
    case "relay":
      return { kind: "relay", host: argument };
    case "solo":
    case "leave":
      return { kind: "leave" };
    case "name":
      return argument ? { kind: "name", name: argument } : null;

    // ---- sheets. `:new politics` is how a position gets started mid-speech,
    // which is the moment it has to be one line and no dialog.
    case "new":
      return { kind: "new", title: argument };
    case "rename":
      return argument ? { kind: "rename", title: argument } : null;
    // By name, the same way `:2ac` names a speech — a round has few enough
    // sheets that a prefix is unambiguous, and it saves counting brackets.
    case "sheet":
      return argument ? { kind: "sheet", name: argument } : null;
    case "delete":
      return { kind: "delete" };

    default:
      return null;
  }
}

/**
 * Which sheet `text` names. Case-insensitive, and a prefix is enough — `:sheet
 * pol` finds the politics DA — on the same terms as `resolveSpeech` below,
 * because they are the same gesture applied to the other axis of the round.
 */
export function resolveSheet(
  text: string,
  sheets: { id: string; title: string }[],
): string | null {
  const want = text.trim().toLowerCase();
  if (!want) return null;
  const titles = sheets.map((sheet) => sheet.title.toLowerCase());
  const exact = titles.indexOf(want);
  if (exact >= 0) return sheets[exact].id;
  const prefix = titles.findIndex((title) => title.startsWith(want));
  if (prefix >= 0) return sheets[prefix].id;
  // Failing both, anything that contains it — a sheet called "Politics DA —
  // Midterms" should answer to "midterms".
  const anywhere = titles.findIndex((title) => title.includes(want));
  return anywhere >= 0 ? sheets[anywhere].id : null;
}

/**
 * Which speech `text` names. Case-insensitive, and a prefix is enough — `:blo`
 * finds the Block. An exact name always wins over a prefix, so a speech whose
 * name is the start of another's can still be named exactly; failing that the
 * first match in speech order wins, which makes `:2` mean the 2AC rather than
 * nothing.
 */
export function resolveSpeech(text: string, speeches: Speech[]): number | null {
  const want = text.trim().toLowerCase();
  if (!want) return null;
  const labels = speeches.map((s) => s.label.toLowerCase());
  const exact = labels.indexOf(want);
  if (exact >= 0) return exact;
  const prefix = labels.findIndex((l) => l.startsWith(want));
  return prefix >= 0 ? prefix : null;
}

/**
 * Run whatever is typed and close the command line. An unrecognised speech
 * just closes it — there is nowhere sensible to go, and guessing would be
 * worse than doing nothing.
 */
export function submitCommand(ctx: CommandContext): EditorState {
  const { state, placed, speeches, flow } = ctx;
  const closed = { ...state, command: null };
  const col = resolveSpeech(state.command ?? "", speeches);
  if (col === null) return closed;
  return releaseFocus(
    { ...closed, cursorId: moveToColumn(placed, state.cursorId, col) },
    flow,
  );
}

/** Abandon the command line, leaving the cursor alone. */
export function cancelCommand(state: EditorState): EditorState {
  return { ...state, command: null };
}

/** Type into the open command line. */
export function typeCommand(state: EditorState, text: string): EditorState {
  return { ...state, command: text };
}

const edit: Command = ({ state }) =>
  state.cursorId ? { ...state, editingId: state.cursorId } : state;

/** Every creating command lands the cursor on the new argument and opens it. */
const editing = (state: EditorState, id: string): EditorState => ({
  ...state,
  cursorId: id,
  editingId: id,
  count: null,
});

const respond: Command = (ctx) => {
  const { state, flow, speeches } = ctx;
  if (!state.cursorId) return state;
  const speech = counted(ctx) ?? flow.speechOf(state.cursorId) + 1;
  if (speech >= speeches.length) return state; // nothing past the last speech
  return editing(state, flow.addResponse(state.cursorId, "", speech));
};

/**
 * Another argument alongside the cursor's — helix's `o` / `O`, opening below
 * or above. Same parent, so on a root this makes another root.
 */
const sibling =
  (where: "after" | "before"): Command =>
  (ctx) => {
    const { state, flow } = ctx;
    if (!state.cursorId) return state;
    const speech = counted(ctx) ?? flow.speechOf(state.cursorId);
    const anchor =
      where === "after" ? { after: state.cursorId } : { before: state.cursorId };
    return editing(state, flow.add(anchor, { text: "", speech }));
  };

/**
 * A fresh argument tree, clear of the one the cursor is inside — below it, or
 * above it for an overview.
 */
const newRoot =
  (where: "after" | "before"): Command =>
  (ctx) => {
    const { state, flow } = ctx;
    const speech =
      counted(ctx) ?? (state.cursorId ? flow.speechOf(state.cursorId) : 0);
    return editing(state, flow.addRoot(state.cursorId, "", speech, where));
  };

/**
 * The order `#` walks the marks in, and the whole of the design.
 *
 * The obvious reading of "a new argument numbered, lettered, or plain" is three
 * more creating keys — but there are five creating keys already (`a`, `o`, `O`,
 * `n`, `N`), and three marks apiece is fifteen bindings for a keymap that fits
 * on the status line today. It also asks the wrong question at the wrong time:
 * you are making an argument, and it wants to know about the *list*.
 *
 * So the mark is not chosen at creation at all. A new argument takes the mark
 * of whichever same-speech neighbour it lands next to (see `Flow.add`), which
 * is right nearly always — the second answer to an argument is marked like
 * the first — and `#` re-marks it when that's wrong: a lettered aside in the
 * middle of a numbered run, an independent point that should carry no mark at
 * all. One key, no mode, and it composes with every way of making an argument
 * rather than doubling each of them. Helix earns its keyboard the same way:
 * operators on a selection, not a verb per noun.
 *
 * That selection is `v`, below — one argument by default, or a run picked out
 * in a column. `#` was originally "re-mark the whole group *for* you", back
 * when a column numbered as a single block; now that a mark is a per-argument
 * fact and a column can hold several independent runs (an implicit forest —
 * see `markIndices` in grid.ts), there is no group to imply, so it
 * re-marks whatever is selected instead.
 */
const MARKS: Mark[] = ["num", "alpha", "none"];

/**
 * The arguments a command that reads "the selection" should act on: the
 * visual range if one is open, else just the cursor's own argument. Never
 * empty when there's a cursor — the fallback is what lets `#` and `x` work
 * exactly as before `v` existed, for anyone who never presses it.
 */
function selectedIds({ state, placed }: CommandContext): string[] {
  if (!state.cursorId) return [];
  const range = selectionRange(placed, state.selectAnchor, state.cursorId);
  return range.length ? range.map((p) => p.id) : [state.cursorId];
}

/**
 * Re-mark the selection: 1. → a. → nothing → 1. for every argument in it, in
 * one commit — so a multi-argument `#` is one undo step, not one per
 * argument.
 *
 * Cycling rather than three keys because there are three states and a glance
 * at the sheet says which one a run is in. The "next" value comes from the
 * cursor's own argument, not the selection's first — pressing `#` always
 * means "away from what the cursor is currently marked", whichever end of the
 * range the cursor happens to be at.
 */
const cycleMark: Command = (ctx) => {
  const { state, flow } = ctx;
  if (!state.cursorId || !flow.has(state.cursorId)) return state;
  const at = MARKS.indexOf(flow.markOf(state.cursorId));
  flow.setMarks(selectedIds(ctx), MARKS[(at + 1) % MARKS.length]);
  return { ...state, count: null };
};

/**
 * Enter or leave visual selection: `v` anchors it at the cursor; `v` again
 * (or anything that isn't a selection-aware key — see `SELECTION_KEYS`) drops
 * it. With no cursor there is nothing to anchor to.
 */
const toggleSelect: Command = ({ state }) => {
  if (state.selectAnchor !== null) return { ...state, selectAnchor: null };
  return state.cursorId ? { ...state, selectAnchor: state.cursorId } : state;
};

/**
 * Delete every selected argument, and everything responding to each — one
 * commit, so a multi-argument `x` is one undo step. Lands on the parent of
 * the first selected argument, the same rule single-argument delete already
 * used.
 */
const remove: Command = (ctx) => {
  const { state, flow } = ctx;
  if (!state.cursorId) return state;
  const ids = selectedIds(ctx);
  const parent = flow.parentOf(ids[0]);
  flow.batch(() => {
    for (const id of ids) {
      // A selected descendant of another selected argument is already gone by
      // the time its own turn comes — deleting an argument takes its subtree
      // with it.
      if (flow.has(id)) flow.remove(id);
    }
  });
  return { ...state, cursorId: parent, editingId: null, count: null, selectAnchor: null };
};

/**
 * Shift the whole selection one slot earlier ("up") or later ("down") among
 * its own siblings — arguments actually sharing a parent and a speech, not
 * merely a column. A selection that crosses parents is exactly the "forest" a
 * column can hold (see `markIndices`), and "move it up a slot" has no one
 * meaning for arguments that aren't siblings of each other — so this does
 * nothing there rather than guess. Reparenting a selection is a different
 * feature.
 *
 * Implemented by moving the *neighbour* past the block instead of moving the
 * block: `Flow.move`'s index is a position in the parent's full child list —
 * every speech mixed together — so hopping one argument over it is one
 * `move` call regardless of how many arguments the selection covers, where
 * relocating each selected argument individually would have to renumber the
 * others out from under it as it went.
 */
const moveSelection =
  (dir: "up" | "down"): Command =>
  (ctx) => {
    const { state, flow } = ctx;
    const ids = selectedIds(ctx);
    if (ids.length === 0) return state;

    const parent = flow.parentOf(ids[0]);
    if (ids.some((id) => flow.parentOf(id) !== parent)) return state;

    const speech = flow.speechOf(ids[0]);
    const siblings = flow.childrenOf(parent);
    const firstAt = siblings.indexOf(ids[0]);
    const lastAt = siblings.indexOf(ids[ids.length - 1]);

    if (dir === "up") {
      let prevAt = -1;
      for (let i = firstAt - 1; i >= 0; i--) {
        if (flow.speechOf(siblings[i]) === speech) {
          prevAt = i;
          break;
        }
      }
      if (prevAt < 0) return state; // already first among its speech
      // `prevAt` is removed from ahead of the block, so every later position
      // — `lastAt` included — shifts back by one before the reinsertion is
      // read; naming `lastAt` puts it exactly one slot past where the block
      // now sits, i.e. immediately after it.
      flow.move(siblings[prevAt], parent ?? undefined, lastAt);
    } else {
      let nextAt = -1;
      for (let i = lastAt + 1; i < siblings.length; i++) {
        if (flow.speechOf(siblings[i]) === speech) {
          nextAt = i;
          break;
        }
      }
      if (nextAt < 0) return state; // already last among its speech
      // `nextAt` is removed from behind the block, so positions at or before
      // `firstAt` are undisturbed — naming `firstAt` puts it immediately
      // before the block, i.e. one slot later than where it started.
      flow.move(siblings[nextAt], parent ?? undefined, firstAt);
    }
    return { ...state, count: null };
  };

/**
 * Undo / redo, landing the cursor where the change was made rather than
 * wherever it happens to be now — undoing a delete puts you back on the
 * argument that came back, not on its parent.
 */
const history =
  (direction: "undo" | "redo"): Command =>
  ({ state, round, sheets }) => {
    const at = direction === "undo" ? round.undo() : round.redo();
    if (at === undefined) return state; // nothing on that stack
    if (!at) return { ...state, editingId: null, count: null };

    // The change may have been made on a sheet you have since left — `u` means
    // "take back the last thing I did", and the last thing you did is not
    // always on the position you happen to be reading now. So undo carries you
    // to it, which is also the only way to see what it undid.
    let next = state;
    if (at.sheet !== sheets.active) {
      sheets.open(at.sheet);
      next = openSheet(next, sheets.active, at.sheet);
    }
    return {
      ...next,
      cursorId: at.id ?? next.cursorId,
      editingId: null,
      count: null,
    };
  };

/**
 * Pin the sheet to the speech the cursor is in — collapsing everything but it
 * and its two neighbours — or unpin it. With no cursor there is nothing to pin
 * to, so nothing happens.
 */
const toggleFocus: Command = ({ state, flow }) => {
  if (state.focus !== null) return { ...state, focus: null };
  if (!state.cursorId || !flow.has(state.cursorId)) return state;
  return { ...state, focus: flow.speechOf(state.cursorId) };
};

/**
 * The range the sheet may be drawn over. The floor is where the type stops
 * being text and becomes the shape of the round — past it you want focus mode,
 * not a smaller font. The ceiling is roughly a printed sheet held at arm's
 * length, which is as far as reading a flow ever needs to go.
 */
export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 2.5;

/** One press of `+` or `-`. Geometric, so a step means the same at either end. */
const ZOOM_STEP = 1.15;

/** Scale the sheet by `factor`, clamped. */
function scaleZoom(state: EditorState, factor: number): EditorState {
  const zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, state.zoom * factor));
  return { ...state, zoom };
}

const zoomBy =
  (factor: number): Command =>
  ({ state }) =>
    scaleZoom(state, factor);

/** Back to the authored size — the one place the clamped scale is exact. */
const resetZoom: Command = ({ state }) => ({ ...state, zoom: 1 });

/**
 * Move to the sheet `delta` along — the next position, or the previous one.
 *
 * Clamps rather than wraps, the same way `j` stops at the bottom of a column:
 * the sheets are an ordered stack, and running off the end of it to arrive back
 * at the case is disorienting in exactly the moment you can least afford it.
 */
const goToSheet =
  (delta: number): Command =>
  ({ state, sheets }) => {
    const at = sheets.list.findIndex((sheet) => sheet.id === sheets.active);
    if (at < 0) return state;
    const next = sheets.list[at + delta];
    if (!next) return state;
    sheets.open(next.id);
    return openSheet(state, sheets.active, next.id);
  };

/** Shift the open sheet up or down the list. */
const shiftSheet =
  (delta: number): Command =>
  ({ state, sheets }) => {
    if (sheets.active) sheets.move(sheets.active, delta);
    return state;
  };

/**
 * Show or hide the list of sheets. On its own key because a one-sheet round —
 * a practice speech, a rebuttal drill — has nothing to list, and the width is
 * better spent on the flow.
 */
const toggleSidebar: Command = ({ state }) => ({ ...state, sidebar: !state.sidebar });

/**
 * Build up the pending count. A leading `0` is ignored rather than starting
 * one, leaving the key free to mean something later.
 */
const digit =
  (d: number): Command =>
  ({ state }) =>
    state.count === null && d === 0
      ? state
      : { ...state, count: (state.count ?? 0) * 10 + d };

const digits = Object.fromEntries(
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => [String(d), digit(d)]),
);

/**
 * The keymap's lookup key for an event. Shift is already baked into `key`
 * (`O` vs `o`), so only Ctrl and Meta are encoded.
 */
export function keyOf(e: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
}): string {
  return `${e.ctrlKey ? "C-" : ""}${e.metaKey ? "M-" : ""}${e.key}`;
}

/**
 * `a` is the one key that means something different here than in vim: an
 * *answer*, the core move in flowing a round. Editing keeps `i` — "insert"
 * would be ambiguous as a command here anyway (insert text, or insert an
 * argument?), and a mis-pressed `i` that silently made an argument would
 * swallow the edit you meant to type.
 */
export const commands: Record<string, Command> = {
  ...digits,
  h: motion("h"),
  j: motion("j"),
  k: motion("k"),
  l: motion("l"),
  ":": openCommand, // :2ac — jump to a speech by name
  i: edit,
  Enter: edit,
  a: respond, // answer — a child, next speech column
  o: sibling("after"), // another argument below…
  O: sibling("before"), // …and above
  n: newRoot("after"), // a new argument tree, clear of this one
  N: newRoot("before"), // …above it: the overview case
  f: toggleFocus, // narrow the speeches you aren't in
  v: toggleSelect, // select a run in this column — # / x / J / K act on it
  // The round's other sheets. Brackets because they are the pair vim already
  // uses for "the next one of these, the previous one", and because the keys
  // that make arguments are all letters — reaching for a bracket is never half
  // of writing something down.
  "]": goToSheet(1),
  "[": goToSheet(-1),
  "}": shiftSheet(1), // and shifted, the sheet itself moves
  "{": shiftSheet(-1),
  b: toggleSidebar, // the list of sheets
  "#": cycleMark, // how the selection is marked off: 1. / a. / nothing
  J: moveSelection("down"), // shift the selection past its next sibling…
  K: moveSelection("up"), // …or its previous one
  // Zoom, on the platform chord — this is a desktop app, and Cmd +/- is where
  // a Mac user's hand already goes. It was on the bare keys because Cmd +/- is
  // the *browser's* zoom and can't be taken off it, but that is only true of
  // the dev preview: the shipped WKWebView binds nothing to it, so the chord
  // is ours. (Run the sheet in a browser and the page zooms under the flow
  // instead — a dev artifact, not the app.)
  //
  // Both faces of each key, since the shift state of `=/+` and `-/_` is not
  // something anyone thinks about while reaching for zoom.
  "M-=": zoomBy(ZOOM_STEP),
  "M-+": zoomBy(ZOOM_STEP),
  "M--": zoomBy(1 / ZOOM_STEP),
  "M-_": zoomBy(1 / ZOOM_STEP),
  "M-0": resetZoom, // "actual size", where every other desktop app keeps it
  x: remove,
  // Undo: vim's u / Ctrl-r, plus the platform chord this is a desktop app on.
  u: history("undo"),
  "C-r": history("redo"),
  "M-z": history("undo"),
  "M-Z": history("redo"),
  Escape: ({ state }) => state, // just drops the pending count, below
};

const isDigit = (key: string) => key.length === 1 && key >= "0" && key <= "9";

/**
 * Keys that read or extend the selection rather than starting fresh from the
 * cursor — `run` leaves `selectAnchor` standing for these and drops it for
 * everything else (see `run`, below). `h`/`j`/`k`/`l` are here even though
 * `h`/`l` usually end up dropping the selection anyway (`releaseSelection`
 * catches that once they've actually left the column) — while they haven't,
 * mid-selection movement has to be allowed to run at all.
 */
const SELECTION_KEYS = new Set(["h", "j", "k", "l", "v", "#", "x", "J", "K"]);

/**
 * Run whatever `key` is bound to. Returns null when nothing is — the caller
 * should leave the event alone rather than swallowing it.
 *
 * Clearing the pending count lives here and not in the commands: only the
 * digits build it up, and every other key spends it and is done. The
 * selection is cleared the same way and for the same reason — only the keys
 * that read or extend it (`SELECTION_KEYS`, plus the digits a count for one of
 * them might need) get to leave it standing; anything else — editing an
 * argument, answering, undo — is a normal-mode action that shouldn't inherit
 * a selection some earlier `v` left lying around.
 */
export function run(key: string, ctx: CommandContext): EditorState | null {
  const command = commands[key];
  if (!command) return null;
  const next = command(ctx);
  const spent = isDigit(key) ? next : { ...next, count: null };
  const kept =
    isDigit(key) || SELECTION_KEYS.has(key) ? spent : { ...spent, selectAnchor: null };
  return releaseSelection(releaseFocus(kept, ctx.flow), ctx.placed);
}
