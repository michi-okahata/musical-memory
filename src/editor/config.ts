import { commands, DEFAULT_KEYS } from "./commands";

/**
 * `~/.flow/config.json`, as the keymap sees it.
 *
 * What it is for: the keys are a preference and what the editor can do is not
 * (see `commands`). This is the file that binds one to the other — beside the
 * blocks in `~/.flow`, because it is the other half of what follows a person
 * from round to round, and hand-written JSON because it is a file you open in
 * an editor and read.
 *
 *     {
 *       "keys": {
 *         "g": "answer",
 *         "A": null
 *       }
 *     }
 *
 * A key on the left, the name of a command on the right — the same shape and
 * the same order as `DEFAULT_KEYS`, and read *over* it rather than in place of
 * it: a file that had to restate the whole keymap to move one key would be a
 * file nobody keeps up to date. `null` unbinds, which is the only way to say
 * "nothing" and the way to free a key up for something else.
 *
 * Nothing here throws. A config is edited by hand, in a text editor, between
 * rounds and sometimes during them — so every mistake it can contain has to
 * leave the keyboard working: what parses is applied, what doesn't is reported
 * (see `Config.problems`, which the status line shows), and the rest of the
 * keymap is whatever it always was.
 */

/** How a key is written in the file — the same string `keyOf` builds. */
const KEY_PATTERN = /^(C-)?(M-)?.+$/;

export interface Config {
  /** The keymap to run: the defaults with the file read over them. */
  keys: Record<string, string>;
  /**
   * What was wrong with the file, in the order it was found, and empty when
   * there was nothing wrong or no file at all. Told rather than thrown: a
   * config with one bad line is a config with every other line still good.
   */
  problems: string[];
}

export const DEFAULT_CONFIG: Config = { keys: DEFAULT_KEYS, problems: [] };

/**
 * Read a config, or the defaults where there is no file.
 *
 * `text` is the file as it is on disk (see `store_config` in store.rs) — null
 * on every machine where nobody has written one, which is most of them.
 */
export function readConfig(text: string | null): Config {
  if (text === null || text.trim() === "") return DEFAULT_CONFIG;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    // The parser's own message names the line and column, which is the whole
    // of what is useful about a syntax error in a file you are editing.
    return { keys: DEFAULT_KEYS, problems: [`config.json: ${(e as Error).message}`] };
  }

  if (!isObject(parsed)) {
    return { keys: DEFAULT_KEYS, problems: ["config.json: expected an object"] };
  }

  const bindings = parsed.keys;
  if (bindings === undefined) return DEFAULT_CONFIG;
  if (!isObject(bindings)) {
    return { keys: DEFAULT_KEYS, problems: [`config.json: "keys" is not an object`] };
  }

  const keys = { ...DEFAULT_KEYS };
  const problems: string[] = [];
  for (const [key, name] of Object.entries(bindings)) {
    if (!KEY_PATTERN.test(key)) {
      problems.push(`config.json: "${key}" is not a key`);
      continue;
    }
    // Unbinding, which is what a key with nothing on it is for: `"x": null`
    // leaves `x` doing nothing rather than deleting an argument.
    if (name === null || name === "") {
      delete keys[key];
      continue;
    }
    if (typeof name !== "string" || !(name in commands)) {
      problems.push(`config.json: "${key}" is bound to no such command: ${String(name)}`);
      continue;
    }
    keys[key] = name;
  }

  return { keys, problems };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Every key `name` is on, in the order the keymap lists them — for the help
 * sheet, which has to show the keys somebody actually has rather than the ones
 * this app shipped with (see Keymap.tsx).
 */
export function keysFor(name: string, keys: Record<string, string>): string[] {
  return Object.keys(keys).filter((key) => keys[key] === name);
}

/** The chord prefixes, as they are drawn rather than as they are stored. */
const GLYPHS: [prefix: string, glyph: string][] = [
  ["C-", "⌃"],
  ["M-", "⌘"],
];

/**
 * A key as it should be read: `M-p` is ⌘P and `M-Z` is ⇧⌘Z.
 *
 * The shift is inferred from the letter rather than stored, because that is
 * where the keyboard puts it — an event for ⇧⌘Z arrives as a capital `Z` and
 * no other flag — and a reader who has to work out that `M-Z` is the shifted
 * one is a reader the sheet has failed.
 */
export function keyLabel(key: string): string {
  let rest = key;
  let prefix = "";
  for (const [mark, glyph] of GLYPHS) {
    if (rest.startsWith(mark)) {
      prefix += glyph;
      rest = rest.slice(mark.length);
    }
  }
  // Only where a chord is involved: a bare `A` is `A`, which is how the writing
  // keys have always been written down and reads as the shifted key it is.
  if (prefix && rest.length === 1 && rest !== rest.toLowerCase()) prefix = `⇧${prefix}`;
  return prefix ? `${prefix}${rest.toUpperCase()}` : rest;
}
