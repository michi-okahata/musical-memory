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
  children: Argument[];
}

/** An argument's slot in the grid: which column, which row, how many rows tall. */
export interface Placed {
  id: string;
  col: number;
  row: number;
  span: number;
}
