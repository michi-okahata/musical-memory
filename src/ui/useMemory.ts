import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { canRemember, memorize, readBlocks, type Block } from "../memory/store";
import { argumentKey, blockFor } from "../memory/recall";

/**
 * The blocks the user has memorized, held in memory for the length of a session
 * and written through to `~/.flow` as they change.
 *
 * Read once, at launch. Every cursor movement asks this whether the argument it
 * landed on is one there are answers for — that is what the status line says
 * and what `A` acts on — and nothing about moving the cursor should reach the
 * disk. So the store is the copy of record and this is the copy that is *used*,
 * with writes going to both.
 *
 * A hook rather than a store like `FlowSession`, on the same terms as
 * `useLibrary`: there is no socket and no clock here, only a list that changes
 * when a key is pressed.
 */

export interface Memory {
  /** Everything memorized, in every position. */
  blocks: Block[];
  /**
   * The block answering this argument in this position, or null. The position
   * is a preference and not a filter — see `blockFor`.
   */
  answersTo: (argument: string, position: string) => Block | null;
  /**
   * Memorize these answers to this argument, replacing whatever was there. No
   * answers forgets it.
   */
  keep: (position: string, argument: string, answers: string[]) => void;
  /**
   * Read `~/.flow` again. Called when the memory sheet has been editing the
   * store behind this list's back (see useMemoryRound.ts) — that hook writes
   * whole positions at a time, and this is how what it wrote gets back to the
   * one line `A` will insert.
   */
  refresh: () => void;
  /** Report a failure from something else writing to the store — see `flush`. */
  report: (reason: unknown) => void;
  /**
   * What went wrong last, if anything. A browser tab, which has no home
   * directory to keep a `.flow` in, reports itself here the first time you
   * press `m` rather than by making the key do nothing — the same way
   * `useLibrary` answers `:save`.
   */
  error: string | null;
}

export function useMemory(): Memory {
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    if (!canRemember()) return;
    readBlocks().then(setBlocks, (reason) => setError(String(reason)));
  }, []);

  useEffect(() => {
    if (!canRemember()) return;
    // Dropped if the component goes before the read lands — this runs twice
    // under StrictMode, and the throwaway pass must not set state.
    let live = true;
    readBlocks().then(
      (read) => live && setBlocks(read),
      (reason) => live && setError(String(reason)),
    );
    return () => {
      live = false;
    };
  }, []);

  // Read at call time rather than closed over, so that `keep` doesn't have to
  // be rebuilt — and the keymap resubscribed — every time a block changes. Same
  // reason `useLibrary` holds the round in a ref.
  const blocksRef = useRef(blocks);
  blocksRef.current = blocks;

  const keep = useCallback((position: string, argument: string, answers: string[]) => {
    const key = argumentKey(argument);
    // An argument with no text of its own is not something answers can be found
    // by later, so there is nothing to memorize them under.
    if (!key) return;
    if (!canRemember()) {
      setError("memorizing needs the desktop app");
      return;
    }

    const lines = answers.map((answer) => answer.trim()).filter(Boolean);
    const at = position.trim();
    // Applied here first and written after: `m` is pressed mid-speech and the
    // status line has to answer immediately. A failed write puts the list back
    // rather than leaving the screen claiming something the disk doesn't say.
    const before = blocksRef.current;
    setBlocks((prev) => {
      const rest = prev.filter((block) => !(block.key === key && block.position === at));
      return lines.length === 0
        ? rest
        : [...rest, { position: at, key, argument: argument.trim(), answers: lines }];
    });
    memorize(at, key, argument.trim(), lines).then(
      () => setError(null),
      (reason) => {
        setBlocks(before);
        setError(String(reason));
      },
    );
  }, []);

  const answersTo = useCallback(
    (argument: string, position: string) => blockFor(argument, blocks, position),
    [blocks],
  );

  // One object, held between renders: the keymap takes this whole thing as part
  // of its context, and a fresh one every render would have it dropping and
  // re-attaching its window listener for nothing.
  const report = useCallback((reason: unknown) => setError(String(reason)), []);

  return useMemo(
    () => ({ blocks, answersTo, keep, refresh, report, error }),
    [blocks, answersTo, keep, refresh, report, error],
  );
}
