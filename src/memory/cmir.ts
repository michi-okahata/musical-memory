import { invoke } from "@tauri-apps/api/core";
import { argumentKey } from "./recall";
import type { Imported, ImportedFile } from "./store";

/**
 * A folder of CardMirror files, as blocks.
 *
 * A `.cmir` is already a stack of arguments with answers under them — a block
 * heading, and the tag of every card cut under it — so a backfile needs no
 * screen of its own and no second kind of memory. The format is the Rust side's
 * (see `src-tauri/src/cmir.rs`); this is the half that knows what an argument
 * is, and keys each block the way recall.ts keys everything.
 */

/** One block heading and the tags under it, as the Rust side read them. */
interface Section {
  /** The hat it sits under, or the pocket, or empty. */
  position: string;
  argument: string;
  answers: string[];
}

interface CmirFile {
  path: string;
  sections: Section[];
}

/** What a folder turned out to hold. */
export interface Scan {
  /**
   * The folder as the filesystem spells it, which is not always what the dialog
   * handed over — see `cmir_read_dir`. This is what the import must file blocks
   * under, so that the same folder picked twice is one folder.
   */
  dir: string;
  files: CmirFile[];
  /**
   * How many `.cmir` files would not read — damaged, too large, or written by a
   * newer CardMirror than this knows about.
   */
  failed: number;
  /**
   * Whether the walk gave up before the end of the folder. The import that
   * follows replaces everything under it, so a silent partial read would take
   * the rest of a backfile out of the store.
   */
  truncated: boolean;
}

/** Read every `.cmir` under `dir`. Nothing is written by this. */
export async function scan(dir: string): Promise<Scan> {
  return invoke<Scan>("cmir_read_dir", { dir });
}

/**
 * The file's own name, for a block that came in without a hat above it.
 *
 * A position is where you would look for the block, and a file with no hats in
 * it is one whose name is doing that job — "politics-da.cmir" is the politics
 * DA. Better than no position at all, which would file it with the loose ones
 * and lose the one thing the file did say about it.
 */
function stemOf(path: string): string {
  const name = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
  return name.replace(/\.cmir$/i, "");
}

/**
 * What a position and key together are held under while a file is being read.
 * The newline is the separator because `argumentKey` collapses every run of
 * whitespace to a single space, so neither half can contain one and no two
 * pairs can be mistaken for each other.
 */
function under(position: string, key: string): string {
  return argumentKey(position) + "\n" + key;
}

/**
 * One file's sections as blocks — the questions about arguments that the reader
 * deliberately left alone.
 *
 * A section with no key is dropped, since nothing could recall it. Sections
 * that key the same in one position are one block holding both lots of answers,
 * because the store allows one block per key per position. Answers repeated
 * word for word are kept once.
 */
export function blocksOf(file: CmirFile): Imported[] {
  const blocks: Imported[] = [];
  const at = new Map<string, Imported>();

  for (const section of file.sections) {
    const key = argumentKey(section.argument);
    if (!key) continue;
    const position = section.position.trim() || stemOf(file.path);

    const seen = at.get(under(position, key));
    const block = seen ?? {
      position,
      key,
      argument: section.argument.trim(),
      answers: [] as string[],
    };
    if (!seen) {
      at.set(under(position, key), block);
      blocks.push(block);
    }
    for (const answer of section.answers) {
      const line = answer.trim();
      if (line && !block.answers.includes(line)) block.answers.push(line);
    }
  }

  return blocks.filter((block) => block.answers.length > 0);
}

/** A whole scan, ready for the store. */
export function filesIn(scanned: Scan): ImportedFile[] {
  return scanned.files
    .map((file) => ({ source: file.path, blocks: blocksOf(file) }))
    .filter((file) => file.blocks.length > 0);
}

/** How many blocks a scan came to, for saying so. */
export function countOf(files: ImportedFile[]): number {
  return files.reduce((total, file) => total + file.blocks.length, 0);
}
