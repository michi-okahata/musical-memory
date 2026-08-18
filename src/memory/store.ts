import { invoke } from "@tauri-apps/api/core";

/**
 * `~/.flow/db`, as the sheet sees it: six calls across to the Rust side (see
 * `src-tauri/src/store.rs`). `~/.flow` is a directory, and the blocks are the
 * database in it.
 *
 * Thin on purpose, the same way files/disk.ts is: when two arguments are the
 * same is recall.ts's business, when to write is useMemory.ts's, and what is
 * worth memorizing is the keymap's. Not a round on disk — that is a folder of
 * sheets holding the flow; this is what the user carries between rounds.
 */

/** An argument and the answers to it, in the order they were flowed. */
export interface Block {
  /**
   * Where it came from: empty for a block you memorized, and the path of the
   * file it was read out of otherwise (see cmir.ts). The two live in the same
   * store and are never the same thing — yours is edited on the memory sheet
   * and written back from it, a file's is replaced whole the next time the
   * folder is read — so nearly everything here asks which it has.
   */
  source: string;
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

/**
 * The two halves, each in one call — see the note on `blocks` in store.rs.
 *
 * Apart rather than together because they change at completely different rates:
 * what you memorized is rewritten while a round is being flowed and re-read
 * every time the memory sheet writes, and what a folder holds changes only when
 * you ask for a folder. Reading them together would put a whole backfile across
 * the wire every six hundred milliseconds of typing on the memory sheet.
 */
export async function readMemorized(): Promise<Block[]> {
  return invoke<Block[]>("store_memorized");
}

export async function readImported(): Promise<Block[]> {
  return invoke<Block[]>("store_imported");
}

/**
 * `~/.flow/config.json` as text, or null where there is no file — which is
 * every machine until somebody writes one.
 *
 * Text, because what a config may say is the keymap's question and not this
 * layer's: see editor/config.ts, which is the only thing that reads it.
 */
export async function readConfigFile(): Promise<string | null> {
  return (await invoke<string | null>("store_config")) ?? null;
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

/** A block on its way in from a file: a `Block` before it has a source. */
export type Imported = Omit<Block, "source">;

/** One file's blocks, filed under the path they were read out of. */
export interface ImportedFile {
  source: string;
  blocks: Imported[];
}

/**
 * Replace everything read out of `dir` with `files` — every block, in one go,
 * because a folder read again is what the folder says now and that includes
 * what has been deleted out of it. See `import` in store.rs.
 */
export async function importInto(dir: string, files: ImportedFile[]): Promise<void> {
  await invoke("store_import", { dir, files });
}

/** Drop every block that came out of a file. What you memorized stays. */
export async function forgetImports(): Promise<void> {
  await invoke("store_forget_imports");
}
