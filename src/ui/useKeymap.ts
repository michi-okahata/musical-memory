import { useEffect, type Dispatch, type SetStateAction } from "react";
import { keyOf, run, runsWhileEditing } from "../editor/commands";
import type { CommandContext, EditorState } from "../editor/state";

/**
 * Wire the keymap (see commands.ts) to the window.
 *
 * The whole of the DOM's involvement in vim-style control: everything about
 * what a key *does* is a pure state transition one layer down. This decides
 * only when the keyboard belongs to the editor at all.
 */
export function useKeymap(
  /**
   * The context, except that the flow may be missing — a round with no sheets
   * yet, which is what a peer sees for the moment between joining a room and
   * the snapshot arriving. There is nothing to act on then, so the keyboard
   * does nothing rather than every command having to ask.
   */
  ctx: Omit<CommandContext, "flow"> & { flow: CommandContext["flow"] | null },
  setEditor: Dispatch<SetStateAction<EditorState>>,
  /**
   * Write buffered keystrokes into the flow now. Called before running a key
   * that came from inside an open argument: typing is written through on a
   * timer (see useTextBuffer), and a command that reads the argument's text —
   * ⌘P does — must not read it as it stood a tick ago.
   */
  flushText: () => void,
  /** Which key does what, the user's config read over the defaults. */
  keys: Record<string, string>,
): void {
  const { state, flow, round, placed, speeches, sheets, memory } = ctx;

  useEffect(() => {
    if (!flow) return;
    const onKey = (e: KeyboardEvent) => {
      const key = keyOf(e);
      const tag = (e.target as HTMLElement).tagName;
      // The textarea owns the keyboard while an argument is open, and the
      // command line owns it while that is — except for the chords that are
      // meant to work mid-sentence, and then only from inside an argument.
      if (state.editingId || tag === "INPUT" || tag === "TEXTAREA") {
        if (!state.editingId || !runsWhileEditing(key, keys)) return;
        flushText();
      }

      // Run the command here, not inside the setState updater: commands mutate
      // the flow, and StrictMode double-invokes updaters in development.
      const next = run(
        key,
        { state, flow, round, placed, speeches, sheets, memory },
        keys,
      );
      if (!next) return;
      e.preventDefault();
      setEditor(next);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state, flow, round, placed, speeches, sheets, memory, setEditor, flushText, keys]);
}
