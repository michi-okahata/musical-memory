/**
 * The shared vocabulary of a flow. Deliberately dependency-free: the CRDT
 * model, the layout, the keymap and the components all speak these types, so
 * they must not pull any of those directions in.
 */

/**
 * An argument and everything responding to it, as an immutable snapshot.
 * Produced by `Flow.roots()` and handed to layout and rendering.
 */
export interface Argument {
  id: string;
  /** The speech column it sits in: 0 = first speech, 1 = next, … */
  speech: number;
  text: string;
  /** How it is marked off from its neighbours. See `Mark`. */
  mark: Mark;
  children: Argument[];
}

/**
 * How an argument is marked off: "1. 2. 3.", "a. b. c.", or not at all.
 *
 * Carried by each argument rather than by any list object, because a column
 * holds no single list to put it on: a numbered run, a lettered aside and a
 * few unmarked points can all sit in one speech, interleaved, answering
 * different arguments. What counts as a list is worked out at layout time
 * instead — everything in a column marked the same way is one sequence, so
 * the arguments that share a mark are the list, and interrupting them
 * doesn't end it (see `markIndices`).
 */
export type Mark = "num" | "alpha" | "none";

/** What an argument is marked with when nothing nearby suggests otherwise. */
export const DEFAULT_MARK: Mark = "num";

/** An argument's slot in the grid: which column, which row, how many rows tall. */
export interface Placed {
  id: string;
  col: number;
  row: number;
  span: number;
  /** How far down the chain of responses it is; 0 for a top-level argument. */
  depth: number;
  /**
   * Where the argument comes in its own sequence — among the siblings sharing
   * its speech column *and* its mark, counting from 1, so an interruption
   * marked differently doesn't reset it. Null when nothing else in the column
   * is marked as it is, and a bare "1." would be noise. `markerOf` turns it
   * into the "1" or the "a" that gets drawn.
   */
  index: number | null;
}

/**
 * How far either side of the focused speech stays expanded: the speech before
 * it and the one after. Shared vocabulary because two places must agree on it
 * — the view decides which columns to collapse, and the keymap decides when
 * the cursor has left the focused region and focus should drop.
 */
export const FOCUS_REACH = 1;

/** Which side of the debate gives a speech. Drawn as a shade, not a label. */
export type Side = "aff" | "neg";

/** A column of the sheet: one speech, and how much of the width it earns. */
export interface Speech {
  label: string;
  /**
   * Whose speech it is. Carried on the speech rather than read out of the
   * label, because the labels are a convention ("Block" says nothing about a
   * side) and a different format would bring different ones.
   */
  side: Side;
  /**
   * Share of the sheet's width, relative to the other speeches. The speeches
   * read off a prepared document — the 1AC, the 1NC — get flowed in far less
   * text than the ones a debater writes live, so they earn less room.
   */
  weight: number;
}
