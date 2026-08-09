import { useCallback, useEffect, useRef, useState } from "react";
import type { Round } from "../model/round";
import {
  canUseFiles,
  pickDirectory,
  readDirectory,
  removeFile,
  writeFile,
} from "../files/disk";
import {
  decodeSheet,
  encodeSheet,
  fileNameFor,
  roundFrom,
  sortSheets,
} from "../files/format";

/**
 * Where the round is kept, and keeping it there.
 *
 * A round is a directory and a sheet is a file in it (see files/format.ts), so
 * "open" is a folder dialog and "save" is a handful of small writes. Once a
 * directory is bound it stays bound and the round is written as it changes: a
 * flow is taken down live, under a speech timer, and a debater who has to
 * remember to press save mid-2NC is a debater who loses the 2NC.
 *
 * Written as a hook rather than as a store like `FlowSession`, because unlike
 * the session it has nothing to say between renders — there is no socket, no
 * peer, no clock of its own beyond one debounce. What it does have is a round
 * that is *replaced* underneath it (opening a folder, joining a room), and
 * following that is exactly what an effect is for.
 */

/**
 * How long after the last change the round is written out. Long enough that a
 * sentence being typed is one write rather than thirty; short enough that the
 * disk is never far behind what is on screen.
 */
const SAVE_DELAY_MS = 800;

/** Where a sheet is kept, and what it was called when it went there. */
interface Kept {
  /** The file it is written to. */
  name: string;
  /**
   * The title that name answers to. Held so that a file only ever moves when
   * the *title* changes: a sheet read out of a folder keeps the name the user
   * gave it, rather than being renamed to a slug of its title the first time
   * anything is typed. Renaming the sheet is the one thing that renames a file.
   */
  title: string;
}

export interface Library {
  /** The directory the round is saved in, or null when it isn't saved anywhere. */
  directory: string | null;
  /**
   * What went wrong last, if anything. Cleared by the next thing that works.
   * A browser tab, which has no filesystem to reach, reports itself here the
   * first time you ask it for one rather than by hiding the commands — the
   * same way `:host` answers.
   */
  error: string | null;
  /** Pick a directory and open every sheet in it, in place of this round. */
  open: () => void;
  /**
   * Write the round out. Asks for a directory the first time and remembers it;
   * after that this is only ever "now, rather than in a moment", since the
   * round is already being written as it changes.
   */
  save: () => void;
}

export function useLibrary(round: Round, load: (round: Round) => void): Library {
  const [directory, setDirectory] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Which file each sheet is kept in, and the text last written to it, both
  // keyed by sheet id. The first is what remembers the old name when a sheet is
  // renamed, so the stale file can go; the second is what keeps an autosave
  // from rewriting six untouched sheets because a seventh changed.
  //
  // Between them they are also the whole of this hook's licence to delete: a
  // file is only ever removed if it is in here, which is to say only if this
  // session read it as a sheet or wrote it as one. Everything else in the
  // user's directory is somebody else's.
  const files = useRef(new Map<string, Kept>());
  const written = useRef(new Map<string, string>());

  // Read at call time rather than closed over, because a save is scheduled from
  // a document subscription and runs a second later — by which time the round
  // may have been replaced, and the directory may have just been picked.
  const roundRef = useRef(round);
  roundRef.current = round;
  const directoryRef = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(async () => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const dir = directoryRef.current;
    if (!dir) return;
    const current = roundRef.current;
    const sheets = current.sheets();

    try {
      // Every name first, before anything is written. A name has to be unique
      // across the round, and two sheets both called "untitled" differ only by
      // which of them claimed the plain name — which can't be decided one sheet
      // at a time.
      //
      // The ones already in a file they still answer to are settled first, so
      // that a sheet needing a fresh name cannot claim one out from under a
      // sheet that is already living in it.
      const taken = new Set<string>();
      const keeping = sheets.map((sheet) => {
        const kept = files.current.get(sheet.id);
        if (!kept || kept.title !== sheet.title) return null;
        taken.add(kept.name);
        return kept.name;
      });
      const naming = sheets.map((sheet, order) => {
        let name = keeping[order];
        if (name === null) {
          name = fileNameFor(sheet.title, taken);
          taken.add(name);
        }
        return { sheet, order, name };
      });

      for (const { sheet, order, name } of naming) {
        const text = encodeSheet({
          title: sheet.title,
          order,
          roots: current.flow(sheet.id).roots(),
        });
        const kept = files.current.get(sheet.id);
        if (kept?.name === name && written.current.get(sheet.id) === text) continue;
        // The new file before the old one, always: a rename interrupted between
        // the two leaves the round with a duplicate, which you can see and fix,
        // rather than with nothing.
        await writeFile(dir, name, text);
        if (kept && kept.name !== name) await removeFile(dir, kept.name);
        files.current.set(sheet.id, { name, title: sheet.title });
        written.current.set(sheet.id, text);
      }

      // Sheets that have gone since the last write take their file with them —
      // deleting a sheet deletes the position, and leaving the file behind
      // would resurrect it the next time the folder was opened.
      for (const [id, kept] of [...files.current]) {
        if (sheets.some((sheet) => sheet.id === id)) continue;
        // Unless a surviving sheet has since claimed that name, in which case
        // the file on disk is now theirs.
        if (!taken.has(kept.name)) await removeFile(dir, kept.name);
        files.current.delete(id);
        written.current.delete(id);
      }
      setError(null);
    } catch (reason) {
      setError(String(reason));
    }
  }, []);

  // Follow the document: every change schedules a write, and a change during
  // the wait pushes it back, so a burst of typing lands as one.
  //
  // Re-subscribed when the round is replaced, which is what keeps a round
  // opened from disk being saved back to the folder it came from.
  useEffect(() => {
    if (!directory) return;
    const unsubscribe = round.subscribe(() => {
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = null;
        void flush();
      }, SAVE_DELAY_MS);
    });
    return () => {
      unsubscribe();
      // A pending write is finished rather than dropped. This runs on a hot
      // reload and on StrictMode's throwaway pass as well as on a real
      // teardown, and writing the same text twice costs nothing next to losing
      // the last thing typed before a reload.
      if (timer.current !== null) void flush();
    };
  }, [round, directory, flush]);

  /**
   * Bind a directory, forgetting whatever the last one held. `held` and `saved`
   * are what is already on disk there — empty for a folder being written to for
   * the first time, and the sheets just read for one being opened.
   */
  const bind = useCallback(
    (
      dir: string,
      held: Map<string, Kept> = new Map(),
      saved: Map<string, string> = new Map(),
    ) => {
      directoryRef.current = dir;
      files.current = held;
      written.current = saved;
      setDirectory(dir);
    },
    [],
  );

  const open = useCallback(async () => {
    if (!canUseFiles()) {
      setError("opening a round needs the desktop app");
      return;
    }
    try {
      const dir = await pickDirectory();
      if (!dir) return; // dismissed
      // Everything in the directory that reads as a sheet. Everything that
      // doesn't is simply not part of the round — see `decodeSheet`.
      const found = await readDirectory(dir);
      const read = sortSheets(
        found.flatMap((file) => {
          const sheet = decodeSheet(file.text);
          return sheet ? [{ name: file.name, sheet }] : [];
        }),
      );

      const next = roundFrom(read.map((file) => file.sheet));
      // The sheets went in in this order, so they come back in it — which is
      // what pairs each one with the file it was read from, and so writes it
      // back to that file rather than to a new one named after its title.
      const held = new Map<string, Kept>();
      const saved = new Map<string, string>();
      next.sheets().forEach((sheet, order) => {
        held.set(sheet.id, { name: read[order].name, title: sheet.title });
        // Seeded with what this build *would* write, not with the text on
        // disk: opening a folder must not rewrite it, and a file that is only
        // formatted differently is not a change.
        saved.set(
          sheet.id,
          encodeSheet({ title: sheet.title, order, roots: next.flow(sheet.id).roots() }),
        );
      });
      bind(dir, held, saved);
      setError(null);
      load(next);
    } catch (reason) {
      setError(String(reason));
    }
  }, [bind, load]);

  const save = useCallback(async () => {
    if (!canUseFiles()) {
      setError("saving needs the desktop app");
      return;
    }
    if (directoryRef.current) {
      await flush();
      return;
    }
    try {
      const dir = await pickDirectory();
      if (!dir) return;
      bind(dir);
    } catch (reason) {
      setError(String(reason));
      return;
    }
    await flush();
  }, [bind, flush]);

  return {
    directory,
    error,
    open: () => void open(),
    save: () => void save(),
  };
}
