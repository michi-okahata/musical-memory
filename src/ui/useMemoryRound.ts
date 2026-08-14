import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Flow } from "../model/flow";
import type { Round, SheetInfo } from "../model/round";
import type { Argument } from "../model/types";
import {
  blocksIn,
  roundOf,
  titleOf,
  writesFor,
  type Kept,
} from "../memory/sheet";
import { canRemember, memorize, renamePosition } from "../memory/store";
import type { Memory } from "./useMemory";

/**
 * The memory sheet: `~/.flow` as a round you can flow on.
 *
 * Built when `M` is pressed and thrown away when it is pressed again. It hands
 * back the same five things `useSession` does for the real round, so everything
 * downstream is looking at *a* round and never has to ask which, and it is
 * written back as it changes the way `useLibrary` writes a round to disk.
 *
 * The one rule that makes this safe: while the sheet is open it is the source
 * of truth and the store follows it. Nothing rebuilds the round behind the
 * user's back — a rebuild mid-edit would take the cursor, the undo history and
 * a half-typed argument with it.
 */

/** How long after the last change the store is written. As `useLibrary`. */
const SAVE_DELAY_MS = 600;

export interface MemorySheet {
  round: Round | null;
  flow: Flow | null;
  roots: Argument[];
  /** The positions, as sheets. */
  sheets: SheetInfo[];
  activeSheet: string | null;
  open: (sheetId: string) => void;
}

export function useMemoryRound(
  memory: Memory,
  /** Whether the memory sheet is up. */
  showing: boolean,
  /** The position to open on — the title of the sheet `M` was pressed on. */
  at: string,
): MemorySheet {
  const [round, setRound] = useState<Round | null>(null);
  const [activeSheet, setActiveSheet] = useState<string | null>(null);
  // Bumped on every change to the round, which is what turns a Loro document
  // into something React re-reads. The round itself is the state; this is only
  // the news that it moved.
  const [version, setVersion] = useState(0);

  const written = useRef(new Map<string, Kept>());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const roundRef = useRef<Round | null>(null);
  roundRef.current = round;
  // The blocks as of the moment the sheet is opened. A ref, so that the store
  // loading or `m` firing does not rebuild a sheet that is being edited.
  //
  // The user's own blocks and no others. What is on this sheet is what the
  // store is made to say (see `writesFor`), which means a block that is in
  // `~/.flow` and not here is one this hook deletes — so a folder of imported
  // blocks put on it would be a folder of imported blocks deleted the moment
  // anything was edited. They are not the user's to edit here and they are
  // read again from the files whenever they change.
  const blocksRef = useRef(memory.memorized);
  blocksRef.current = memory.memorized;
  const refresh = memory.refresh;
  const report = memory.report;

  /** Work out what the store is owed (see `writesFor`) and pay it. */
  const write = useCallback(async () => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const current = roundRef.current;
    // A browser tab has no `.flow` to write to. It can still open the memory
    // sheet — it will be empty, and editing it is a way to see what the sheet
    // is — but there is nowhere to put what is written, and `m` has already
    // said so rather than this saying it again on a timer.
    if (!current || !canRemember()) return;

    const { writes, kept } = writesFor(
      current.sheets().map((sheet) => ({
        ...sheet,
        blocks: blocksIn(current.flow(sheet.id).roots()),
      })),
      written.current,
    );
    for (const write of writes) {
      if (write.do === "rename") await renamePosition(write.from, write.to);
      else await memorize(write.position, write.key, write.argument, write.answers);
    }
    // Only once every one of them has landed. A write that threw leaves this
    // describing what the store held before, so the next change works the same
    // difference out again and tries the lot once more.
    written.current = kept;
  }, []);

  /**
   * The same, with somewhere for a failure to go. A write that fails leaves
   * `written` describing what the store *doesn't* hold, so the next change
   * writes it again — which is the behaviour worth having: the sheet on screen
   * keeps trying to become the file.
   */
  const flush = useCallback(async () => {
    try {
      await write();
    } catch (reason) {
      report(reason);
    }
  }, [write, report]);

  // Build on the way in, drop on the way out. `at` is deliberately not a
  // dependency: it is where to *open*, and re-reading it while the sheet is up
  // would rebuild the round every time the cursor changed the position under it.
  useEffect(() => {
    if (!showing) {
      setRound(null);
      setActiveSheet(null);
      return;
    }
    const built = roundOf(blocksRef.current, [at]);
    const sheets = built.sheets();
    // Seeded with what was just built, which is what the store holds — so
    // opening the sheet writes nothing, and only what you change is written.
    written.current = new Map(
      sheets.map((sheet) => [
        sheet.id,
        { title: sheet.title, blocks: blocksIn(built.flow(sheet.id).roots()) },
      ]),
    );
    const opening = sheets.find((sheet) => sheet.title === titleOf(at)) ?? sheets[0];
    setRound(built);
    setActiveSheet(opening?.id ?? null);
    setVersion(0);
    // Only `showing`: see above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showing]);

  // Follow the round: every change re-renders and schedules a write, and a
  // change during the wait pushes it back, so a burst of typing lands as one.
  useEffect(() => {
    if (!round) return;
    const unsubscribe = round.subscribe(() => {
      setVersion((v) => v + 1);
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = null;
        void flush().then(refresh);
      }, SAVE_DELAY_MS);
    });
    return () => {
      unsubscribe();
      // A pending write is finished rather than dropped — including the one
      // still on the clock when `M` closes the sheet, which is the common case:
      // you edit a block and leave immediately.
      if (timer.current !== null) void flush().then(refresh);
    };
  }, [round, flush, refresh]);

  const sheets = useMemo(() => round?.sheets() ?? [], [round, version]);
  const flow = useMemo(
    () => (round && activeSheet ? round.flow(activeSheet) : null),
    [round, activeSheet],
  );
  const roots = useMemo(() => flow?.roots() ?? [], [flow, version]);

  return {
    round,
    flow,
    roots,
    sheets,
    activeSheet,
    open: useCallback((sheetId: string) => setActiveSheet(sheetId), []),
  };
}
