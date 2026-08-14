import { useCallback, useEffect, useRef } from "react";
import type { Flow } from "../model/flow";

/**
 * Buffer an argument's keystrokes and write them through to the flow on a
 * timer.
 *
 * Each write commits, which re-renders and re-measures the whole grid — too
 * much to do per keystroke. `flushText` is the escape hatch: call it before
 * anything that has to see the final text (leaving edit mode, unmounting), and
 * nothing is lost.
 *
 * What lands in the document is the *span that changed* (see `Flow.spliceText`),
 * worked out here against the last string this buffer wrote — which is what
 * lets somebody else be in the same argument. Writing the whole string back
 * would delete whatever they added while you were typing.
 */

/** Typing writes through to the CRDT at most this often. */
const TEXT_WRITE_MS = 150;

export interface TextBuffer {
  /**
   * An editor has opened on `id`, seeded with the argument's text as it stands
   * now. That string is the baseline every later change is measured against —
   * without this, reopening an argument a peer rewrote while it was closed
   * would measure your first keystroke against text nobody is looking at.
   */
  beginText: (id: string) => void;
  /** Record the latest text for `id`; it lands in the flow within a tick or two. */
  queueText: (id: string, text: string) => void;
  /** Write any buffered text now, and cancel the pending timer. */
  flushText: () => void;
}

/**
 * The one span in which `before` and `after` differ: everything they share at
 * the front and at the back is left alone.
 *
 * One span rather than a real diff because that is exactly what a person at a
 * keyboard produces between two flushes — a character typed, a word deleted, a
 * selection replaced by a paste. Null when nothing changed.
 */
export function changedSpan(
  before: string,
  after: string,
): { at: number; remove: number; insert: string } | null {
  if (before === after) return null;
  const shorter = Math.min(before.length, after.length);
  let at = 0;
  while (at < shorter && before[at] === after[at]) at++;
  // The shared tail, without running back past the start of the change on
  // either side — "aa" → "aaa" shares two characters at each end and has only
  // three to give.
  let tail = 0;
  while (
    tail < shorter - at &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) {
    tail++;
  }
  return {
    at,
    remove: before.length - at - tail,
    insert: after.slice(at, after.length - tail),
  };
}

export function useTextBuffer(flow: Flow | null): TextBuffer {
  const pending = useRef<{ id: string; text: string } | null>(null);
  const timer = useRef<number | null>(null);
  /**
   * The last text this buffer wrote for an argument — what the next change is
   * measured against. Not the document's text: the document may have moved
   * underneath us, and the point is to work out what *this* user did.
   */
  const written = useRef(new Map<string, string>());

  const flushText = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const p = pending.current;
    pending.current = null;
    if (!p || !flow?.has(p.id)) return;

    // No baseline yet — the argument was just opened, so the document's own
    // text is what the editor was seeded with and is the right thing to
    // measure against.
    const before = written.current.get(p.id) ?? flow.textOf(p.id);
    const span = changedSpan(before, p.text);
    if (span) flow.spliceText(p.id, span.at, span.remove, span.insert);
    written.current.set(p.id, p.text);
  }, [flow]);

  const beginText = useCallback(
    (id: string) => {
      // Only ever one argument is open, so the map is emptied rather than
      // grown: a baseline for an argument nobody is inside is a baseline that
      // can only go stale.
      written.current.clear();
      if (flow?.has(id)) written.current.set(id, flow.textOf(id));
    },
    [flow],
  );

  const queueText = useCallback(
    (id: string, text: string) => {
      pending.current = { id, text };
      if (timer.current !== null) return;
      timer.current = window.setTimeout(() => {
        timer.current = null;
        flushText();
      }, TEXT_WRITE_MS);
    },
    [flushText],
  );

  // Don't lose a buffered edit if the app unmounts mid-typing.
  useEffect(() => flushText, [flushText]);

  return { beginText, queueText, flushText };
}
