import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DebateFlow } from "./Flow/DebateFlow";
import { layoutFlow } from "./Flow/layout";
import type { Argument } from "./Flow/types";
import { Flow } from "./Flow/Flow";
import { useFlow } from "./Flow/useFlow";
import { commands, initialEditorState, keyOf } from "./Flow/commands";
import "./App.css";

// Policy debate speech order, 1AC … 2AR. The 2NC and 1NR are the consecutive
// negative speeches, flowed together as one column: the negative "block".
const SPEECHES = ["1AC", "1NC", "2AC", "Block", "1AR", "2NR", "2AR"];

// Typing writes through to the CRDT at most this often. Each write commits,
// which re-renders and re-measures the whole grid — too much per keystroke.
// Edits always flush synchronously when the card closes, so nothing is lost.
const TEXT_WRITE_MS = 150;

// Grow the textarea to fit its content so editing matches the display card
// (no fixed-row jump). Portable across Tauri's webviews (no `field-sizing`).
function autoSize(el: HTMLTextAreaElement) {
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}

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
  const { cursorId, editingId } = editor;

  const placed = useMemo(() => layoutFlow(roots), [roots]);

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
  useEffect(() => {
    if (cursorId && !placed.some((p) => p.id === cursorId)) {
      setEditor((s) => ({ ...s, cursorId: null }));
    }
  }, [placed, cursorId]);

  // Vim-style keyboard control. Suspended while editing a card.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (editingId) return; // let the textarea own the keyboard
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;

      const command = commands[keyOf(e)];
      if (!command) return;
      e.preventDefault();
      // Run the command here, not inside the setState updater: commands mutate
      // the flow, and StrictMode double-invokes updaters in development.
      setEditor(
        command({ state: editor, flow, placed, speechCount: SPEECHES.length }),
      );
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [placed, editor, editingId, flow]);

  const renderArgument = (arg: Argument) => {
    const isCursor = arg.id === cursorId;
    const isEditing = arg.id === editingId;

    const cardClass = `flow-card${isCursor ? " is-cursor" : ""}`;

    if (isEditing) {
      return (
        <textarea
          className={`${cardClass} flow-card--edit`}
          autoFocus
          rows={1}
          defaultValue={arg.text}
          ref={(el) => {
            if (el) autoSize(el);
          }}
          onFocus={(e) => {
            const el = e.currentTarget;
            el.setSelectionRange(el.value.length, el.value.length);
          }}
          onChange={(e) => {
            autoSize(e.currentTarget);
            queueText(arg.id, e.currentTarget.value);
          }}
          onBlur={stopEditing}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Escape" || (e.key === "Enter" && !e.shiftKey)) {
              e.preventDefault();
              stopEditing();
            }
          }}
        />
      );
    }

    return (
      <div
        className={cardClass}
        onClick={() => setEditor((s) => ({ ...s, cursorId: arg.id }))}
        onDoubleClick={() =>
          setEditor({ cursorId: arg.id, editingId: arg.id })
        }
      >
        {arg.text || <span className="flow-card__placeholder">empty</span>}
      </div>
    );
  };

  return (
    <main className="app">
      <h1 className="app__title">Flow</h1>
      <p className="app__hint">
        <b>h j k l</b> move · <b>a</b> answer · <b>s</b> sibling · <b>i</b>/
        <b>Enter</b> edit · <b>O</b> new argument · <b>x</b> delete · <b>u</b>{" "}
        undo · <b>Ctrl-r</b> redo · <b>Esc</b> stop editing
      </p>

      <DebateFlow
        roots={roots}
        placed={placed}
        speechCount={SPEECHES.length}
        speechLabels={SPEECHES}
        renderArgument={renderArgument}
      />
    </main>
  );
}

export default App;
