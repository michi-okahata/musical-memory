import type { Block } from "./store";

/**
 * Which memorized block answers the argument in front of you.
 *
 * The hard part of the whole feature, and the reason it is its own file. An
 * argument is shorthand written under a speech timer, and the same argument is
 * never written the same way twice — "neg flex", "Neg Flex", "neg flex bad".
 * The store keys blocks on whatever this says they are (see store.rs, which
 * takes the key as a value and never works one out); everything about when two
 * arguments are the same argument is decided here.
 */

/** What matching ignores: case, and how much space is between the words. */
export function argumentKey(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Below this many characters, only an exact match counts. A two-character
 * argument is a prefix of half the file, and inserting four answers is not the
 * kind of thing to do on that evidence.
 */
const MIN_LOOSE = 3;

/**
 * The block memorized against `argument`, or null.
 *
 * The same ladder `resolveSheet` walks, for the same reason: an exact name
 * always wins, and failing that the most specific thing that could have been
 * meant. Here the two loose rungs are the two ways shorthand drifts —
 *
 *   - you wrote more this time than when you memorized it ("neg flex bad"
 *     finding the block under "neg flex"), so the longest key the argument
 *     starts with wins: the more of the key the argument spells out, the surer
 *     the match;
 *   - you wrote less ("neg flex" finding "neg flex bad"), so the shortest key
 *     starting with the argument wins, on the same reasoning read the other
 *     way.
 *
 * Nothing looks inside the middle of an argument. "Contains" would match a
 * block against an argument that merely mentions it, and this inserts text —
 * it has to be wrong less often than a suggestion does.
 */
export function blockFor(
  argument: string,
  blocks: Block[],
  position: string,
): Block | null {
  // The position first, and only then everywhere. Two disadvantages both have
  // a "no link" and they are not the same block — but a position you have
  // renamed since, or a sheet you called something slightly different this
  // week, should not lose you the block either. So this is a preference and
  // not a wall, exactly as the display side of it is a filter you can lift.
  const here = blocks.filter((block) => samePosition(block.position, position));
  return match(argument, here) ?? match(argument, blocks);
}

/** Two position names that are the same position. Named the same way keys are. */
export function samePosition(a: string, b: string): boolean {
  return argumentKey(a) === argumentKey(b);
}

function match(argument: string, blocks: Block[]): Block | null {
  const key = argumentKey(argument);
  if (!key) return null;

  const exact = blocks.find((block) => block.key === key);
  if (exact) return exact;
  if (key.length < MIN_LOOSE) return null;

  let best: Block | null = null;
  for (const block of blocks) {
    if (!key.startsWith(block.key)) continue;
    if (!best || block.key.length > best.key.length) best = block;
  }
  if (best) return best;

  for (const block of blocks) {
    if (!block.key.startsWith(key)) continue;
    if (!best || block.key.length < best.key.length) best = block;
  }
  return best;
}
