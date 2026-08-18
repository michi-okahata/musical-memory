import React, { useMemo, useRef, useState } from "react";
import { keyLabel, keysFor } from "../editor/config";

/**
 * The keymap, on `:?`.
 *
 * It used to live along the bottom of the window as a permanent strip of
 * hints, and the reason it doesn't any more is that a keymap outgrows a line.
 * Twenty entries in a slot that fits nine meant the list was truncated at every
 * ordinary window size — and truncated from the wrong end, since it ran roughly
 * by frequency and so kept `hjkl` (which nobody forgets) while dropping the
 * commands you would actually go looking for. A reference you have to be lucky
 * to read is not a reference; the line is better spent on the sheet.
 *
 * So it is a sheet of its own, asked for by name, with room to be grouped and
 * complete. The keys themselves are data, below; the only state is what you
 * have typed to find one.
 *
 * Searching it is not a concession to length so much as the other way of
 * reading it: you come here either to browse what there is — the groups, in
 * learning order — or knowing the word for what you want and not the key for
 * it ("memorize", "zoom", "join"), which is a question a list cannot answer
 * however well it is arranged.
 */

/**
 * One row of the sheet: what it does, and what to press.
 *
 * Rows name *commands* wherever there is one, and the key column is drawn from
 * whatever they are bound to (see `keysFor`) — a remapped keymap that showed
 * the keys this app shipped with would be a reference that lies, which is
 * worse than none. Several commands to a row where they are one idea: "left,
 * down, up, right" is four bindings and one thing to know.
 *
 * `press` is the way out for what has no command behind it: the command line,
 * which is typed rather than bound, and `Tab` and `Esc`, which belong to the
 * text editor. `count` is the prefix an example takes — `3j`, `4a` — and goes
 * in front of whatever the command turns out to be on.
 */
interface Row {
  does: string;
  commands?: string[];
  press?: string;
  count?: string;
}

interface Group {
  title: string;
  rows: Row[];
}

// Ordered the way you learn the app rather than the way you use it: where the
// cursor goes, then how an argument gets on the sheet, then what you can do to
// one that already is — and the commands last, since they are typed by name and
// so are the ones that need writing down most.
const GROUPS: Group[] = [
  {
    title: "moving",
    rows: [
      { commands: ["left", "down", "up", "right"], does: "left, down, up, right" },
      { commands: ["down"], count: "3", does: "…any of them, three times" },
      { press: ":2ac", does: "jump to a speech by name" },
      { commands: ["prevSheet", "nextSheet"], does: "the sheet before, the sheet after" },
      { commands: ["focus"], does: "pin the sheet to this speech" },
    ],
  },
  {
    title: "writing",
    rows: [
      { commands: ["edit"], does: "edit this argument" },
      { commands: ["answer"], does: "answer it — a response, next speech" },
      { commands: ["answer"], count: "4", does: "…answer it in the 4th speech instead" },
      { commands: ["answerNext"], does: "…and on to the next argument down" },
      { commands: ["recall"], does: "answer it with the block you memorized" },
      { commands: ["recall"], count: "4", does: "…in the 4th speech instead" },
      { commands: ["addBelow", "addAbove"], does: "another argument below, above" },
      { commands: ["newBelow", "newAbove"], does: "a new argument, clear of this one" },
      { press: "Tab", does: "finish the word" },
      { press: "Esc", does: "stop editing" },
    ],
  },
  {
    title: "changing",
    rows: [
      { commands: ["select"], does: "select a run in this column" },
      { commands: ["mark"], does: "how it's marked: 1. / a. / nothing" },
      { commands: ["support"], does: "was it a card, or did they just say it" },
      { commands: ["shiftDown", "shiftUp"], does: "shift the selection down, up" },
      { commands: ["copy"], does: "copy it, and everything under it" },
      { commands: ["putBelow", "putAbove"], does: "put the copy below, above" },
      { commands: ["putBelow"], count: "3", does: "…put it in the 3rd speech instead" },
      { commands: ["memorize"], does: "memorize the answers under it" },
      { commands: ["delete"], does: "delete it — and keep a copy, to put back" },
      { commands: ["undo", "redo"], does: "undo, and redo" },
    ],
  },
  {
    title: "the sheet",
    rows: [
      { commands: ["memorySheet"], does: "what you have memorized, as a sheet" },
      { press: ":import", does: "read a folder of cut cards in as blocks" },
      { press: ":forget", does: "drop what an import put there" },
      { commands: ["sidebar"], does: "show or hide the list of sheets" },
      { commands: ["zoomIn", "zoomOut"], does: "zoom" },
      { commands: ["zoomReset"], does: "back to actual size" },
      { commands: ["sheetUp", "sheetDown"], does: "move this sheet up, down the list" },
    ],
  },
  {
    title: "sheets",
    rows: [
      { press: ":new politics", does: "start a position" },
      { press: ":rename", does: "call it something else" },
      { press: ":sheet pol", does: "open one by name" },
      { press: ":delete", does: "throw this one away" },
    ],
  },
  {
    title: "the round",
    rows: [
      { press: ":open", does: "a folder of sheets" },
      { press: ":save", does: "write it out — then it saves itself" },
    ],
  },
  {
    title: "collaboration",
    rows: [
      { press: ":host", does: "flow with somebody — no server needed" },
      // The bare code rather than `192.168.1.42/k7fmqp`: the key column is as
      // wide as its widest entry, and spelling the whole invitation out here
      // squeezed every gloss in the group onto two lines to show an example
      // nobody needs to read twice.
      { press: ":join k7fmqp", does: "go to the round they're hosting" },
      { press: ":name", does: "what they see you as" },
      { press: ":solo", does: "leave the room, keep the flow" },
    ],
  },
  {
    // Last, because it is the one line here that is about the list itself. It
    // is on the sheet at all because this is where somebody is standing when
    // they think "not that key" — a config nobody can find is a config nobody
    // has. What to write in it is the name each row is hung on, which is what
    // the key column's tooltip says.
    title: "the keys",
    rows: [
      {
        press: "~/.flow/config.json",
        does: "rebind any of these — hover a key for its name",
      },
    ],
  },
];

/**
 * The chord glyphs spelled out, so that what is drawn can be found by what is
 * said: nobody types ⌘ to look for it, and there is no key on the board that
 * produces one.
 */
const SPELLED: Record<string, string> = {
  "⌘": "cmd command meta",
  "⇧": "shift",
  "⌥": "alt option",
  "⌃": "ctrl control",
};

/**
 * What to press, for one row: the first key each of its commands is bound to,
 * with the count prefix in front where the row is an example of one.
 *
 * The first and not all of them, because a command may wear several keys —
 * zoom answers to both faces of its key, undo to a chord and a letter — and a
 * reference that listed every alias would be a longer list of the same
 * information. `DEFAULT_KEYS` is ordered so that the first is the one worth
 * printing.
 *
 * Empty for a command a config has unbound: the row drops out below rather
 * than sit there naming a key that no longer exists.
 */
function pressed(row: Row, keys: Record<string, string>): string {
  if (row.press) return row.press;
  const bound = (row.commands ?? [])
    .map((name) => keysFor(name, keys)[0])
    .filter((key): key is string => key !== undefined)
    .map((key) => `${row.count ?? ""}${keyLabel(key)}`);
  return bound.join(" ");
}

/**
 * Everything one row can be found by: the key, what it does, and the group it
 * is in — so "sheet" finds the whole of the sheets group, and "memorize" finds
 * `m` without knowing that it is called that. The command names too, since
 * they are what you would write in the config and so what you may well have
 * come here holding.
 */
function searchable(group: string, row: Row, press: string): string {
  const spelled = press.replace(/[⌘⇧⌥⌃]/g, (glyph) => ` ${SPELLED[glyph]} `);
  const names = (row.commands ?? []).join(" ");
  return `${group} ${press} ${spelled} ${names} ${row.does}`.toLowerCase();
}

export function Keymap({
  keys,
  onClose,
}: {
  /** The keymap in force — what the key column is drawn from. */
  keys: Record<string, string>;
  onClose: () => void;
}): React.ReactElement {
  const [query, setQuery] = useState("");
  const search = useRef<HTMLInputElement | null>(null);
  const want = query.trim().toLowerCase();

  // Whole groups drop out once nothing in them matches, rather than being left
  // as headings over nothing: with a query typed, the groups are no longer the
  // structure being read, they are just where the answers happen to live.
  const found = useMemo(() => {
    return GROUPS.map((group) => ({
      title: group.title,
      rows: group.rows
        .map((row) => ({ row, press: pressed(row, keys) }))
        // A row whose every command has been unbound has nothing to press.
        .filter(({ press }) => press !== "")
        .filter(({ row, press }) => !want || searchable(group.title, row, press).includes(want)),
    })).filter((group) => group.rows.length > 0);
  }, [want, keys]);

  return (
    // Clicking anywhere off the sheet puts it away, which is the one thing a
    // mouse should be able to do here. The keyboard's own way out is `Esc` —
    // see `run` in commands.ts, which swallows everything else while this is up
    // and the search box hasn't got it.
    <div className="app__scrim" onMouseDown={onClose}>
      <div
        className="keymap"
        role="dialog"
        aria-label="keys"
        // Otherwise a click meant for the sheet itself reaches the scrim.
        onMouseDown={(e) => e.stopPropagation()}
        // A click inside the panel would otherwise take the focus off the
        // search box and leave typing doing nothing at all — every other key
        // is swallowed while this is up. Not when something was selected,
        // since refocusing would drop the selection you just made.
        onMouseUp={() => {
          if (window.getSelection()?.isCollapsed !== false) search.current?.focus();
        }}
      >
        <div className="keymap__head">
          <span className="keymap__label">keys</span>
          <input
            ref={search}
            className="keymap__search"
            autoFocus
            value={query}
            placeholder="search"
            aria-label="search the keys"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              // The flow's keymap must not see what is being typed here — and
              // it stands aside for an INPUT anyway; this is the belt to that
              // pair of braces, and where `Esc` gets its meaning back.
              e.stopPropagation();
              if (e.key === "Escape" || e.key === "Enter") {
                e.preventDefault();
                onClose();
              }
            }}
          />
        </div>

        <div className="keymap__scroll">
          <div className="keymap__groups">
            {found.map((group) => (
              <section key={group.title} className="keymap__group">
                <h2 className="keymap__title">{group.title}</h2>
                <dl className="keymap__keys">
                  {group.rows.map(({ row, press }) => (
                    <React.Fragment key={row.does}>
                      {/* The command's name, for anybody about to write it
                          into a config — the one place the app says it. */}
                      <dt title={row.commands?.join(" ")}>
                        <kbd>{press}</kbd>
                      </dt>
                      <dd>{row.does}</dd>
                    </React.Fragment>
                  ))}
                </dl>
              </section>
            ))}
          </div>

          {found.length === 0 && (
            <p className="keymap__empty">no key for “{query.trim()}”</p>
          )}
        </div>

        <p className="keymap__close">
          <kbd>esc</kbd> to close
        </p>
      </div>
    </div>
  );
}
