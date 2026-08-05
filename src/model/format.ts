import type { Speech } from "./types";

/**
 * The debate format: which speeches there are, in what order, and whose they
 * are. The one description of the round the whole app reads — the sheet draws
 * a column per entry, the command line resolves `:2ac` against the labels, and
 * the keymap's count (`4a`) indexes into it.
 *
 * A module of its own because it is the thing that changes when another format
 * arrives. Nothing here is policy-specific except the values.
 */

// Policy debate speech order, 1AC … 2AR. The 2NC and 1NR are the consecutive
// negative speeches, flowed together as one column: the negative "block".
//
// `weight` is each speech's share of the sheet, and they are deliberately all
// the same. Giving the 1AC and 1NC less — they're read off prepared documents,
// so they get flowed in fewer words — reads as cramped rather than efficient:
// the two columns you refer back to most end up the hardest to read. Focus
// mode is the answer to a crowded sheet instead. The knob stays because a
// column's width is a real thing to want to tune.
//
// `side` is what the sheet shades by. The speeches alternate, so a sheet you
// aren't reading closely still reads as a conversation rather than as seven
// columns of text — and the answer to "where did the 2AC go" is a glance.
export const POLICY_SPEECHES: Speech[] = [
  { label: "1AC", weight: 1, side: "aff" },
  { label: "1NC", weight: 1, side: "neg" },
  { label: "2AC", weight: 1, side: "aff" },
  { label: "Block", weight: 1, side: "neg" },
  { label: "1AR", weight: 1, side: "aff" },
  { label: "2NR", weight: 1, side: "neg" },
  { label: "2AR", weight: 1, side: "aff" },
];
