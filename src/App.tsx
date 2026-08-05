import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { POLICY_SPEECHES } from "./model/format";
import { seedSample } from "./model/sample";
import { layoutFlow } from "./layout/grid";
import { selectionRange } from "./layout/navigate";
import { buildDictionary, textsOf } from "./editor/completion";
import {
  cancelCommand,
  parseSessionCommand,
  resolveSheet,
  submitCommand,
  typeCommand,
} from "./editor/commands";
import {
  initialEditorState,
  moveCursorTo,
  openSheet,
  type SheetControls,
} from "./editor/state";
import { ArgumentView } from "./ui/ArgumentView";
import { FlowSheet } from "./ui/FlowSheet";
import { Sidebar } from "./ui/Sidebar";
import { StatusLine } from "./ui/StatusLine";
import { useSession } from "./ui/useSession";
import { useKeymap } from "./ui/useKeymap";
import { useTextBuffer } from "./ui/useTextBuffer";
import type { Argument } from "./model/types";

/**
 * The composition root: it owns the round and the editor state, derives what
 * the sheet and the status line need from them, and wires the keyboard up.
 *
 * Everything it hands down is either state or a callback — no logic lives
 * here. What a key does is in editor/, where an argument sits is in layout/,
 * what the document is is in model/, and who else is in it is in sync/.
 */

const SPEECHES = POLICY_SPEECHES;

function App() {
  // The round arrives from the session rather than being made here, because it
  // is the session that replaces it when you join somebody's room. Alone, the
  // difference is invisible: no connection is opened until `:host` or `:join`.
  const {
    round,
    flow,
    roots,
    sheets,
    activeSheet,
    room,
    status,
    peers,
    invitation,
    hosting,
    error,
    actions,
  } = useSession(seedSample);
  const [editor, setEditor] = useState(initialEditorState);
  const { cursorId, editingId, count, focus, command, selectAnchor, sidebar, zoom } =
    editor;

  const placed = useMemo(() => layoutFlow(roots), [roots]);

  // Rebuilt as the flow changes, so completions pick up the round's own
  // vocabulary as it's written.
  const dictionary = useMemo(() => buildDictionary(textsOf(roots)), [roots]);

  // How the cursor's own argument is marked, for the status line — but only
  // when it isn't the default. A run of one draws no mark at all (a bare "1."
  // is noise), so without this `#` would look like a key that does nothing on
  // the first argument of a fresh run, which is exactly where you press it.
  //
  // Read from the flow rather than from `roots`, but keyed on `roots`: the mark
  // is written to the document, so the read is only stale until the commit that
  // changed it lands — which is the same tick that replaces `roots`.
  const mark = useMemo(
    () => (cursorId && flow?.has(cursorId) ? flow.markOf(cursorId) : "num"),
    [roots, cursorId, flow],
  );

  // The selection's size, for the status line. Derived rather than read off
  // the state directly for the same reason `#` and `x` derive it (see
  // `selectedIds` in commands.ts) — `selectAnchor` is only ever an anchor, not
  // a cached list, so anything that wants to know how many arguments are
  // selected has to ask `placed` the same question the commands do.
  const selectionSize = useMemo(
    () => selectionRange(placed, selectAnchor, cursorId).length,
    [placed, selectAnchor, cursorId],
  );

  // Who wrote the argument the cursor is on, when it wasn't this peer. Only in
  // a room: alone, every argument is yours and the answer is never interesting.
  //
  // Keyed on `roots` for the same reason `mark` is — it reads the document
  // directly, and `roots` changing is the tick the document changed on.
  const authorLabel = useMemo(() => {
    if (!room || !cursorId || !flow?.has(cursorId)) return null;
    const author = round.authorOf(cursorId);
    if (!author || author === round.peerId) return null;
    const record = round.peerRecord(author);
    if (!record) return "someone else";
    return record.role === "ai" ? `${record.name} (ai)` : record.name;
  }, [roots, cursorId, flow, round, room]);

  // Undo restores the cursor to wherever the change was made, which means the
  // round has to be able to read the cursor as each change commits — including
  // which sheet it was on, since a change may be undone from a different one.
  const placeRef = useRef<{ sheet: string; id: string | null } | null>(null);
  placeRef.current = activeSheet ? { sheet: activeSheet, id: cursorId } : null;
  useEffect(() => round.trackCursor(() => placeRef.current), [round]);

  // Tell the room where this peer is. Presence, not document — see session.ts.
  // `roots` is a dependency because the speech an argument sits in can change
  // under a cursor that hasn't moved.
  useEffect(() => {
    actions.setLocal({
      cursorId,
      editing: editingId !== null,
      speech: cursorId && flow?.has(cursorId) ? flow.speechOf(cursorId) : null,
    });
  }, [actions, flow, roots, cursorId, editingId]);

  const { beginText, queueText, flushText } = useTextBuffer(flow);

  // Every way into edit mode passes through here — the keymap's creating keys,
  // `i`, a double click — so this is the one place that can tell the buffer
  // which text the editor was seeded with. See `beginText`.
  useEffect(() => {
    if (editingId) beginText(editingId);
  }, [editingId, beginText]);

  // Leave edit mode, making sure the last keystrokes are in the doc first.
  const stopEditing = useCallback(() => {
    flushText();
    setEditor((s) => ({ ...s, editingId: null }));
  }, [flushText]);

  // Keep the cursor valid if its argument disappears (e.g. after delete).
  //
  // Asked of the flow, not of `placed`: the layout trails the document by a
  // tick, because Loro delivers its change events asynchronously. Testing
  // against it would drop the cursor undo had just legitimately restored — the
  // argument is back in the document, but not yet in the layout.
  useEffect(() => {
    if (cursorId && flow && !flow.has(cursorId)) {
      setEditor((s) => ({ ...s, cursorId: null }));
    }
  }, [roots, cursorId, flow]);

  // Opening a sheet: the session decides what is on screen, the editor state
  // remembers where you were on the one you left. Both halves in one place, so
  // a click in the sidebar and `]` do exactly the same thing.
  const open = useCallback(
    (sheetId: string) => {
      if (sheetId === activeSheet) return;
      actions.openSheet(sheetId);
      setEditor((s) => openSheet(s, activeSheet, sheetId));
    },
    [actions, activeSheet],
  );

  const sheetControls = useMemo<SheetControls>(
    () => ({
      list: sheets,
      active: activeSheet,
      open: actions.openSheet,
      move: actions.moveSheet,
    }),
    [sheets, activeSheet, actions],
  );

  // Vim-style keyboard control. Suspended while editing an argument.
  useKeymap(
    { state: editor, flow, round, placed, speeches: SPEECHES, sheets: sheetControls },
    setEditor,
  );

  // What the command line says, read at submit time rather than from this
  // render's closure — see the note on the status line's handlers below.
  const commandRef = useRef<string | null>(null);
  commandRef.current = command;

  // Submitting the command line. The room and sheet commands are run here,
  // outside the state updater, because they are not state transitions at all:
  // they open connections and change the document, and StrictMode
  // double-invokes updaters. Anything else typed is a speech to jump to, which
  // is pure, and goes through `submitCommand` exactly as before.
  const runCommand = useCallback(() => {
    const session = parseSessionCommand(commandRef.current ?? "");
    if (!session) {
      setEditor((s) =>
        flow ? submitCommand({ state: s, flow, round, placed, speeches: SPEECHES, sheets: sheetControls }) : cancelCommand(s),
      );
      return;
    }
    setEditor(cancelCommand);
    switch (session.kind) {
      case "host":
        actions.host();
        break;
      case "share":
        actions.share();
        break;
      case "join":
        actions.join(session.invitation);
        break;
      case "relay":
        actions.useRelay(session.host);
        break;
      case "leave":
        actions.leave();
        break;
      case "name":
        actions.rename(session.name);
        break;
      case "new": {
        const id = actions.addSheet(session.title || "untitled");
        setEditor((s) => openSheet(s, activeSheet, id));
        break;
      }
      case "rename":
        if (activeSheet) actions.renameSheet(activeSheet, session.title);
        break;
      case "sheet": {
        const id = resolveSheet(session.name, sheets);
        if (id) open(id);
        break;
      }
      case "delete":
        // Never the last one: a round with no sheets has nowhere to put the
        // next argument, and the way to clear a sheet you don't want is to
        // delete what's on it.
        if (activeSheet && sheets.length > 1) actions.removeSheet(activeSheet);
        break;
    }
  }, [actions, flow, placed, sheets, activeSheet, open, sheetControls]);

  const renderArgument = (arg: Argument) => (
    <ArgumentView
      key={arg.id === editingId ? `edit-${arg.id}` : arg.id}
      argument={arg}
      editing={arg.id === editingId}
      dictionary={dictionary}
      onChange={(text) => queueText(arg.id, text)}
      onDone={stopEditing}
      onSelect={() => flow && setEditor((s) => moveCursorTo(s, flow, arg.id, placed))}
      onEdit={() =>
        flow &&
        setEditor((s) => ({
          ...moveCursorTo(s, flow, arg.id, placed),
          editingId: arg.id,
          count: null,
        }))
      }
    />
  );

  return (
    // The zoom multiplier is handed to the stylesheet here and read back out of
    // it by every metric the sheet is drawn at — see the `.app` block. The cast
    // is only because React's CSSProperties has no room for custom properties.
    <main
      className={`app${sidebar ? "" : " app--no-sidebar"}`}
      style={{ "--zoom": zoom } as CSSProperties}
    >
      <Sidebar
        sheets={sheets}
        activeSheet={activeSheet}
        peers={peers}
        onOpen={open}
        onAdd={() => {
          const id = actions.addSheet("untitled");
          setEditor((s) => openSheet(s, activeSheet, id));
        }}
        onRename={actions.renameSheet}
      />

      <div className="app__flow">
        <FlowSheet
          roots={roots}
          placed={placed}
          speeches={SPEECHES}
          cursorId={cursorId}
          selectAnchor={selectAnchor}
          focus={focus}
          zoom={zoom}
          // Only the peers on this sheet: everybody else's cursor is on an
          // argument that isn't drawn here, and the sidebar is where they show.
          peers={peers.filter((peer) => peer.sheet === activeSheet)}
          renderArgument={renderArgument}
        />
      </div>

      <StatusLine
        count={count}
        command={command}
        editing={editingId !== null}
        selecting={selectAnchor !== null}
        selectionSize={selectionSize}
        mark={mark}
        focusLabel={focus === null ? null : (SPEECHES[focus]?.label ?? "")}
        zoom={zoom}
        room={room}
        status={status}
        peers={peers}
        invitation={invitation}
        hosting={hosting !== null}
        error={error}
        authorLabel={authorLabel}
        // Every one of these takes the *latest* state rather than the `editor`
        // this render closed over — see CommandLine.tsx. Hence also the
        // already-closed check on cancel: once the command line is gone there
        // is nothing left to cancel.
        onCommandChange={(text) => setEditor((s) => typeCommand(s, text))}
        onCommandSubmit={runCommand}
        onCommandCancel={() =>
          setEditor((s) => (s.command === null ? s : cancelCommand(s)))
        }
      />
    </main>
  );
}

export default App;
