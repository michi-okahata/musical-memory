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
  /** How the cards in its group are numbered. See `Mark`. */
  mark: Mark;
  children: Argument[];
}

/**
 * How a run of arguments is marked off: "1. 2. 3.", "a. b. c.", or not at all.
 *
 * A property of the *group* — the siblings sharing a parent and a speech column
 * — rather than of one card, because it is a fact about a list and not about
 * any member of it: "1, b, 3" is not a thing anyone means. It is nonetheless
 * stored on each card, since a group is a relationship and has nowhere of its
 * own to keep anything; the flow keeps the group's cards in agreement, so a
 * card's own mark is always the group's.
 */
export type Mark = "num" | "alpha" | "none";

/** What the cards of a brand-new group are marked with. */
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
   * The number written beside the card — its place among the responses sharing
   * both its parent and its speech column, counting from 1. Null when it is
   * the only one in that group, where a bare "1." is just noise.
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
