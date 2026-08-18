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
  /**
   * What the list is of. "sheets" for a round, "positions" for the memory
   * sheet — where the same list, the same keys and the same marks are doing
   * the same job one substrate over. See useMemoryRound.ts.
   */
  label: string;
  sheets: SheetInfo[];
  activeSheet: string | null;
  /** Everyone else, so each sheet can show who is on it. */
  peers: Peer[];
  onOpen: (sheetId: string) => void;
  onAdd: () => void;
  onRename: (sheetId: string, title: string) => void;
  /** Remove a sheet and everything on it. Never the last one — see App. */
  onDelete: (sheetId: string) => void;
  /**
   * Shift a sheet `by` places up or down the list — the same call `⌘[` and
   * `⌘]` make (see `shiftSheet`), so the mouse and the keyboard are doing one
   * thing and not two.
   *
   * Absent when the order isn't the user's to set: the memory sheet keeps its
   * positions alphabetical, and there the rows simply don't drag.
   */
  onMove?: (sheetId: string, by: number) => void;
}

export function Sidebar({
  label,
  sheets,
  activeSheet,
  peers,
  onOpen,
  onAdd,
  onRename,
  onDelete,
  onMove,
}: SidebarProps): React.ReactElement {
  // Which sheet is being renamed, if any. Renaming in place rather than in a
  // dialog: a sheet gets its real name a minute after it is made — "DA" becomes
  // "Politics DA" once you hear which one it is — and that is an edit to a word
  // on screen, not a decision worth a window.
  const [renaming, setRenaming] = useState<string | null>(null);

  // The row being dragged, and the gap it would drop into — an index *between*
  // rows, from 0 (above the first) to `sheets.length` (below the last). A gap
  // rather than a row because that is what a drop actually means, and because
  // the last one has no row to name it.
  const [dragging, setDragging] = useState<string | null>(null);
  const [slot, setSlot] = useState<number | null>(null);

  const from = dragging ? sheets.findIndex((sheet) => sheet.id === dragging) : -1;

  // The gap to draw the line in, or null where dropping would change nothing —
  // the two gaps either side of the row being dragged. A line promising a move
  // that won't happen is worse than no line at all.
  const marked =
    slot === null || from < 0 || slot === from || slot === from + 1 ? null : slot;

  const stopDrag = () => {
    setDragging(null);
    setSlot(null);
  };

  const drop = () => {
    // Taking the row out closes the gaps above it, so a gap below where it
    // started names a slot one further along than where it will come to rest.
    if (marked !== null && dragging) {
      const to = marked > from ? marked - 1 : marked;
      onMove?.(dragging, to - from);
    }
    stopDrag();
  };

  return (
    <nav
      className="app__sidebar"
      aria-label={label}
      // The empty space under the list means "put it at the end" — otherwise
      // the one drop you have to aim at the bottom half of a row to make, and
      // the list is a handful of rows in a column the height of the window.
      // Only where the pointer is on that space itself: over a row, the row
      // has already said which gap it means.
      onDragOver={(e) => {
        if (!dragging || e.target !== e.currentTarget) return;
        e.preventDefault();
        setSlot(sheets.length);
      }}
      onDrop={(e) => {
        e.preventDefault();
        drop();
      }}
    >
      <div className="app__sidebar-head">
        <span className="app__sidebar-label">{label}</span>
        <button
          type="button"
          className="app__sidebar-add"
          onClick={onAdd}
          title={`new ${label.replace(/e?s$/, "")} (:new)`}
          // The sheet's keyboard belongs to the keymap; a focused button would
          // swallow the next keystroke meant for the flow.
          tabIndex={-1}
        >
          +
        </button>
      </div>

      <ul className="app__sheets">
        {sheets.map((sheet, index) => {
          const here = peers.filter((peer) => peer.sheet === sheet.id);
          const line =
            marked === index
              ? " is-drop-before"
              : marked === sheets.length && index === sheets.length - 1
                ? " is-drop-after"
                : "";
          return (
            <li
              key={sheet.id}
              className={`app__sheet${sheet.id === activeSheet ? " is-active" : ""}${
                sheet.id === dragging ? " is-dragging" : ""
              }${line}`}
              onClick={() => onOpen(sheet.id)}
              onDoubleClick={() => setRenaming(sheet.id)}
              title={sheet.title}
              // Not while it's being renamed: a draggable row swallows the
              // selection the rename box is opened with.
              draggable={Boolean(onMove) && renaming !== sheet.id}
              onDragStart={(e) => {
                setDragging(sheet.id);
                e.dataTransfer.effectAllowed = "move";
                // Nothing reads it — the id is in state — but a drag that
                // carries no data is one some browsers refuse to start.
                e.dataTransfer.setData("text/plain", sheet.id);
              }}
              onDragEnd={stopDrag}
              onDragOver={(e) => {
                if (!dragging) return;
                // Which half of the row the pointer is in: above it, or below.
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                const box = e.currentTarget.getBoundingClientRect();
                setSlot(index + (e.clientY - box.top > box.height / 2 ? 1 : 0));
              }}
              onDrop={(e) => {
                e.preventDefault();
                e.stopPropagation();
                drop();
              }}
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

              {/* Never the last sheet — a round with nowhere to put the next
                  argument isn't a state a click should be able to reach, so
                  the button that would leave the round there doesn't appear. */}
              {sheets.length > 1 && (
                <button
                  type="button"
                  className="app__sheet-delete"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(sheet.id);
                  }}
                  title="delete sheet (:delete)"
                  tabIndex={-1}
                >
                  ×
                </button>
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
