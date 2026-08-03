import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { DebateFlow } from "./flow/flow_view";
import { layoutFlow } from "./flow/layout_engine";
import type { Argument, Speech } from "./flow/types";
import { Flow } from "./flow/flow_crdt";
import { useFlow } from "./flow/flow_user";
import {
  cancelCommand,
  initialEditorState,
  keyOf,
  moveCursorTo,
  run,
  scaleZoom,
  submitCommand,
  typeCommand,
} from "./flow/commands";
import { CardEditor } from "./flow/card_editor";
import { buildDictionary, textsOf } from "./flow/complete";
import "./App.css";

// Policy debate speech order, 1AC … 2AR. The 2NC and 1NR are the consecutive
// negative speeches, flowed together as one column: the negative "block".
//
// `weight` is each speech's share of the sheet, and they are deliberately all
// the same. Giving the 1AC and 1NC less — they're read off prepared documents,
// so they get flowed in fewer words — reads as cramped rather than efficient:
// the two columns you refer back to most end up the hardest to read. Focus
// mode is the answer to a crowded sheet instead. The knob stays because a
// column's width is a real thing to want to tune.
//
// `side` is what the sheet shades by. The speeches alternate, so a sheet you
// aren't reading closely still reads as a conversation rather than as seven
// columns of text — and the answer to "where did the 2AC go" is a glance.
const SPEECHES: Speech[] = [
  { label: "1AC", weight: 1, side: "aff" },
  { label: "1NC", weight: 1, side: "neg" },
  { label: "2AC", weight: 1, side: "aff" },
  { label: "Block", weight: 1, side: "neg" },
  { label: "1AR", weight: 1, side: "aff" },
  { label: "2NR", weight: 1, side: "neg" },
  { label: "2AR", weight: 1, side: "aff" },
];

// The keymap, as it appears on the status line: key, then what it does. A list
// rather than prose so the line stays one shape — every key in the sheet's ink,
// every gloss in the status line's grey, and the separators quieter than both.
const HINTS: [key: string, does: string][] = [
  ["hjkl", "move"],
  [":2ac", "speech"],
  ["a", "answer"],
  ["o/O", "below/above"],
  ["n/N", "new argument"],
  ["i", "edit"],
  ["Tab", "complete"],
  ["f", "focus"],
  ["+/-", "zoom"],
  ["x", "delete"],
  ["u", "undo"],
];

// Typing writes through to the CRDT at most this often. Each write commits,
// which re-renders and re-measures the whole grid — too much per keystroke.
// Edits always flush synchronously when the card closes, so nothing is lost.
const TEXT_WRITE_MS = 150;

// Seed a small sample flow so the grid isn't empty on first load. One batch, so
// it lands as a single change rather than six.
function seed(flow: Flow) {
  flow.batch(() => {
    const econ = flow.addRoot(null, "Plan tanks the economy", 0);
    flow.addResponse(econ, "No internal link — spending is offset");
    const war = flow.addResponse(econ, "Econ decline → great-power war");
    flow.addResponse(war, "Interdependence checks escalation", 2);

    const warming = flow.addRoot(null, "Solves warming: -2C by 2050", 0);
    flow.addResponse(warming, "Too slow — tipping points already passed");
  });
}

function App() {
  const { flow, roots } = useFlow(seed);
  const [editor, setEditor] = useState(initialEditorState);
  const { cursorId, editingId, count, focus, command, zoom } = editor;

  const placed = useMemo(() => layoutFlow(roots), [roots]);

  // Rebuilt as the flow changes, so completions pick up the round's own
  // vocabulary as it's written.
  const dictionary = useMemo(() => buildDictionary(textsOf(roots)), [roots]);

  // Undo restores the cursor to wherever the change was made, which means the
  // flow has to be able to read the cursor as each change commits.
  const cursorRef = useRef<string | null>(null);
  cursorRef.current = cursorId;
  useEffect(() => flow.trackCursor(() => cursorRef.current), [flow]);

  // Buffer keystrokes and write through on a timer (see TEXT_WRITE_MS).
  const pending = useRef<{ id: string; text: string } | null>(null);
  const timer = useRef<number | null>(null);

  const flushText = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const p = pending.current;
    pending.current = null;
    if (p && flow.has(p.id)) flow.setText(p.id, p.text);
  }, [flow]);

  const queueText = (id: string, text: string) => {
    pending.current = { id, text };
    if (timer.current !== null) return;
    timer.current = window.setTimeout(() => {
      timer.current = null;
      flushText();
    }, TEXT_WRITE_MS);
  };

  // Don't lose a buffered edit if the app unmounts mid-typing.
  useEffect(() => flushText, [flushText]);

  // Leave edit mode, making sure the last keystrokes are in the doc first.
  const stopEditing = useCallback(() => {
    flushText();
    setEditor((s) => ({ ...s, editingId: null }));
  }, [flushText]);

  // Keep the cursor valid if its card disappears (e.g. after delete).
  //
  // Asked of the flow, not of `placed`: the layout trails the document by a
  // tick, because Loro delivers its change events asynchronously. Testing
  // against it would drop the cursor undo had just legitimately restored — the
  // card is back in the document, but not yet in the layout.
  useEffect(() => {
    if (cursorId && !flow.has(cursorId)) {
      setEditor((s) => ({ ...s, cursorId: null }));
    }
  }, [roots, cursorId, flow]);

  // Vim-style keyboard control. Suspended while editing a card.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (editingId) return; // let the textarea own the keyboard
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;

      // Run the command here, not inside the setState updater: commands mutate
      // the flow, and StrictMode double-invokes updaters in development.
      const next = run(keyOf(e), {
        state: editor,
        flow,
        placed,
        speeches: SPEECHES,
      });
      if (!next) return;
      e.preventDefault();
      setEditor(next);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [placed, editor, editingId, flow]);

  // Pinch to zoom. A trackpad pinch arrives as a wheel event with ctrlKey set —
  // the same shape as ctrl-scroll, which is the mouse gesture for this anyway,
  // so one handler covers both. Unlike Cmd +/-, this one *is* cancellable, so
  // taking it means the sheet zooms instead of the page.
  //
  // Listened for directly rather than through onWheel because React attaches
  // wheel handlers passively, and a passive listener may not preventDefault.
  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return; // an ordinary scroll is an ordinary scroll
      e.preventDefault();
      // Exponential in the distance pinched, which is what makes the sheet
      // track the fingers: the same spread scales by the same ratio wherever
      // the zoom already is.
      setEditor((s) => scaleZoom(s, Math.exp(-e.deltaY / 100)));
    };
    window.addEventListener("wheel", onWheel, { passive: false });
    return () => window.removeEventListener("wheel", onWheel);
  }, []);

  const renderArgument = (arg: Argument) => {
    const isCursor = arg.id === cursorId;
    const cardClass = `flow-card${isCursor ? " is-cursor" : ""}`;

    if (arg.id === editingId) {
      return (
        <CardEditor
          key={`edit-${arg.id}`}
          className={cardClass}
          initialText={arg.text}
          dictionary={dictionary}
          onChange={(text) => queueText(arg.id, text)}
          onDone={stopEditing}
        />
      );
    }

    return (
      <div
        className={cardClass}
        // Through the same helper the keymap uses, so a click on a collapsed
        // rectangle two speeches away drops focus exactly as `l l` would.
        onClick={() => setEditor((s) => moveCursorTo(s, flow, arg.id))}
        onDoubleClick={() =>
          setEditor((s) => ({
            ...moveCursorTo(s, flow, arg.id),
            editingId: arg.id,
            count: null,
          }))
        }
      >
        {arg.text || <span className="flow-card__placeholder">empty</span>}
      </div>
    );
  };

  return (
    // The zoom multiplier is handed to the stylesheet here and read back out of
    // it by every metric the sheet is drawn at — see the `.app` block. The cast
    // is only because React's CSSProperties has no room for custom properties.
    <main className="app" style={{ "--zoom": zoom } as CSSProperties}>
      <DebateFlow
        roots={roots}
        placed={placed}
        speeches={SPEECHES}
        cursorId={cursorId}
        focus={focus}
        zoom={zoom}
        renderArgument={renderArgument}
      />

      {/* A status line rather than a banner: the sheet is what the screen is
          for, and a hint above it pushed the first speech down the page. */}
      <footer className="app__status">
        <span className="app__count">{count ?? ""}</span>

        {/* The command line takes the status line over while it's open — it is
            the same thing vim's is: a place to say something longer than a
            keystroke. Being a real input means the browser handles the caret
            and editing keys, and the global keymap already stands aside for
            anything focused in an INPUT. */}
        {command !== null ? (
          <span className="app__cmdline">
            :
            <input
              className="app__cmd"
              autoFocus
              value={command}
              // Every one of these takes the *latest* state rather than the
              // `editor` this render closed over. Submitting unmounts the
              // input, which fires blur — and a blur handler holding the
              // pre-submit state would put the cursor straight back where it
              // started. Hence also the already-closed check: once the command
              // line is gone there is nothing left to cancel.
              onChange={(e) => {
                const text = e.target.value;
                setEditor((s) => typeCommand(s, text));
              }}
              onBlur={() =>
                setEditor((s) => (s.command === null ? s : cancelCommand(s)))
              }
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") {
                  e.preventDefault();
                  // Safe inside the updater: unlike the creating commands,
                  // this only moves the cursor — it never touches the flow.
                  setEditor((s) =>
                    submitCommand({ state: s, flow, placed, speeches: SPEECHES }),
                  );
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  setEditor((s) => cancelCommand(s));
                }
              }}
            />
          </span>
        ) : (
          <span className="app__hint">
            {HINTS.map(([key, what], i) => (
              <span key={key}>
                {i > 0 && <i> · </i>}
                <kbd>{key}</kbd> {what}
              </span>
            ))}
          </span>
        )}
        {/* Naming the pinned speech matters now that it doesn't follow the
            cursor — it's the difference between "focus is on" and knowing
            which three columns you're inside. */}
        {focus !== null && (
          <span className="app__mode">focus {SPEECHES[focus]?.label ?? ""}</span>
        )}
        {/* Only once it's been touched: at 1 the sheet is at its authored size,
            and a permanent "100%" would be one more thing on the line saying
            nothing. Shown at all because a pinch can leave you at a scale you
            didn't choose deliberately, and `=` is the way back. */}
        {zoom !== 1 && (
          <span className="app__mode">{Math.round(zoom * 100)}%</span>
        )}
      </footer>
    </main>
  );
}

export default App;
