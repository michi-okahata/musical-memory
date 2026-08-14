import React from "react";

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
 * complete. Nothing here is state — it is what the keys do, written down.
 */

/** One group of keys, and what they do. */
interface Group {
  title: string;
  keys: [key: string, does: string][];
}

// Ordered the way you learn the app rather than the way you use it: where the
// cursor goes, then how an argument gets on the sheet, then what you can do to
// one that already is — and the commands last, since they are typed by name and
// so are the ones that need writing down most.
const GROUPS: Group[] = [
  {
    title: "moving",
    keys: [
      ["h j k l", "left, down, up, right"],
      ["3j", "…any of them, three times"],
      [":2ac", "jump to a speech by name"],
      ["[ ]", "the sheet before, the sheet after"],
      ["f", "pin the sheet to this speech"],
    ],
  },
  {
    title: "writing",
    keys: [
      ["i", "edit this argument"],
      ["a", "answer it — a response, next speech"],
      ["4a", "…answer it in the 4th speech instead"],
      ["A", "…answer it with the block you memorized"],
      ["o O", "another argument below, above"],
      ["n N", "a new argument, clear of this one"],
      ["Tab", "finish the word"],
      ["Esc", "stop editing"],
    ],
  },
  {
    title: "changing",
    keys: [
      ["v", "select a run in this column"],
      ["#", "how it's marked: 1. / a. / nothing"],
      ["c", "was it a card, or did they just say it"],
      ["J K", "shift the selection down, up"],
      ["y", "copy it, and everything under it"],
      ["p P", "put the copy below, above"],
      ["3p", "…put it in the 3rd speech instead"],
      ["m", "memorize the answers under it"],
      ["x", "delete it — and keep a copy, for p"],
      ["u", "undo"],
      ["⌘Z ⇧⌘Z", "…and redo"],
    ],
  },
  {
    title: "the sheet",
    keys: [
      ["M", "what you have memorized, as a sheet"],
      [":import", "read a folder of cut cards in as blocks"],
      [":forget", "drop what an import put there"],
      ["⌘B", "show or hide the list of sheets"],
      ["⌘+ ⌘-", "zoom"],
      ["⌘0", "back to actual size"],
      ["{ }", "move this sheet up, down the list"],
    ],
  },
  {
    title: "sheets",
    keys: [
      [":new politics", "start a position"],
      [":rename", "call it something else"],
      [":sheet pol", "open one by name"],
      [":delete", "throw this one away"],
    ],
  },
  {
    title: "the round",
    keys: [
      [":open", "a folder of sheets"],
      [":save", "write it out — then it saves itself"],
    ],
  },
  {
    title: "collaboration",
    keys: [
      [":host", "flow with somebody — no server needed"],
      // The bare code rather than `192.168.1.42/k7fmqp`: the key column is as
      // wide as its widest entry, and spelling the whole invitation out here
      // squeezed every gloss in the group onto two lines to show an example
      // nobody needs to read twice.
      [":join k7fmqp", "go to the round they're hosting"],
      [":name", "what they see you as"],
      [":solo", "leave the room, keep the flow"],
    ],
  },
];

export function Keymap({ onClose }: { onClose: () => void }): React.ReactElement {
  return (
    // Clicking anywhere off the sheet puts it away, which is the one thing a
    // mouse should be able to do here. The keyboard's own way out is `Esc` —
    // see `run` in commands.ts, which swallows everything else while this is up.
    <div className="app__scrim" onMouseDown={onClose}>
      <div
        className="keymap"
        role="dialog"
        aria-label="keys"
        // Otherwise a click meant for the sheet itself reaches the scrim.
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="keymap__groups">
          {GROUPS.map((group) => (
            <section key={group.title} className="keymap__group">
              <h2 className="keymap__title">{group.title}</h2>
              <dl className="keymap__keys">
                {group.keys.map(([key, does]) => (
                  <React.Fragment key={key}>
                    <dt>
                      <kbd>{key}</kbd>
                    </dt>
                    <dd>{does}</dd>
                  </React.Fragment>
                ))}
              </dl>
            </section>
          ))}
        </div>
        <p className="keymap__close">
          <kbd>esc</kbd> to close
        </p>
      </div>
    </div>
  );
}
