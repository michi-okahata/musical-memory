import { markIndices, markerOf } from "../layout/grid";
import { Round } from "../model/round";
import type { Argument, Speech } from "../model/types";
import { decodeAnswer, encodeAnswer } from "./answer";
import { argumentKey, samePosition } from "./recall";
import type { Block } from "./store";

/**
 * What you have memorized, as a round.
 *
 * The insight the whole memory sheet rests on: a block is an argument with
 * answers under it, which is exactly what a flow is. So the library is not a
 * new kind of document needing a new kind of screen — it is a `Round` whose
 * sheets are your positions and whose arguments come out of `~/.flow`. Every
 * key already works on it, the layout already knows how to draw it, and undo
 * is the round's own.
 *
 * This module is the two conversions and nothing else: blocks to a round, and
 * a round's arguments back to blocks. When to run them is useMemoryRound.ts's,
 * exactly as files/format.ts is to useLibrary.ts.
 */

/**
 * The two columns. Sides rather than labels are what shade them, so the
 * answers read as answers on a memory sheet for the same reason the negative
 * speeches do on a flow.
 *
 * The answers get the wider share: on a flow the columns are all equal because
 * every speech is written in, but here the left column holds one line and the
 * right holds a block of them.
 */
export const MEMORY_SPEECHES: Speech[] = [
  { label: "memorized", weight: 1, side: "aff" },
  { label: "answers", weight: 1.5, side: "neg" },
];

/**
 * What the sheet for blocks with no position is called.
 *
 * They are the ones memorized on an untitled sheet, and they are not an error
 * — positions are a filter, not a filing requirement. Bracketed because it is
 * a heading rather than a name, and because renaming this sheet is exactly how
 * a loose block gets filed: the rename moves every block under it.
 */
export const LOOSE = "(loose)";

/** A position's name as the store keeps it: `LOOSE` is how "none" is written. */
export function positionOf(title: string): string {
  return title === LOOSE ? "" : title.trim();
}

/** And back, for the sheet that shows it. */
export function titleOf(position: string): string {
  return position.trim() === "" ? LOOSE : position;
}

/** An argument and its answers on their way to the store. */
export interface Draft {
  key: string;
  argument: string;
  answers: string[];
}

/**
 * Every position there is anything to show, in the order the sheets go in:
 * alphabetical, with the loose blocks last because they are the leftovers.
 *
 * `also` is positions with nothing in them yet — the sheet you are standing on
 * when you press `M`, which has to be there to be written into even though it
 * has never been memorized against.
 */
export function positionsIn(blocks: Block[], also: string[] = []): string[] {
  const seen: string[] = [];
  for (const name of [...blocks.map((block) => block.position), ...also]) {
    if (!seen.some((known) => samePosition(known, name))) seen.push(name.trim());
  }
  const named = seen.filter((name) => name !== "").sort((a, b) => a.localeCompare(b));
  return seen.some((name) => name === "") ? [...named, ""] : named;
}

/**
 * Build the round. One sheet per position, one root per block, one response
 * per answer.
 *
 * The history is cleared once it is built, so that `u` on a memory sheet can
 * undo what you have just done to a block and never the act of loading it —
 * which would empty the sheet, and be written straight back to `~/.flow`.
 */
export function roundOf(blocks: Block[], also: string[] = []): Round {
  const round = new Round();
  for (const position of positionsIn(blocks, also)) {
    const flow = round.flow(round.addSheet(titleOf(position)));
    const mine = blocks.filter((block) => samePosition(block.position, position));
    flow.batch(() => {
      for (const block of mine) {
        const root = flow.addRoot(null, block.argument, 0);
        for (const line of block.answers) {
          // The mark comes off the line rather than from the answer above it:
          // the block said how it was marked, and inheriting instead would let
          // the first answer decide for the rest of a block it was memorized
          // alongside. `add` rather than `addResponse` because an explicit
          // mark is exactly what that wrapper doesn't take.
          const { mark, text } = decodeAnswer(line);
          flow.add({ under: root }, { text, speech: 1, mark });
        }
      }
    });
  }
  round.clearHistory();
  return round;
}

/**
 * A block is text, and deliberately not more. In particular it does not
 * remember whether each answer was a card (see `Support`): what you have
 * memorized is what you would *say*, and whether you have evidence for it is a
 * fact about the file you are carrying into this round, not about the block.
 * So recalled answers take the support of whatever they land beside, the same
 * as anything else `add` creates, and `c` corrects them where that is wrong.
 *
 * The mark is the one that goes the other way, and the difference is worth
 * stating. Whether four answers are a numbered list is not a fact about your
 * evidence, it is the shape of the block itself — it is what makes them four
 * answers rather than a paragraph — so it travels with it. It travels *as
 * text* because text is all a block can hold (see answer.ts).
 */

/**
 * The blocks a memory sheet is now describing.
 *
 * Only the top two rows of the tree mean anything: a root is an argument and
 * its children are the answers. Anything deeper is an answer to an answer,
 * which a block has no room for — it is dropped rather than flattened, because
 * flattening would put a line in the block that nobody wrote there.
 *
 * An argument with no text is skipped: `n` makes one before you have typed it,
 * and a block cannot be found by an argument that isn't anything yet.
 */
export function blocksIn(roots: Argument[]): Draft[] {
  const drafts: Draft[] = [];
  for (const root of roots) {
    const key = argumentKey(root.text);
    if (!key) continue;
    // Emptied answers are dropped before the run is counted, not after, so the
    // block is numbered as it will read rather than around a gap nobody can
    // see. What the numbers actually come out as on the way back in is the
    // landing sheet's business either way — see answer.ts.
    const written = root.children.filter((child) => child.text.trim());
    const indices = markIndices(written);
    drafts.push({
      key,
      argument: root.text.trim(),
      answers: written.map((child) =>
        encodeAnswer(markerOf(indices.get(child.id) ?? null, child.mark), child.text.trim()),
      ),
    });
  }
  return drafts;
}

/** Whether two drafts say the same thing, for deciding what needs writing. */
export function same(a: Draft, b: Draft): boolean {
  return (
    a.key === b.key &&
    a.argument === b.argument &&
    a.answers.length === b.answers.length &&
    a.answers.every((answer, at) => answer === b.answers[at])
  );
}

/** What a position's sheet held the last time the store was written. */
export interface Kept {
  /** Its title then, so a rename is seen as a rename and not as a new position. */
  title: string;
  blocks: Draft[];
}

/** One thing to do to the store. `memorize` with no answers is a forget. */
export type Write =
  | { do: "rename"; from: string; to: string }
  | {
      do: "memorize";
      position: string;
      key: string;
      argument: string;
      answers: string[];
    };

/**
 * What has to happen to `~/.flow` for it to say what the memory sheet now
 * says, given what it said when we last looked.
 *
 * Pure, and separate from the hook that runs it, because this is the piece that
 * can lose somebody a season of blocks — worth being able to test alone.
 *
 * Three rules, in this order:
 *
 *   - a sheet whose title has changed is a position renamed, and the rename
 *     moves every block under it. It goes first, so that the comparison after
 *     it is against those same blocks under their new name rather than against
 *     an empty position — which would write every one of them again and leave
 *     the old copies behind;
 *   - a block that is new or has changed is written;
 *   - a block that was there and isn't now is forgotten, and so is every block
 *     of a position whose sheet has gone.
 */
export function writesFor(
  sheets: { id: string; title: string; blocks: Draft[] }[],
  kept: Map<string, Kept>,
): { writes: Write[]; kept: Map<string, Kept> } {
  const writes: Write[] = [];
  const next = new Map<string, Kept>();

  for (const sheet of sheets) {
    const was = kept.get(sheet.id);
    const position = positionOf(sheet.title);
    if (was && was.title !== sheet.title) {
      writes.push({ do: "rename", from: positionOf(was.title), to: position });
    }

    for (const draft of sheet.blocks) {
      const before = was?.blocks.find((block) => block.key === draft.key);
      if (before && same(before, draft)) continue;
      writes.push({ do: "memorize", position, ...draft });
    }
    for (const gone of was?.blocks ?? []) {
      if (sheet.blocks.some((draft) => draft.key === gone.key)) continue;
      writes.push({ do: "memorize", position, ...gone, answers: [] });
    }
    next.set(sheet.id, { title: sheet.title, blocks: sheet.blocks });
  }

  for (const [id, was] of kept) {
    if (sheets.some((sheet) => sheet.id === id)) continue;
    for (const block of was.blocks) {
      writes.push({ do: "memorize", position: positionOf(was.title), ...block, answers: [] });
    }
  }

  return { writes, kept: next };
}
