import type { Flow } from "../model/flow";
import type { Round, SheetInfo } from "../model/round";
import { FOCUS_REACH, type Placed, type Speech } from "../model/types";
import { selectionRange } from "../layout/navigate";

/**
 * What the editor knows, and the rules that keep it coherent.
 *
 * Split from the keymap (see commands.ts) because far more code needs to
 * *read* this state than to change it — the status line, the sheet, the
 * argument renderer — and none of them should have to pull in every command to
 * do it.
 *
 * The two `release*` functions below are the coherence rules: things that must
 * hold after any cursor movement, whatever caused it. They live here rather
 * than inside the motions so that *every* way of moving the cursor obeys them
 * — a keystroke, a jump to a far speech, an argument created two speeches
 * over, a click on a collapsed rectangle.
 */

export interface EditorState {
  /** The argument the cursor sits on, or null when nothing is selected. */
  cursorId: string | null;
  /** The argument being text-edited, or null. Suspends the keymap while set. */
  editingId: string | null;
  /**
   * Digits typed but not yet spent. They name a speech to the commands that
   * create an argument (`4a` answers in the 4th speech, not the next one) and
   * a repeat count to the motions (`3j`). Null when nothing is pending.
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
   * Where a visual selection began, or null when there isn't one. The
   * selection itself is never stored as a list — it's derived, whenever a
   * command needs it, from this and `cursorId` (see `selectedIds` in
   * commands.ts and `selectionRange` in navigate.ts). An anchor and a moving
   * cursor is everything a range needs, and it can't go stale the way a
   * captured list of ids could as the flow changes underneath it.
   */
  selectAnchor: string | null;
  /** Whether the list of sheets is showing. */
  sidebar: boolean;
  /**
   * Where the cursor was on each sheet you've left, so coming back puts you
   * where you were rather than at the top.
   *
   * Kept here rather than with the sheets themselves because it is not a fact
   * about the round — your partner's cursor on the politics DA has nothing to
   * do with yours. Written only when a sheet is left (see `openSheet`), so a
   * cursor moving doesn't touch it thirty times a minute.
   */
  cursors: Record<string, string | null>;
  /**
   * How large the sheet is drawn, as a multiple of its authored size. 1 is the
   * 10px type the flow is designed at.
   *
   * A scale rather than a font size because everything about an argument is
   * bound to its type — the number gutter, the row gap, the width a collapsed
   * speech keeps — and they all have to move together or the sheet stops
   * lining up.
   */
  zoom: number;
}

export const initialEditorState: EditorState = {
  cursorId: null,
  editingId: null,
  count: null,
  focus: null,
  command: null,
  selectAnchor: null,
  sidebar: true,
  cursors: {},
  zoom: 1,
};

/**
 * The round, as the keymap is allowed to touch it: which sheets there are,
 * which one is open, and the two things a keystroke does to that list.
 *
 * Handed in rather than reached for, because opening a sheet is not a state
 * transition — it changes which document the whole app is looking at, and that
 * lives in the session (see FlowSession.setActiveSheet). The commands here
 * return the editor state that should go with it.
 */
export interface SheetControls {
  list: SheetInfo[];
  active: string | null;
  open: (sheetId: string) => void;
  move: (sheetId: string, by: number) => void;
}

/**
 * Leaving one sheet for another: remember where the cursor was on the sheet
 * being left, and put it back where it was on the one being opened.
 *
 * Everything else is dropped. A selection, a pending count, a pinned speech and
 * an open editor are all about the sheet you were reading, and carrying any of
 * them across would apply them to arguments they were never about.
 */
export function openSheet(
  state: EditorState,
  from: string | null,
  to: string,
): EditorState {
  const cursors = from ? { ...state.cursors, [from]: state.cursorId } : state.cursors;
  return {
    ...state,
    cursors,
    cursorId: cursors[to] ?? null,
    editingId: null,
    count: null,
    focus: null,
    selectAnchor: null,
  };
}

export interface CommandContext {
  state: EditorState;
  flow: Flow;
  /**
   * The document the sheet belongs to. Only history reaches for it — undo is
   * the round's, not the sheet's, so undoing can carry you to another one.
   */
  round: Round;
  /** The round this sheet belongs to, as a list to move around in. */
  sheets: SheetControls;
  /**
   * The current layout. Only the motions need it — where an argument *sits* is
   * spatial. Anything that asks which speech an argument is in goes to the
   * flow, which owns that answer.
   */
  placed: Placed[];
  /** The speeches, in order. Their names are what the command line resolves. */
  speeches: Speech[];
}

export type Command = (ctx: CommandContext) => EditorState;

/**
 * Focus covers the pinned speech and the one either side. Take the cursor past
 * them and the sheet opens back up completely, rather than re-aiming at
 * wherever the cursor landed.
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

/**
 * Whether `state`'s selection still makes sense, and drop it if not — the
 * same shape as `releaseFocus`, and for the same reason: a click, a jump to a
 * named speech, or `h`/`l` leaving the column can each strand an anchor
 * somewhere the cursor no longer ranges over. `selectionRange` already treats
 * "no shared column" and "the anchor's argument is gone" as the same
 * not-a-range case, so emptiness is the one check this needs.
 */
export function releaseSelection(state: EditorState, placed: Placed[]): EditorState {
  if (state.selectAnchor === null) return state;
  const stillRanges = selectionRange(placed, state.selectAnchor, state.cursorId).length > 0;
  return stillRanges ? state : { ...state, selectAnchor: null };
}

/** Put the cursor on an argument from outside the keymap — a click — same rules. */
export function moveCursorTo(
  state: EditorState,
  flow: Flow,
  id: string,
  placed: Placed[],
): EditorState {
  return releaseSelection(releaseFocus({ ...state, cursorId: id }, flow), placed);
}
