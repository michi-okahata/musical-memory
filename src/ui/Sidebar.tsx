import React, { useEffect, useRef, useState } from "react";
import type { SheetInfo } from "../model/round";
import type { Peer } from "../sync/presence";

/**
 * The sheets in the round, down the left.
 *
 * A debate is not one flow. Each position gets its own sheet — the case,
 * topicality, each disadvantage — and moving between them is something you do
 * every few seconds while a speech is being given. So they are a list that is
 * always there rather than something behind a menu, and the one you're on is
 * marked the way the cursor marks an argument: this is the same idea one level
 * up, and it should look like it.
 *
 * It also answers a question the sheet itself cannot once a round has more than
 * one: where is everybody. A peer's mark beside a sheet name is the only way to
 * see that your partner is working two positions away — on their sheet you'd
 * see nothing at all.
 */

interface SidebarProps {
  sheets: SheetInfo[];
  activeSheet: string | null;
  /** Everyone else, so each sheet can show who is on it. */
  peers: Peer[];
  onOpen: (sheetId: string) => void;
  onAdd: () => void;
  onRename: (sheetId: string, title: string) => void;
}

export function Sidebar({
  sheets,
  activeSheet,
  peers,
  onOpen,
  onAdd,
  onRename,
}: SidebarProps): React.ReactElement {
  // Which sheet is being renamed, if any. Renaming in place rather than in a
  // dialog: a sheet gets its real name a minute after it is made — "DA" becomes
  // "Politics DA" once you hear which one it is — and that is an edit to a word
  // on screen, not a decision worth a window.
  const [renaming, setRenaming] = useState<string | null>(null);

  return (
    <nav className="app__sidebar" aria-label="sheets">
      <div className="app__sidebar-head">
        <span>sheets</span>
        <button
          type="button"
          className="app__sidebar-add"
          onClick={onAdd}
          title="new sheet (:new)"
          // The sheet's keyboard belongs to the keymap; a focused button would
          // swallow the next keystroke meant for the flow.
          tabIndex={-1}
        >
          +
        </button>
      </div>

      <ul className="app__sheets">
        {sheets.map((sheet) => {
          const here = peers.filter((peer) => peer.sheet === sheet.id);
          return (
            <li
              key={sheet.id}
              className={`app__sheet${sheet.id === activeSheet ? " is-active" : ""}`}
              onClick={() => onOpen(sheet.id)}
              onDoubleClick={() => setRenaming(sheet.id)}
              title={sheet.title}
            >
              {renaming === sheet.id ? (
                <RenameField
                  value={sheet.title}
                  onDone={(title) => {
                    setRenaming(null);
                    // An empty name would leave a row you can't read or click
                    // with any confidence, so it simply isn't a rename.
                    if (title.trim()) onRename(sheet.id, title.trim());
                  }}
                />
              ) : (
                <span className="app__sheet-name">{sheet.title || "untitled"}</span>
              )}

              {/* Who is on this sheet, in the colours their cursors wear. Dots
                  rather than names: the names are on the status line, and this
                  column is as wide as a sheet title. */}
              {here.length > 0 && (
                <span className="app__sheet-peers">
                  {here.map((peer) => (
                    <i
                      key={peer.id}
                      className="app__sheet-peer"
                      style={{ background: peer.color }}
                      title={`${peer.name} is on ${sheet.title}`}
                    />
                  ))}
                </span>
              )}
            </li>
          );
        })}
      </ul>

      {sheets.length === 0 && (
        <p className="app__sheets-empty">
          no sheets — <kbd>:new</kbd>
        </p>
      )}
    </nav>
  );
}

/** The rename box: opens with the name selected, commits on Enter or blur. */
function RenameField({
  value,
  onDone,
}: {
  value: string;
  onDone: (title: string) => void;
}): React.ReactElement {
  const [text, setText] = useState(value);
  const input = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    input.current?.focus();
    // Selected, not just focused: you are far more often replacing a
    // placeholder name than editing one.
    input.current?.select();
  }, []);

  return (
    <input
      ref={input}
      className="app__sheet-rename"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => onDone(text)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        // Kept off the window keymap, which stands aside for an INPUT anyway;
        // this stops Enter and Escape reaching the sheet underneath.
        e.stopPropagation();
        if (e.key === "Enter") onDone(text);
        if (e.key === "Escape") onDone(value);
      }}
    />
  );
}
