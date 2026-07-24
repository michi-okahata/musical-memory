import { useEffect, useMemo, useState } from "react";
import { DebateFlow, layoutFlow, type Argument } from "./Flow/Flow.tsx";
import { Flow } from "./Flow/Flow";
import { useFlow } from "./Flow/useFlow";
import { moveCursor, type Motion } from "./Flow/navigate";
import "./App.css";

// Policy debate speech order, 1AC … 2AR. The 2NC and 1NR are the consecutive
// negative speeches, flowed together as one column: the negative "block".
const SPEECHES = ["1AC", "1NC", "2AC", "Block", "1AR", "2NR", "2AR"];
const MOTIONS: Motion[] = ["h", "j", "k", "l"];

// Grow the textarea to fit its content so editing matches the display card
// (no fixed-row jump). Portable across Tauri's webviews (no `field-sizing`).
function autoSize(el: HTMLTextAreaElement) {
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}

// Seed a small sample flow so the grid isn't empty on first load.
function seed(flow: Flow) {
  const econ = flow.addArgument("Plan tanks the economy", 0);
  flow.addResponse(econ, "No internal link — spending is offset");
  const war = flow.addResponse(econ, "Econ decline → great-power war");
  flow.addResponse(war, "Interdependence checks escalation", 2);

  const warming = flow.addArgument("Solves warming: -2C by 2050", 0);
  flow.addResponse(warming, "Too slow — tipping points already passed");
}

function App() {
  const { flow, roots } = useFlow(seed);
  const [cursorId, setCursorId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

  const placed = useMemo(() => layoutFlow(roots), [roots]);

  // Keep the cursor valid if its card disappears (e.g. after delete).
  useEffect(() => {
    if (cursorId && !placed.some((p) => p.id === cursorId)) setCursorId(null);
  }, [placed, cursorId]);

  // Vim-style keyboard control. Suspended while editing a card.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (editingId) return; // let the textarea own the keyboard
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;

      if ((MOTIONS as string[]).includes(e.key)) {
        e.preventDefault();
        setCursorId((id) => moveCursor(placed, id, e.key as Motion));
        return;
      }
      switch (e.key) {
        case "i":
        case "Enter":
          if (cursorId) {
            e.preventDefault();
            setEditingId(cursorId);
          }
          break;
        case "o": // add a response to the cursor and edit it
          if (cursorId) {
            e.preventDefault();
            const cur = placed.find((p) => p.id === cursorId);
            const nextSpeech = (cur?.col ?? 0) + 1;
            if (nextSpeech >= SPEECHES.length) break; // nothing past the 2AR
            const id = flow.addResponse(cursorId, "", nextSpeech);
            setCursorId(id);
            setEditingId(id);
          }
          break;
        case "a": // add another response to the same parent (sibling) and edit
          if (cursorId) {
            e.preventDefault();
            const id = flow.addSibling(cursorId, "");
            setCursorId(id);
            setEditingId(id);
          }
          break;
        case "O": // start a new argument tree in the cursor's own speech
          e.preventDefault();
          {
            const cur = placed.find((p) => p.id === cursorId);
            const id = flow.addRootAfter(cursorId, "", cur?.col ?? 0);
            setCursorId(id);
            setEditingId(id);
          }
          break;
        case "x": // delete the cursor card + its subtree; land on its parent
          if (cursorId) {
            e.preventDefault();
            const parent = flow.parentOf(cursorId);
            flow.remove(cursorId);
            setCursorId(parent);
          }
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [placed, cursorId, editingId, flow]);

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
            flow.setText(arg.id, e.currentTarget.value);
          }}
          onBlur={() => setEditingId(null)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Escape" || (e.key === "Enter" && !e.shiftKey)) {
              e.preventDefault();
              setEditingId(null);
            }
          }}
        />
      );
    }

    return (
      <div
        className={cardClass}
        onClick={() => setCursorId(arg.id)}
        onDoubleClick={() => setEditingId(arg.id)}
      >
        {arg.text || <span className="flow-card__placeholder">empty</span>}
      </div>
    );
  };

  return (
    <main className="app">
      <h1 className="app__title">Flow</h1>
      <p className="app__hint">
        <b>h j k l</b> move · <b>i</b>/<b>Enter</b> edit · <b>o</b> respond ·{" "}
        <b>a</b> sibling · <b>O</b> new argument · <b>x</b> delete · <b>Esc</b>{" "}
        stop editing
      </p>

      <DebateFlow
        roots={roots}
        speechCount={SPEECHES.length}
        speechLabels={SPEECHES}
        renderArgument={renderArgument}
      />
    </main>
  );
}

export default App;
