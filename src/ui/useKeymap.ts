import { useEffect, type Dispatch, type SetStateAction } from "react";
import { keyOf, run } from "../editor/commands";
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
): void {
  const { state, flow, round, placed, speeches, sheets, memory } = ctx;

  useEffect(() => {
    if (!flow) return;
    const onKey = (e: KeyboardEvent) => {
      if (state.editingId) return; // let the textarea own the keyboard
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;

      // Run the command here, not inside the setState updater: commands mutate
      // the flow, and StrictMode double-invokes updaters in development.
      const next = run(keyOf(e), { state, flow, round, placed, speeches, sheets, memory });
      if (!next) return;
      e.preventDefault();
      setEditor(next);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state, flow, round, placed, speeches, sheets, memory, setEditor]);
}
