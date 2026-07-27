import type { Flow } from "./Flow";
import type { Placed } from "./types";
import { moveCursor, type Motion } from "./navigate";

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
}

export const initialEditorState: EditorState = {
  cursorId: null,
  editingId: null,
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
  /** How many speech columns exist; nothing may be created past the last. */
  speechCount: number;
}

export type Command = (ctx: CommandContext) => EditorState;

/** Spatial cursor movement. Never mutates the flow. */
const motion =
  (m: Motion): Command =>
  ({ state, placed }) => ({
    ...state,
    cursorId: moveCursor(placed, state.cursorId, m),
  });

const edit: Command = ({ state }) =>
  state.cursorId ? { ...state, editingId: state.cursorId } : state;

/** Every creating command lands the cursor on the new card and opens it. */
const editing = (id: string): EditorState => ({ cursorId: id, editingId: id });

const respond: Command = ({ state, flow, speechCount }) => {
  if (!state.cursorId) return state;
  const speech = flow.speechOf(state.cursorId) + 1;
  if (speech >= speechCount) return state; // nothing past the last speech
  return editing(flow.addResponse(state.cursorId, "", speech));
};

const sibling: Command = ({ state, flow }) =>
  state.cursorId ? editing(flow.addSibling(state.cursorId, "")) : state;

/** A fresh argument tree, in the same speech column the cursor is in. */
const newRoot: Command = ({ state, flow }) => {
  const speech = state.cursorId ? flow.speechOf(state.cursorId) : 0;
  return editing(flow.addRoot(state.cursorId, "", speech));
};

/** Delete the cursor's card and its subtree; land on its parent. */
const remove: Command = ({ state, flow }) => {
  if (!state.cursorId) return state;
  const parent = flow.parentOf(state.cursorId);
  flow.remove(state.cursorId);
  return { cursorId: parent, editingId: null };
};

/**
 * Undo / redo. The cursor is left where it is: it usually still points at a
 * live card (undoing a text edit), and the editor drops it if the card it
 * names went away.
 */
const undo: Command = ({ state, flow }) => {
  flow.undo();
  return state;
};

const redo: Command = ({ state, flow }) => {
  flow.redo();
  return state;
};

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
  h: motion("h"),
  j: motion("j"),
  k: motion("k"),
  l: motion("l"),
  i: edit,
  Enter: edit,
  a: respond, // answer — a child, next speech column
  s: sibling, // another argument alongside, same column
  O: newRoot,
  x: remove,
  // Undo: vim's u / Ctrl-r, plus the platform chord this is a desktop app on.
  u: undo,
  "C-r": redo,
  "M-z": undo,
  "M-Z": redo,
};
