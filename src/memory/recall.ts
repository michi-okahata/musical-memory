import type { Block } from "./store";

/**
 * Which block answers the argument in front of you.
 *
 * The hard part of the whole feature, and the reason it is its own file. An
 * argument is shorthand written under a speech timer, and the same argument is
 * never written the same way twice — "neg flex", "Neg Flex", "neg flex bad".
 * The store keys blocks on whatever this says they are (see store.rs, which
 * takes the key as a value and never works one out); everything about when two
 * arguments are the same argument is decided here — including for the blocks
 * read out of CardMirror files, which are keyed by this on their way in (see
 * cmir.ts) so that one rule covers everything a block can be found by.
 */

/** What matching ignores: case, and how much space is between the words. */
export function argumentKey(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Two position names that are the same position. Named the same way keys are. */
export function samePosition(a: string, b: string): boolean {
  return argumentKey(a) === argumentKey(b);
}

/**
 * Below this many characters, only an exact match counts. A two-character
 * argument is a prefix of half the file, and inserting four answers is not the
 * kind of thing to do on that evidence.
 */
const MIN_LOOSE = 3;

const NONE: Block[] = [];

/**
 * A list of blocks arranged for looking up, built once each time the list
 * changes.
 *
 * Lookup happens on every cursor movement and every keystroke — the status line
 * asks what ⌘P would insert, and the answer has to be there before the next
 * character is typed. A folder of files is a hundred thousand blocks, so
 * anything the lookup does *per block* is done a hundred thousand times per
 * keypress. This exists to make the two things it used to do per block —
 * normalising a position, and copying the matching ones into a new array —
 * happen once per change to the list instead.
 */
export interface Index {
  all: Block[];
  /** By key: the rung nearly every lookup lands on, answered without a walk. */
  byKey: Map<string, Block[]>;
  /** By position key, so preferring a position costs no per-block work. */
  byPosition: Map<string, Block[]>;
}

export function indexOf(blocks: Block[]): Index {
  const byKey = new Map<string, Block[]>();
  const byPosition = new Map<string, Block[]>();
  for (const block of blocks) {
    file(byKey, block.key, block);
    file(byPosition, argumentKey(block.position), block);
  }
  return { all: blocks, byKey, byPosition };
}

function file(into: Map<string, Block[]>, at: string, block: Block): void {
  const there = into.get(at);
  if (there) there.push(block);
  else into.set(at, [block]);
}

/** What there is to recall against the argument the cursor is on. */
export interface Recall {
  /**
   * The block ⌘P would insert, or null when there is nothing to insert —
   * which is either because nothing matched or because too much did.
   */
  block: Block | null;
  /**
   * How many files answer this argument, when more than one does and none of
   * them can be chosen between. Zero the rest of the time, including when the
   * answer is a single file's — it is the reason `block` is null and nothing
   * else, which is what lets the status line show it without qualification.
   */
  among: number;
}

const NOTHING: Recall = { block: null, among: 0 };

/**
 * What answers the argument in front of you: how well a block matches first,
 * and only then where it came from. A file's match counts only when it is the
 * only one — ⌘P inserts text, and a backfile has thirty "AT: Politics". Two
 * files holding the same block word for word are one answer, not two.
 */
export function recall(
  argument: string,
  memorized: Index,
  imported: Index,
  position: string,
): Recall {
  const key = argumentKey(argument);
  if (!key) return NOTHING;

  const found = best(key, argumentKey(position), memorized, imported);
  const ours = found.filter((block) => block.source === "");
  if (ours.length > 0) return { block: ours[0], among: 0 };

  const theirs = distinct(found);
  return theirs.length === 1
    ? { block: theirs[0], among: 0 }
    : { block: null, among: theirs.length };
}

/**
 * Every block on the best rung, across both lists at once.
 *
 * The position first, and only then everywhere: two disadvantages both have a
 * "no link" and they are not the same block, but a sheet you named slightly
 * differently this week should not lose you the block either. Which means a
 * file's block in this position beats one of your own from another — the
 * position is part of how well a block matches, not a tiebreak after it.
 */
function best(key: string, at: string, memorized: Index, imported: Index): Block[] {
  const here = rung(key, [
    memorized.byPosition.get(at) ?? NONE,
    imported.byPosition.get(at) ?? NONE,
  ]);
  if (here.length > 0) return here;

  // The exact rung, everywhere, without walking anything.
  const exact = [...(memorized.byKey.get(key) ?? NONE), ...(imported.byKey.get(key) ?? NONE)];
  if (exact.length > 0) return exact;

  return loose(key, [memorized.all, imported.all]);
}

/** The whole ladder over some groups of blocks: exact, then the loose rungs. */
function rung(key: string, groups: readonly Block[][]): Block[] {
  const exact = gather(groups, (block) => block.key === key);
  return exact.length > 0 ? exact : loose(key, groups);
}

/**
 * The two ways shorthand drifts, tried in turn —
 *
 *   - you wrote more this time than when you memorized it ("neg flex bad"
 *     finding the block under "neg flex"), so the longest key the argument
 *     starts with wins: the more of the key the argument spells out, the surer
 *     the match;
 *   - you wrote less ("neg flex" finding "neg flex bad"), so the shortest key
 *     starting with the argument wins, on the same reasoning read the other
 *     way.
 *
 * Rungs are never mixed, so everything returned matched equally well — which is
 * what makes "more than one" a real ambiguity. Nothing looks inside the middle
 * of an argument: "contains" would match a block against an argument that
 * merely mentions it, and this inserts text rather than suggesting it.
 */
function loose(key: string, groups: readonly Block[][]): Block[] {
  if (key.length < MIN_LOOSE) return [];

  let longest = 0;
  for (const group of groups) {
    for (const block of group) {
      if (key.startsWith(block.key) && block.key.length > longest) longest = block.key.length;
    }
  }
  if (longest > 0) {
    return gather(groups, (block) => block.key.length === longest && key.startsWith(block.key));
  }

  let shortest = 0;
  for (const group of groups) {
    for (const block of group) {
      if (!block.key.startsWith(key)) continue;
      if (shortest === 0 || block.key.length < shortest) shortest = block.key.length;
    }
  }
  if (shortest === 0) return [];
  return gather(groups, (block) => block.key.length === shortest && block.key.startsWith(key));
}

function gather(groups: readonly Block[][], want: (block: Block) => boolean): Block[] {
  const out: Block[] = [];
  for (const group of groups) {
    for (const block of group) {
      if (want(block)) out.push(block);
    }
  }
  return out;
}

/** The same block written down in two files is one block. */
function distinct(blocks: Block[]): Block[] {
  if (blocks.length < 2) return blocks;
  const seen = new Set<string>();
  return blocks.filter((block) => {
    // Joined on a newline, which neither a block heading nor an answer can
    // contain: they are single lines by construction, so no two different
    // blocks can be flattened into the same string.
    const said = [block.argument, ...block.answers].join("\n");
    if (seen.has(said)) return false;
    seen.add(said);
    return true;
  });
}
