import { invoke } from "@tauri-apps/api/core";

/**
 * `~/.flow`, as the sheet sees it: three calls across to the Rust side (see
 * `src-tauri/src/store.rs`).
 *
 * Thin on purpose, the same way files/disk.ts is. When two arguments are the
 * same argument is recall.ts's business, when to write is useMemory.ts's, and
 * what is worth memorizing is the keymap's. This layer only knows that the
 * store exists.
 *
 * Not to be confused with a round on disk: that is a folder of sheets the user
 * picked a place for, and it holds the flow. This holds what the user carries
 * between rounds.
 */

/** An argument and the answers to it, in the order they were flowed. */
export interface Block {
  /**
   * The position it belongs to — the title of the sheet it was memorized on,
   * and empty for a block that has none. What keeps a framework block out of
   * the way while you are answering a disadvantage.
   */
  position: string;
  /** What an argument on the sheet is matched against — see recall.ts. */
  key: string;
  /** The argument as it was written when the block was memorized. */
  argument: string;
  answers: string[];
}

/**
 * Whether this build has a home directory to keep a `.flow` in — i.e. whether
 * it is the desktop app rather than a browser tab. The same question
 * `canUseFiles` asks of a round's folder, and the same answer in a tab: no.
 */
export { canUseFiles as canRemember } from "../files/disk";

/** Everything memorized, in one call — see the note on `blocks` in store.rs. */
export async function readBlocks(): Promise<Block[]> {
  return invoke<Block[]>("store_blocks");
}

/**
 * Memorize `answers` as the answers to `argument` in `position`, replacing
 * whatever was under that key there. No answers forgets it.
 */
export async function memorize(
  position: string,
  key: string,
  argument: string,
  answers: string[],
): Promise<void> {
  await invoke("store_memorize", { position, key, argument, answers });
}

/** Move every block in one position to another — see `rename_position`. */
export async function renamePosition(from: string, to: string): Promise<void> {
  await invoke("store_rename_position", { from, to });
}
