import type { Mark } from "../model/types";

/**
 * An answer as a block writes it: "1. no link" rather than a mark beside a
 * string.
 *
 * A block is text and cannot be anything else. Half of them are read out of
 * CardMirror files (see cmir.ts), whose shape belongs to CardMirror and will
 * never carry a `Mark`, and the store keeps answers as lines for the same
 * reason. So a design where a block *remembers* how it was marked works for the
 * ones you memorized and silently not for a backfile — which is the worst of
 * the three possible outcomes.
 *
 * Text is therefore the interchange format, and the field stays the working
 * representation: the mark is written into the line on the way out and read
 * back off it on the way in. Nothing downstream of `decodeAnswer` deals in
 * prefixes, and nothing upstream of `encodeAnswer` deals in marks.
 *
 * Only the *notation* survives the trip, never the number. Which one an answer
 * is comes from where it sits in the run it lands in (see `markIndices`), so a
 * block whose lines say 1., 5., 7. — hand-written, or memorized from a run
 * something was later deleted out of — comes back 1., 2., 3. That is the same
 * derivation the sheet has always done, and it is why the store is allowed to
 * be a little bit wrong about the counting.
 */

/**
 * What `markerOf` writes, plus the punctuation a written list has and a drawn
 * one doesn't: the sheet puts "1" in its own gutter, where the column does the
 * work the dot does in a line of text.
 *
 * An unmarked answer is written as itself — "absent" and "no mark" are the same
 * thing here, so a block nobody numbered reads back exactly as it went in, and
 * a CardMirror file that never heard of any of this reads as what it is.
 */
export function encodeAnswer(marker: string, text: string): string {
  return marker ? `${marker}. ${text}` : text;
}

/**
 * A leading marker, and the answer without it.
 *
 * Strict about the punctuation and the space after it, because flow shorthand
 * is full of leading characters that are not marks: "2AC 3 — no link", "50
 * states solve", "2 turns". Requiring "1." or "1)" *and* a space is what tells
 * a mark from an argument that merely starts with a digit.
 *
 * `)` is accepted although nothing here writes one — a backfile written by hand
 * is as likely to say "1)" as "1.", and reading one costs nothing.
 *
 * A misread is cheap on purpose, and this is the reason the parse lives on the
 * *answers*: a block is found by its argument (see `argumentKey`), and answers
 * key nothing. Guessing wrong here costs a marker on a sheet. Guessing wrong on
 * the argument would cost the lookup, which is why that text is left alone.
 */
export function decodeAnswer(line: string): { mark: Mark; text: string } {
  const found = MARKED.exec(line);
  if (!found) return { mark: "none", text: line };
  return {
    mark: /[0-9]/.test(found[1]) ? "num" : "alpha",
    text: line.slice(found[0].length),
  };
}

/**
 * Digits or letters, bounded: a marker is "1." or "aa." long, and letting it
 * run further would start matching sentences. Lower-case only for the letters,
 * since that is the sequence `markerOf` draws.
 */
const MARKED = /^([0-9]{1,3}|[a-z]{1,3})[.)]\s+/;
