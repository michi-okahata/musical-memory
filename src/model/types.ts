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
  /** Whether it was read off evidence or spoken. See `Support`. */
  support: Support;
  children: Argument[];
}

/**
 * An argument lifted off the sheet, with everything responding to it — what
 * `y` keeps and `p` puts back (see `Flow.copy` and the keymap).
 *
 * Plain data rather than ids, because the arguments a copy was taken from can
 * be deleted, rewritten, or on a sheet you have since closed, and a copy has to
 * outlive all three. No id of its own for the same reason: what `p` writes is a
 * new argument every time, not a second appearance of an old one.
 */
export interface Copied {
  text: string;
  mark: Mark;
  support: Support;
  /**
   * The column it was taken from.
   *
   * Not where it goes: `p` shifts the whole copy by the distance from its top to
   * the destination, so an exchange copied out of the 1AC keeps its shape a
   * speech later. Worth recording because it is the only sensible default when
   * nothing names a column — `p` onto a sheet with no cursor, which is the
   * "file this under that position" gesture.
   */
  speech: number;
  children: Copied[];
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

/**
 * Whether an argument was read off evidence or simply spoken: a *card* is a
 * quoted source, an *analytic* is the debater's own reasoning.
 *
 * The one distinction on a flow that isn't about structure, and it is here
 * because rebuttals turn on it — "they have no cards on this" is an argument,
 * and a dropped card is a different problem from a dropped analytic. Scanning a
 * column for which of its points are actually carded is a thing debaters do
 * with a pen, and it is the only reading of the sheet the shorthand itself
 * can't answer.
 *
 * Note this is a *flag*, not evidence: the card's text never comes onto a flow.
 * The sheet holds shorthand, and what marking one as a card buys you is the
 * glance, not the quotation.
 *
 * Orthogonal to `Mark` on purpose, and per-argument for the same reason `Mark`
 * is: the 1NC alternates cards and analytics freely, with no group to hang it
 * on.
 */
export type Support = "card" | "analytic";

/**
 * What an argument counts as when nothing nearby suggests otherwise.
 *
 * `card`, so that a sheet nobody has pressed `c` on looks exactly as it always
 * did — the distinction is opt-in, and a debater who never reaches for it is
 * never shown a sheet full of marks about a question they aren't asking. New
 * arguments inherit from their same-speech neighbour anyway (see
 * `neighborSupport`), so in practice this decides only the first argument in a
 * column and the rest follow whatever you said about that one.
 */
export const DEFAULT_SUPPORT: Support = "card";

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
 * How far either side of the pinned speech stays on screen: the speech before
 * it and the one after, so `f` shows three columns.
 *
 * Shared vocabulary because two places must agree on it, and they use it
 * differently. The view turns it into the columns actually drawn (`focusRange`
 * in FlowSheet, which slides the window inward at the ends of the round so a
 * pin on the 1AC still gets three). The keymap uses it to decide when the
 * cursor has left that window, and slides the pin by one to follow rather than
 * dropping it (`followFocus` in editor/state.ts).
 */
export const FOCUS_REACH = 1;

/**
 * Who is holding a pen. A flow is written by people in the room, and — the
 * direction this is built for — by an assistant transcribing the speech as it
 * happens. Both are peers on the same document; the role is what lets the sheet
 * say which is which, so an argument that appeared without anyone typing it can
 * be read as what it is.
 */
export type Role = "human" | "ai";

/**
 * A peer as the document remembers it, rather than as the network sees it.
 * Written once per peer (see `Flow.identify`) so that an argument flowed by
 * someone who has since closed their laptop can still be attributed.
 */
export interface PeerRecord {
  name: string;
  role: Role;
}

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
