import React from "react";
import { ArgumentEditor } from "./ArgumentEditor";
import type { Dictionary } from "../editor/completion";
import type { Argument } from "../model/types";

/**
 * One argument on the sheet, in whichever of its two states it's in: the text
 * as written, or the editor open on it.
 *
 * Both wear `flow-argument`, which is what makes the swap invisible — the
 * editor's three layers are sized by the same class the static text is (see
 * ArgumentEditor.tsx), so opening an argument doesn't move the sheet.
 *
 * No cursor state here: the *cell* wears it, so that the number is inside the
 * highlight — see the stylesheet.
 */

const ARGUMENT_CLASS = "flow-argument";

interface ArgumentViewProps {
  argument: Argument;
  editing: boolean;
  dictionary: Dictionary;
  /** As the user types, for the throttled write into the flow. */
  onChange: (text: string) => void;
  /** The editor is finished with: flush and leave edit mode. */
  onDone: () => void;
  /** Put the cursor here. */
  onSelect: () => void;
  /** Put the cursor here and open it. */
  onEdit: () => void;
}

export function ArgumentView({
  argument,
  editing,
  dictionary,
  onChange,
  onDone,
  onSelect,
  onEdit,
}: ArgumentViewProps): React.ReactElement {
  if (editing) {
    return (
      <ArgumentEditor
        className={ARGUMENT_CLASS}
        initialText={argument.text}
        dictionary={dictionary}
        onChange={onChange}
        onDone={onDone}
      />
    );
  }

  return (
    <div
      className={ARGUMENT_CLASS}
      // Through the same helper the keymap uses, so a click on a collapsed
      // rectangle two speeches away drops focus (and any selection) exactly
      // as `l l` would.
      onClick={onSelect}
      onDoubleClick={onEdit}
    >
      {argument.text || <span className="flow-argument__placeholder">empty</span>}
    </div>
  );
}
