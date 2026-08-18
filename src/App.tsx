import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { POLICY_SPEECHES } from "./model/format";
import { MEMORY_SPEECHES } from "./memory/sheet";
import { seedSample } from "./model/sample";
import { layoutFlow } from "./layout/grid";
import { selectionRange } from "./layout/navigate";
import { buildDictionary, textsOf, wordsIn } from "./editor/completion";
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
import { Keymap } from "./ui/Keymap";
import { Sidebar } from "./ui/Sidebar";
import { StatusLine } from "./ui/StatusLine";
import { useSession } from "./ui/useSession";
import { useLibrary } from "./ui/useLibrary";
import { useMemory } from "./ui/useMemory";
import { useMemoryRound } from "./ui/useMemoryRound";
import { useKeymap } from "./ui/useKeymap";
import { useConfig } from "./ui/useConfig";
import { useTextBuffer } from "./ui/useTextBuffer";
import { DEFAULT_MARK, DEFAULT_SUPPORT, type Argument } from "./model/types";

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
    round: roundDoc,
    flow: roundFlow,
    roots: roundRoots,
    sheets: roundSheets,
    activeSheet: roundSheet,
    room,
    status,
    peers,
    invitation,
    hosting,
    error,
    actions,
  } = useSession(seedSample);
  const [editor, setEditor] = useState(initialEditorState);
  const { cursorId, editingId, count, focus, command, selectAnchor, sidebar, help, zoom } =
    editor;

  // Where the round is kept. Bound by `:open` or the first `:save`, and from
  // then on the flow is written out as it is taken down.
  const library = useLibrary(roundDoc, actions.load);

  // Which key does what: the defaults with ~/.flow/config.json read over them.
  // Everything the keyboard touches takes them from here — the window listener,
  // the argument editor, and the sheet of keys on `:?`, which has to show the
  // ones this user actually has.
  const config = useConfig();

  // What the user carries between rounds: the answers they've memorized to
  // arguments, kept in ~/.flow. Nothing to do with the round's own folder
  // above — see memory/store.ts.
  const memory = useMemory();

  // The position the memory sheet opens on — whichever sheet `M` was pressed
  // from, since that is the one you were thinking about.
  const position = useMemo(
    () => roundSheets.find((sheet) => sheet.id === roundSheet)?.title ?? "",
    [roundSheets, roundSheet],
  );
  const memorySheet = useMemoryRound(memory, editor.memory, position);

  // What is on screen: the round, or what you have memorized. Both are a round
  // of sheets — that is the whole point of building the memory sheet as one —
  // so everything below this line takes them from one place and never has to
  // ask which it is drawing.
  const showing = useMemo(
    () =>
      editor.memory && memorySheet.round
        ? {
            round: memorySheet.round,
            flow: memorySheet.flow,
            roots: memorySheet.roots,
            sheets: memorySheet.sheets,
            activeSheet: memorySheet.activeSheet,
          }
        : {
            round: roundDoc,
            flow: roundFlow,
            roots: roundRoots,
            sheets: roundSheets,
            activeSheet: roundSheet,
          },
    [editor.memory, memorySheet, roundDoc, roundFlow, roundRoots, roundSheets, roundSheet],
  );
  const { round, flow, roots, sheets, activeSheet } = showing;

  // The speeches the sheet is drawn in. A memory sheet has two columns — the
  // argument and the answers to it — where the round has the format's seven.
  const speeches = editor.memory ? MEMORY_SPEECHES : SPEECHES;

  // What a keystroke does to the list on the left, on whichever substrate is
  // showing. On the memory sheet the list is your positions, so `:new` starts
  // one, renaming one moves every block under it, and deleting one throws the
  // blocks away — all of it the same keys, one level up, as always.
  const sheetActions = useMemo(
    () =>
      editor.memory && memorySheet.round
        ? {
            open: memorySheet.open,
            add: (title: string) => memorySheet.round!.addSheet(title),
            rename: (id: string, title: string) =>
              memorySheet.round!.renameSheet(id, title),
            remove: (id: string) => memorySheet.round!.removeSheet(id),
            // Positions are kept in alphabetical order and there is nothing to
            // read into where one sits, so there is nothing to reorder.
            move: () => {},
          }
        : {
            open: actions.openSheet,
            add: actions.addSheet,
            rename: actions.renameSheet,
            remove: actions.removeSheet,
            move: actions.moveSheet,
          },
    [editor.memory, memorySheet, actions],
  );

  const placed = useMemo(() => layoutFlow(roots), [roots]);

  // Rebuilt as the flow changes, so completions pick up the round's own
  // vocabulary as it's written. Memorized answers feed it too: they are words
  // this flower has already used, on a sheet that hasn't seen them yet.
  //
  // Memorized ones only, and not the imported ones — which is both halves of
  // what "already used" means. A backfile is somebody's cut cards rather than
  // your shorthand, so its words are not the ones to finish yours with; and
  // this is rebuilt on every keystroke, which a folder of files is far too much
  // to walk for.
  const dictionary = useMemo(
    () =>
      buildDictionary(
        textsOf(roots),
        wordsIn(memory.memorized.flatMap((block) => block.answers)),
      ),
    [roots, memory.memorized],
  );

  // How the cursor's own argument is marked, for the status line — but only
  // when it isn't the default, which is what the status line decides. With no
  // cursor there is no argument to report on, so it stands in the default and
  // the chip stays off; `DEFAULT_MARK` rather than the mark itself so that
  // "nothing to say" doesn't have to be restated here every time the default
  // moves.
  //
  // Read from the flow rather than from `roots`, but keyed on `roots`: the mark
  // is written to the document, so the read is only stale until the commit that
  // changed it lands — which is the same tick that replaces `roots`.
  const mark = useMemo(
    () => (cursorId && flow?.has(cursorId) ? flow.markOf(cursorId) : DEFAULT_MARK),
    [roots, cursorId, flow],
  );

  // Whether the cursor's own argument was read off evidence, on exactly the
  // terms `mark` above is: read from the document, keyed on `roots`, and
  // reported to the status line only when it isn't the default. The sheet says
  // this too (a dotted rule — see `.flow-cell.is-analytic`), but a dotted 1px
  // rule is a thing you read while scanning a column, not while looking at one
  // argument, and `c` is otherwise a key with no visible answer on a sheet you
  // haven't marked up yet.
  const support = useMemo(
    () => (cursorId && flow?.has(cursorId) ? flow.supportOf(cursorId) : DEFAULT_SUPPORT),
    [roots, cursorId, flow],
  );

  // What there is to recall against the cursor's own argument, for the status
  // line — which is the only warning that ⌘P is about to put four arguments on
  // the sheet, and the only sign that several imported files answer it and so
  // none of them will. Keyed on `roots` like `mark` above, and for the same
  // reason: it reads the document, and `roots` changing is the tick the
  // document changed on.
  const recalled = useMemo(
    () =>
      !editor.memory && cursorId && flow?.has(cursorId)
        ? memory.recall(flow.textOf(cursorId), position)
        : { block: null, among: 0 },
    [roots, cursorId, flow, memory, editor.memory, position],
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
    // Nothing while the memory sheet is up: those arguments are in a document
    // nobody else has, so a peer told about one would draw a cursor on an
    // argument that doesn't exist on their sheet.
    const away = editor.memory;
    actions.setLocal({
      cursorId: away ? null : cursorId,
      editing: !away && editingId !== null,
      speech: !away && cursorId && flow?.has(cursorId) ? flow.speechOf(cursorId) : null,
    });
  }, [actions, flow, roots, cursorId, editingId, editor.memory]);

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

  // Coming back to a substrate, put the cursor back where it was on it — `M`
  // stashes it under the sheet being left (see `toggleMemory`). Only ever
  // restores: an ordinary sheet change has already been through `openSheet`,
  // which leaves a cursor set, so this is a no-op there.
  useEffect(() => {
    setEditor((s) =>
      s.cursorId === null && activeSheet && s.cursors[activeSheet]
        ? { ...s, cursorId: s.cursors[activeSheet] }
        : s,
    );
  }, [editor.memory, activeSheet]);

  // Opening a sheet: the session decides what is on screen, the editor state
  // remembers where you were on the one you left. Both halves in one place, so
  // a click in the sidebar and `]` do exactly the same thing.
  const open = useCallback(
    (sheetId: string) => {
      if (sheetId === activeSheet) return;
      sheetActions.open(sheetId);
      setEditor((s) => openSheet(s, activeSheet, sheetId));
    },
    [sheetActions, activeSheet],
  );

  const sheetControls = useMemo<SheetControls>(
    () => ({
      list: sheets,
      active: activeSheet,
      open: sheetActions.open,
      move: sheetActions.move,
    }),
    [sheets, activeSheet, sheetActions],
  );

  // Vim-style keyboard control. Suspended while editing an argument.
  useKeymap(
    {
      state: editor,
      flow,
      round,
      placed,
      speeches,
      sheets: sheetControls,
      memory,
    },
    setEditor,
    flushText,
    config.keys,
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
        flow
          ? submitCommand({
              state: s,
              flow,
              round,
              placed,
              speeches,
              sheets: sheetControls,
              memory,
            })
          : cancelCommand(s),
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
        const id = sheetActions.add(session.title || "untitled");
        setEditor((s) => openSheet(s, activeSheet, id));
        break;
      }
      case "rename":
        if (activeSheet) sheetActions.rename(activeSheet, session.title);
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
        if (activeSheet && sheets.length > 1) sheetActions.remove(activeSheet);
        break;
      case "open":
        library.open();
        break;
      case "save":
        library.save();
        break;
      case "import":
        memory.importFrom();
        break;
      case "forget":
        memory.forget();
        break;
      case "config":
        config.seed();
        break;
    }
  }, [actions, config, flow, placed, sheets, activeSheet, open, sheetControls, library, memory, sheetActions, speeches]);

  const renderArgument = (arg: Argument) => (
    <ArgumentView
      key={arg.id === editingId ? `edit-${arg.id}` : arg.id}
      argument={arg}
      editing={arg.id === editingId}
      dictionary={dictionary}
      keys={config.keys}
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
        label={editor.memory ? "positions" : "sheets"}
        sheets={sheets}
        activeSheet={activeSheet}
        peers={peers}
        onOpen={open}
        onAdd={() => {
          const id = sheetActions.add("untitled");
          setEditor((s) => openSheet(s, activeSheet, id));
        }}
        onRename={sheetActions.rename}
        // Dragging a row reorders the round, the same as ⌘[ and ⌘] — but the
        // memory sheet's positions are alphabetical and nobody's to reorder,
        // so there the rows don't drag at all.
        onMove={editor.memory ? undefined : sheetActions.move}
        onDelete={(sheetId) => {
          // Same rule `:delete` follows — never the last sheet. The Sidebar
          // already hides the button in that case; this is the backstop.
          if (sheets.length > 1) sheetActions.remove(sheetId);
        }}
      />

      <div className="app__flow">
        <FlowSheet
          roots={roots}
          placed={placed}
          speeches={speeches}
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
        support={support}
        focusLabel={focus === null ? null : (speeches[focus]?.label ?? "")}
        zoom={zoom}
        room={room}
        status={status}
        peers={peers}
        invitation={invitation}
        hosting={hosting !== null}
        error={error}
        savedIn={library.directory}
        saveError={library.error}
        answers={recalled.block?.answers.length ?? 0}
        among={recalled.among}
        memory={editor.memory}
        memoryError={memory.error}
        memoryNote={memory.note}
        // What is wrong with ~/.flow/config.json, if anything. Nowhere else
        // would say: a key that silently does nothing is indistinguishable
        // from a key you mistyped.
        configError={config.problems[0] ?? null}
        // And what went right: `:config` wrote a file, or found one there.
        configNote={config.note}
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

      {/* What the keys do, on `:?`. Last, so it paints over the sheet and the
          status line both — it is the one thing in the app that is allowed to
          be in front of the flow. */}
      {help && (
        <Keymap
          keys={config.keys}
          onClose={() => setEditor((s) => ({ ...s, help: false }))}
        />
      )}
    </main>
  );
}

export default App;
