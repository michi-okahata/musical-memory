import type { Flow } from "./flow_crdt";
import { FOCUS_REACH, type Placed, type Speech } from "./types";
import { moveCursor, moveToColumn, type Motion } from "./navigate";

/**
 * Vim-style editing on top of a `Flow`.
 *
 * Every key is one `Command`: a function from the current editor state to the
 * next one. Commands may mutate the flow (that's the point), but the state
 * transition itself is pure, so the whole keymap is testable without a DOM —
 * build a `Flow`, lay it out, and assert on the state a command returns.
 */

export interface EditorState {
  /** The card the cursor sits on, or null when nothing is selected. */
  cursorId: string | null;
  /** The card being text-edited, or null. Suspends the keymap while set. */
  editingId: string | null;
  /**
   * Digits typed but not yet spent. They name a speech to the commands that
   * create a card (`4a` answers in the 4th speech, not the next one) and a
   * repeat count to the motions (`3j`). Null when nothing is pending.
   */
  count: number | null;
  /**
   * The speech the sheet is pinned to, or null when the whole flow is shown.
   *
   * Pinned rather than derived from the cursor: it stays put while you work
   * across the focused speech and its two neighbours, and drops the moment the
   * cursor leaves them. Focus that re-aimed itself on every move made the
   * sheet slide around underneath you.
   */
  focus: number | null;
  /**
   * The command line's contents while it's open, or null when it isn't. Empty
   * string means open but nothing typed yet — which is why this can't just be
   * a string.
   */
  command: string | null;
  /**
   * How large the sheet is drawn, as a multiple of its authored size. 1 is the
   * 10px type the flow is designed at.
   *
   * A scale rather than a font size because everything about a card is bound
   * to its type — the number gutter, the row gap, the width a collapsed speech
   * keeps — and they all have to move together or the sheet stops lining up.
   */
  zoom: number;
}

export const initialEditorState: EditorState = {
  cursorId: null,
  editingId: null,
  count: null,
  focus: null,
  command: null,
  zoom: 1,
};

export interface CommandContext {
  state: EditorState;
  flow: Flow;
  /**
   * The current layout. Only the motions need it — where an argument *sits* is
   * spatial. Anything that asks which speech a card is in goes to the flow,
   * which owns that answer.
   */
  placed: Placed[];
  /** The speeches, in order. Their names are what the command line resolves. */
  speeches: Speech[];
}

export type Command = (ctx: CommandContext) => EditorState;

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

/** Every creating command lands the cursor on the new card and opens it. */
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

/** Delete the cursor's card and its subtree; land on its parent. */
const remove: Command = ({ state, flow }) => {
  if (!state.cursorId) return state;
  const parent = flow.parentOf(state.cursorId);
  flow.remove(state.cursorId);
  return { ...state, cursorId: parent, editingId: null, count: null };
};

/**
 * Undo / redo, landing the cursor where the change was made rather than
 * wherever it happens to be now — undoing a delete puts you back on the card
 * that came back, not on its parent.
 */
const history =
  (direction: "undo" | "redo"): Command =>
  ({ state, flow }) => {
    const at = direction === "undo" ? flow.undo() : flow.redo();
    if (at === undefined) return state; // nothing on that stack
    return {
      ...state,
      cursorId: at && flow.has(at) ? at : state.cursorId,
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

/**
 * Scale the sheet by `factor`, clamped. Exported because zoom has a second way
 * in — a trackpad pinch — and both must land on the same state.
 */
export function scaleZoom(state: EditorState, factor: number): EditorState {
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
 * would be ambiguous as a card command anyway (insert text, or insert an
 * argument?), and a mis-pressed `i` that silently made a card would swallow
 * the edit you meant to type.
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
  // Zoom, on the keys it is drawn on. Deliberately not the platform chord:
  // Cmd +/- is the browser's own zoom and can't be taken off it, so binding
  // them here would scale the sheet twice over.
  "+": zoomBy(ZOOM_STEP),
  "_": zoomBy(1 / ZOOM_STEP),
  "=": resetZoom,
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
 * Focus covers the pinned speech and the one either side. Take the cursor past
 * them and the sheet opens back up completely, rather than re-aiming at
 * wherever the cursor landed.
 *
 * Applied to whole states rather than inside the motions so that *every* way
 * of moving the cursor obeys it — a keystroke, a jump to a far speech, a card
 * created two speeches over, a click on a collapsed rectangle.
 */
export function releaseFocus(state: EditorState, flow: Flow): EditorState {
  if (state.focus === null) return state;
  // No cursor to judge by (it was just deleted, say): leave the pin alone.
  if (!state.cursorId || !flow.has(state.cursorId)) return state;
  const col = flow.speechOf(state.cursorId);
  return Math.abs(col - state.focus) <= FOCUS_REACH
    ? state
    : { ...state, focus: null };
}

/** Put the cursor on a card from outside the keymap — a click — same rules. */
export function moveCursorTo(
  state: EditorState,
  flow: Flow,
  id: string,
): EditorState {
  return releaseFocus({ ...state, cursorId: id }, flow);
}

/**
 * Run whatever `key` is bound to. Returns null when nothing is — the caller
 * should leave the event alone rather than swallowing it.
 *
 * Clearing the pending count lives here and not in the commands: only the
 * digits build it up, and every other key spends it and is done.
 */
export function run(key: string, ctx: CommandContext): EditorState | null {
  const command = commands[key];
  if (!command) return null;
  const next = command(ctx);
  const spent = isDigit(key) ? next : { ...next, count: null };
  return releaseFocus(spent, ctx.flow);
}
