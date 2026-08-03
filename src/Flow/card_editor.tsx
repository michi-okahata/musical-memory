import React, { useEffect, useRef, useState } from "react";
import { completionAt, type Dictionary } from "./complete";

/**
 * The text editor for one card, with the suggested rest of the current word
 * shown behind the caret. Tab takes it.
 *
 * Three layers, all sharing the card's metrics so they line up character for
 * character:
 *
 *   1. a sizer that holds the real text and gives the box its height — which
 *      is why nothing here measures or sets a height;
 *   2. the ghost, which draws the suggestion at the caret and hides
 *      everything else;
 *   3. the textarea, transparent, on top.
 *
 * Deliberately *not* sized by the suggestion: the box must not flinch every
 * time a keystroke changes what's being offered.
 */

interface CardEditorProps {
  className: string;
  initialText: string;
  dictionary: Dictionary;
  /** Called as the user types, for the throttled write into the flow. */
  onChange: (text: string) => void;
  /** Escape, Enter, or focus loss: flush and leave edit mode. */
  onDone: () => void;
}

export function CardEditor({
  className,
  initialText,
  dictionary,
  onChange,
  onDone,
}: CardEditorProps): React.ReactElement {
  // Local state, so a keystroke shows up now rather than after a round trip
  // through the CRDT — the flow is written to on a timer.
  const [text, setText] = useState(initialText);
  const [caret, setCaret] = useState(initialText.length);
  const ref = useRef<HTMLTextAreaElement | null>(null);

  const suggestion = completionAt(text, caret, dictionary) ?? "";

  const write = (next: string, at: number) => {
    setText(next);
    setCaret(at);
    onChange(next);
  };

  const accept = () => {
    const el = ref.current;
    if (!el || !suggestion) return;
    const next = text.slice(0, caret) + suggestion + text.slice(caret);
    const at = caret + suggestion.length;
    write(next, at);
    // The DOM value is set by React on the next render; move the caret after it.
    requestAnimationFrame(() => el.setSelectionRange(at, at));
  };

  // Start at the end of the text, the way resuming a card should feel.
  useEffect(() => {
    const el = ref.current;
    el?.setSelectionRange(el.value.length, el.value.length);
  }, []);

  return (
    <div className="flow-editor">
      <div className={`${className} flow-editor__sizer`} aria-hidden="true">
        {text}
        {/* pre-wrap gives a trailing newline no line box of its own. */}
        {"​"}
      </div>

      {suggestion && (
        <div className={`${className} flow-editor__ghost`} aria-hidden="true">
          <span className="flow-editor__hidden">{text.slice(0, caret)}</span>
          <span className="flow-editor__suggest">{suggestion}</span>
          <span className="flow-editor__hidden">{text.slice(caret)}</span>
        </div>
      )}

      <textarea
        ref={ref}
        className={`${className} flow-card--edit`}
        autoFocus
        value={text}
        onChange={(e) => write(e.currentTarget.value, e.currentTarget.selectionStart)}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
        onBlur={onDone}
        onKeyDown={(e) => {
          // The card keymap must not see keys meant for the text.
          e.stopPropagation();
          if (e.key === "Tab" && suggestion) {
            e.preventDefault();
            accept();
            return;
          }
          if (e.key === "Escape" || (e.key === "Enter" && !e.shiftKey)) {
            e.preventDefault();
            onDone();
          }
        }}
      />
    </div>
  );
}
