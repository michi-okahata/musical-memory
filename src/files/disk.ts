import { invoke } from "@tauri-apps/api/core";

/**
 * The disk, as the sheet sees it: a folder dialog and four calls across to the
 * Rust side (see `src-tauri/src/files.rs`).
 *
 * Thin on purpose — everything about *what* a sheet is stays in format.ts, and
 * everything about when to write one stays in useLibrary.ts. This layer only
 * knows that files exist.
 */

/** One file in a round's directory, as read off disk. */
export interface SheetFile {
  /** The bare file name. The only handle the Rust side accepts — see `resolve`. */
  name: string;
  text: string;
}

/**
 * Whether this build can reach a filesystem at all — i.e. whether it is the
 * desktop app rather than a browser tab. Same question `canHost` asks of the
 * network, and the same answer in a tab: no.
 */
export function canUseFiles(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** Ask for a directory. Null when the dialog was dismissed. */
export async function pickDirectory(): Promise<string | null> {
  return (await invoke<string | null>("files_pick_directory")) ?? null;
}

/** Every sheet file in `directory`, read in one call — a round is a handful of
    small files, and seven round trips to list and then fetch them is six more
    than it needs. */
export async function readDirectory(directory: string): Promise<SheetFile[]> {
  return invoke<SheetFile[]>("files_read_dir", { dir: directory });
}

export async function writeFile(
  directory: string,
  name: string,
  text: string,
): Promise<void> {
  await invoke("files_write", { dir: directory, name, text });
}

export async function removeFile(directory: string, name: string): Promise<void> {
  await invoke("files_remove", { dir: directory, name });
}

/**
 * The last segment of a path, for the status line: the full path is what you
 * need in a tooltip and never what you want taking up a status line.
 */
export function folderName(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return cut >= 0 ? trimmed.slice(cut + 1) : trimmed;
}
