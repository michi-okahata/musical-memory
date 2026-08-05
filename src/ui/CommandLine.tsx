import React from "react";

/**
 * The command line takes the status line over while it's open — it is the same
 * thing vim's is: a place to say something longer than a keystroke.
 *
 * Being a real input means the browser handles the caret and the editing keys,
 * and the global keymap already stands aside for anything focused in an INPUT
 * (see useKeymap.ts).
 *
 * Every callback here has to be given the *latest* editor state by its caller
 * rather than one captured at render. Submitting unmounts the input, which
 * fires blur — and a blur handler holding the pre-submit state would put the
 * cursor straight back where it started.
 */

interface CommandLineProps {
  value: string;
  onChange: (text: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}

export function CommandLine({
  value,
  onChange,
  onSubmit,
  onCancel,
}: CommandLineProps): React.ReactElement {
  return (
    <span className="app__cmdline">
      :
      <input
        className="app__cmd"
        autoFocus
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onCancel}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") {
            e.preventDefault();
            onSubmit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
      />
    </span>
  );
}
