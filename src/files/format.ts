import { Round } from "../model/round";
import {
  DEFAULT_MARK,
  DEFAULT_SUPPORT,
  type Argument,
  type Mark,
  type Support,
} from "../model/types";

/**
 * What a sheet looks like on disk, and how a round is built back out of a
 * directory of them.
 *
 * Plain JSON, not the CRDT's own snapshot. Loro could be written out losslessly
 * and keep ids, undo and authorship — but it would be a blob, and a flow is
 * something you want to read a year later, grep, and diff against your
 * partner's copy. That is worth more than the history.
 *
 * The cost, stated plainly: a round-tripped sheet is a *new* document. Fresh
 * ids, empty undo, no authorship, and two saved copies of one round will not
 * merge — they will both be there, twice. The room is for flowing together; the
 * file is where a round goes when it is over.
 *
 * Nothing here touches the disk — that is disk.ts.
 */

/**
 * The version this writes. Read back off every file, so that a format change
 * later can tell an old sheet from one it doesn't understand — and so a sheet
 * from a newer version can be refused instead of half-read.
 */
export const FORMAT = 1;

/** An argument as it is written: no id, because an id is a fact about a session. */
interface ArgumentJson {
  text: string;
  /** The speech column it sits in, counting from 0. */
  speech: number;
  mark: Mark;
  /**
   * Whether it was read off evidence — see `Support`. Written only when it
   * isn't the default, the same way `children` is written only when there are
   * some: a round nobody pressed `c` on should not gain a line per argument
   * saying so, and a file written before this existed reads back identically
   * because "absent" and "card" already mean the same thing.
   *
   * Which is also why this needed no `FORMAT` bump. The version exists to stop
   * a newer sheet being half-read by an older build (see `decodeSheet`), and an
   * older build reading one of these drops a field that was optional anyway and
   * gets the flow it expects.
   */
  support?: Support;
  /** Left out entirely when nothing answers it, which is most arguments. */
  children?: ArgumentJson[];
}

/** One file. */
export interface SheetJson {
  /** The format version — see `FORMAT`. Named for the app, since it is the
      first thing you see on opening the file and it should say what this is. */
  flow: number;
  title: string;
  /**
   * Where the sheet sits in the round, counting from 0.
   *
   * In each file rather than in a manifest beside them: a manifest is a second
   * thing to keep in step, and it makes a directory of sheets stop working the
   * moment you copy one in from somewhere else. Ties and gaps are fine — the
   * file name settles them (see `sortSheets`).
   */
  order: number;
  arguments: ArgumentJson[];
}

/** A sheet's contents, as a round holds them. */
export interface SheetContents {
  title: string;
  order: number;
  roots: Argument[];
}

/**
 * Write a sheet out. Indented and newline-terminated because these files are
 * meant to be read and diffed — a flow on one line would be neither.
 */
export function encodeSheet({ title, order, roots }: SheetContents): string {
  const sheet: SheetJson = {
    flow: FORMAT,
    title,
    order,
    arguments: roots.map(encodeArgument),
  };
  return `${JSON.stringify(sheet, null, 2)}\n`;
}

function encodeArgument(argument: Argument): ArgumentJson {
  const written: ArgumentJson = {
    text: argument.text,
    speech: argument.speech,
    mark: argument.mark,
  };
  if (argument.support !== DEFAULT_SUPPORT) written.support = argument.support;
  if (argument.children.length > 0) {
    written.children = argument.children.map(encodeArgument);
  }
  return written;
}

/**
 * Read a sheet back, or null if the text isn't one.
 *
 * Null rather than a throw for every way a file can fail to be a sheet, because
 * they all end in the same place: a directory holds whatever it holds, and the
 * ones that aren't sheets are skipped so the round still opens. Every field is
 * checked and every unreadable value falls back, so a hand-edited file with a
 * typo in it loses that field rather than the whole sheet.
 */
export function decodeSheet(text: string): SheetJson | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  // A file with no version is not one of ours — the directory is the user's,
  // and some other program's JSON must not be read as a flow and then written
  // back over.
  if (typeof value.flow !== "number") return null;
  // A sheet from a later version may have a shape this build would silently
  // discard on the next autosave. Refused rather than guessed at.
  if (value.flow > FORMAT) return null;
  return {
    flow: value.flow,
    title: typeof value.title === "string" ? value.title : "untitled",
    order: typeof value.order === "number" ? value.order : 0,
    arguments: decodeArguments(value.arguments),
  };
}

function decodeArguments(value: unknown): ArgumentJson[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((argument) => ({
    text: typeof argument.text === "string" ? argument.text : "",
    // Floored at 0: a negative or fractional column has no track to sit in, and
    // an argument that can't be drawn is worse than one drawn in the 1AC.
    speech:
      typeof argument.speech === "number" && argument.speech >= 0
        ? Math.floor(argument.speech)
        : 0,
    mark: isMark(argument.mark) ? argument.mark : DEFAULT_MARK,
    support: isSupport(argument.support) ? argument.support : DEFAULT_SUPPORT,
    children: decodeArguments(argument.children),
  }));
}

/**
 * The order the sheets go in the round: what each file says, and the file name
 * where two of them say the same thing — so a directory that has never been
 * written by this app (or one you copied a sheet into) still opens in an order
 * that doesn't change between openings.
 */
export function sortSheets<T extends { name: string; sheet: SheetJson }>(files: T[]): T[] {
  return [...files].sort(
    (a, b) => a.sheet.order - b.sheet.order || a.name.localeCompare(b.name),
  );
}

/**
 * Build a round out of decoded sheets, in the order given.
 *
 * The undo history is cleared at the end: opening a file is the floor, and `u`
 * on a freshly opened round should do nothing rather than start deleting the
 * arguments it was just built from.
 */
export function roundFrom(sheets: SheetJson[]): Round {
  const round = new Round();
  for (const sheet of sheets) {
    const flow = round.flow(round.addSheet(sheet.title));
    // One commit for the whole sheet — otherwise opening a round of any size is
    // hundreds of commits, each one a render and an undo step.
    flow.batch(() => writeArguments(flow, null, sheet.arguments));
  }
  round.clearHistory();
  return round;
}

function writeArguments(
  flow: ReturnType<Round["flow"]>,
  parent: string | null,
  args: ArgumentJson[],
): void {
  for (const argument of args) {
    // `root: null` / `under: parent` both append, so the arguments land in the
    // order they were written.
    const anchor = parent === null ? { root: null } : { under: parent };
    const id = flow.add(anchor, {
      text: argument.text,
      speech: argument.speech,
      // Passed explicitly rather than left to be inherited from the neighbour:
      // what a file says an argument is marked with is the answer, and letting
      // `add` infer it would quietly re-mark a lettered aside as it loaded.
      // Same for the support, and more sharply — inheritance would spread the
      // first argument's card-ness down a column the file said was analytics.
      mark: argument.mark,
      support: argument.support,
    });
    if (argument.children?.length) writeArguments(flow, id, argument.children);
  }
}

/**
 * What to call a sheet's file. The title, lowercased and hyphenated, so the
 * directory listing reads as the round does.
 *
 * `taken` is every name already claimed in this round — two sheets can share a
 * title ("untitled", twice, mid-round) and they cannot share a file.
 */
export function fileNameFor(title: string, taken: Set<string>): string {
  const base =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "sheet";
  let name = `${base}.json`;
  for (let n = 2; taken.has(name); n++) name = `${base}-${n}.json`;
  return name;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMark(value: unknown): value is Mark {
  return value === "num" || value === "alpha" || value === "none";
}

function isSupport(value: unknown): value is Support {
  return value === "card" || value === "analytic";
}
