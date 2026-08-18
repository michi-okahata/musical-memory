import { type Mark, type Speech } from "../model/types";
import { type Anchor } from "../model/flow";
import { markerOf } from "../layout/grid";
import { decodeAnswer, encodeAnswer } from "../memory/answer";
import {
  columnOrder,
  moveCursor,
  moveToColumn,
  selectionRange,
  type Motion,
} from "../layout/navigate";
import {
  openSheet,
  followFocus,
  releaseSelection,
  type Command,
  type CommandContext,
  type EditorState,
} from "./state";

/**
 * Vim-style editing on top of a `Flow`.
 *
 * Every key is one `Command`: a function from the current editor state to the
 * next one (see state.ts for what that state is). Commands may mutate the flow
 * (that's the point), but the state transition itself is pure, so the whole
 * keymap is testable without a DOM — build a `Flow`, lay it out, and assert on
 * the state a command returns.
 */

/**
 * The speech the pending count names, counting from 1 the way the column
 * headers read. Null when no count is pending or it names no real speech, so
 * every caller falls back to its own default rather than to the 1AC.
 */
function counted({ state, speeches }: CommandContext): number | null {
  const c = state.count;
  return c !== null && c >= 1 && c <= speeches.length ? c - 1 : null;
}

/** Spatial cursor movement. Never mutates the flow. */
const motion =
  (m: Motion): Command =>
  ({ state, placed }) => ({
    ...state,
    cursorId: moveCursor(placed, state.cursorId, m, state.count ?? 1),
  });

/**
 * Open the command line. It takes a speech by name — `:2ac` — which is the one
 * thing you want to say to a flow that isn't a single keystroke, and reads as
 * what it is at the cost of one extra character over a positional count.
 */
const openCommand: Command = ({ state }) => ({ ...state, command: "" });

/**
 * What the command line can say that isn't the name of a speech: everything to
 * do with the room, which is everything that has an effect outside the editor's
 * own state.
 *
 * They are parsed here and run by the caller, rather than by a `Command` like
 * every other key, precisely because of that. A `Command` is a pure transition
 * from one editor state to the next — that is what makes the keymap testable
 * without a DOM — and opening a socket is neither pure nor a transition. So the
 * command line asks this what was typed, and App does it.
 */
export type SessionCommand =
  | { kind: "share" }
  | { kind: "host" }
  | { kind: "join"; invitation: string }
  | { kind: "relay"; host: string }
  | { kind: "leave" }
  | { kind: "name"; name: string }
  /** A new sheet. Untitled is allowed — you can name it once you know. */
  | { kind: "new"; title: string }
  | { kind: "rename"; title: string }
  | { kind: "sheet"; name: string }
  | { kind: "delete" }
  /** Open a folder of sheets, in place of the round on screen. */
  | { kind: "open" }
  /** Write the round out — asking where, the first time. */
  | { kind: "save" }
  /** Read a folder of CardMirror files in as blocks. */
  | { kind: "import" }
  /** Drop everything a folder of files put there. */
  | { kind: "forget" }
  /** Write `~/.flow/config.json` out with the defaults in it, if there is none. */
  | { kind: "config" };

/**
 * Read a session command, or null if the line says something else (a speech
 * name, most likely).
 *
 * Nothing here validates an address or a room code. What is well-formed is one
 * question and what actually answers is another — only the relay can settle the
 * second — so the whole of it is decided in one place, and this only has to
 * work out which command was meant.
 */
export function parseSessionCommand(text: string): SessionCommand | null {
  const [word, ...rest] = text.trim().split(/\s+/);
  const argument = rest.join(" ").trim();
  switch (word.toLowerCase()) {
    // Host a relay here and open a room on it — no server anywhere else.
    case "host":
      return { kind: "host" };
    // Open a room on whichever relay this app is pointed at.
    case "share":
      return { kind: "share" };
    // The whole invitation, as read out: `k7fmqp` or `192.168.1.42/k7fmqp`.
    case "join":
      return argument ? { kind: "join", invitation: argument } : null;
    // Point at somebody else's relay without joining a room yet. Bare `:relay`
    // goes back to the default, which is the way out of a wrong address.
    case "relay":
      return { kind: "relay", host: argument };
    case "solo":
    case "leave":
      return { kind: "leave" };
    case "name":
      return argument ? { kind: "name", name: argument } : null;

    // ---- sheets. `:new politics` is how a position gets started mid-speech,
    // which is the moment it has to be one line and no dialog.
    case "new":
      return { kind: "new", title: argument };
    case "rename":
      return argument ? { kind: "rename", title: argument } : null;
    // By name, the same way `:2ac` names a speech — a round has few enough
    // sheets that a prefix is unambiguous, and it saves counting brackets.
    case "sheet":
      return argument ? { kind: "sheet", name: argument } : null;
    case "delete":
      return { kind: "delete" };

    // ---- the round on disk. A folder of sheets, opened and written whole —
    // there is no "save this sheet", because a round is the unit you keep.
    case "open":
      return { kind: "open" };
    case "save":
      return { kind: "save" };

    // ---- what you carry between rounds. A folder of cut cards is already a
    // folder of blocks (see memory/cmir.ts), so this is the same gesture as
    // `:open` pointed at the other kind of file — and `:forget` is the way back
    // out of one, which a command that reads thousands of blocks in needs.
    case "import":
      return { kind: "import" };
    case "forget":
      return { kind: "forget" };

    // ---- the keys. A file you edit by hand needs a file to edit, and this
    // writes one — the defaults, spelled out, as a starting point. Typed
    // rather than automatic: see `defaultConfigText`.
    case "config":
      return { kind: "config" };

    default:
      return null;
  }
}

/**
 * Which sheet `text` names. Case-insensitive, and a prefix is enough — `:sheet
 * pol` finds the politics DA — on the same terms as `resolveSpeech` below,
 * because they are the same gesture applied to the other axis of the round.
 */
export function resolveSheet(
  text: string,
  sheets: { id: string; title: string }[],
): string | null {
  const want = text.trim().toLowerCase();
  if (!want) return null;
  const titles = sheets.map((sheet) => sheet.title.toLowerCase());
  const exact = titles.indexOf(want);
  if (exact >= 0) return sheets[exact].id;
  const prefix = titles.findIndex((title) => title.startsWith(want));
  if (prefix >= 0) return sheets[prefix].id;
  // Failing both, anything that contains it — a sheet called "Politics DA —
  // Midterms" should answer to "midterms".
  const anywhere = titles.findIndex((title) => title.includes(want));
  return anywhere >= 0 ? sheets[anywhere].id : null;
}

/**
 * Which speech `text` names. Case-insensitive, and a prefix is enough — `:blo`
 * finds the Block. An exact name always wins over a prefix, so a speech whose
 * name is the start of another's can still be named exactly; failing that the
 * first match in speech order wins, which makes `:2` mean the 2AC rather than
 * nothing.
 */
export function resolveSpeech(text: string, speeches: Speech[]): number | null {
  const want = text.trim().toLowerCase();
  if (!want) return null;
  const labels = speeches.map((s) => s.label.toLowerCase());
  const exact = labels.indexOf(want);
  if (exact >= 0) return exact;
  const prefix = labels.findIndex((l) => l.startsWith(want));
  return prefix >= 0 ? prefix : null;
}

/**
 * Run whatever is typed and close the command line. An unrecognised speech
 * just closes it — there is nowhere sensible to go, and guessing would be
 * worse than doing nothing.
 */
export function submitCommand(ctx: CommandContext): EditorState {
  const { state, placed, speeches, flow } = ctx;
  const closed = { ...state, command: null };
  // The keymap, on `:?`. Handled here rather than as a `SessionCommand` in App
  // because it is exactly what a `Command` is — a pure transition from one
  // editor state to the next — and nothing outside the editor happens.
  const typed = (state.command ?? "").trim().toLowerCase();
  if (typed === "?" || typed === "help") return { ...closed, help: true };
  const col = resolveSpeech(state.command ?? "", speeches);
  if (col === null) return closed;
  return followFocus(
    { ...closed, cursorId: moveToColumn(placed, state.cursorId, col) },
    flow,
  );
}

/** Abandon the command line, leaving the cursor alone. */
export function cancelCommand(state: EditorState): EditorState {
  return { ...state, command: null };
}

/** Type into the open command line. */
export function typeCommand(state: EditorState, text: string): EditorState {
  return { ...state, command: text };
}

const edit: Command = ({ state }) =>
  state.cursorId ? { ...state, editingId: state.cursorId } : state;

/** Every creating command lands the cursor on the new argument and opens it. */
const editing = (state: EditorState, id: string): EditorState => ({
  ...state,
  cursorId: id,
  editingId: id,
  count: null,
});

const respond: Command = (ctx) => {
  const { state, flow, speeches } = ctx;
  if (!state.cursorId) return state;
  const speech = counted(ctx) ?? flow.speechOf(state.cursorId) + 1;
  if (speech >= speeches.length) return state; // nothing past the last speech
  return editing(state, flow.addResponse(state.cursorId, "", speech));
};

/**
 * The argument after the cursor's parent: its next sibling in the same speech,
 * failing that whatever comes next down the parent's column.
 *
 * The column second because a column holds a forest rather than one list (see
 * `markIndices` in grid.ts) — the argument below the last of a run is usually
 * another tree's, and it is still the next thing there is to answer. The
 * sibling first because the two only disagree where an answer written into its
 * parent's own speech (`4a`) has landed between two siblings, and there the run
 * you are working down is the one to follow, not whatever the rows put next.
 *
 * Null when the cursor's argument answers nothing — a root has no run to
 * continue — or when its parent is the last thing in its column.
 */
function nextAlong({ state, flow, placed }: CommandContext): string | null {
  const parent = state.cursorId ? flow.parentOf(state.cursorId) : null;
  if (!parent) return null;

  const speech = flow.speechOf(parent);
  const siblings = flow
    .childrenOf(flow.parentOf(parent))
    .filter((id) => flow.speechOf(id) === speech);
  const among = siblings.indexOf(parent);
  if (among >= 0 && siblings[among + 1]) return siblings[among + 1];

  const at = placed.find((p) => p.id === parent);
  if (!at) return null;
  const column = columnOrder(placed, at.col);
  const below = column.findIndex((p) => p.id === parent);
  return below < 0 ? null : (column[below + 1]?.id ?? null);
}

/**
 * Answer the next argument along — the one after the cursor's parent — with
 * the answer landing in the cursor's own speech.
 *
 * `a` starts an exchange and this is how you work down one. Having answered
 * the 1NC's first argument you are standing on your own answer, a column to
 * the right of what you were reading, and what you do next is nearly always
 * answer the argument below it — which `a` cannot say, since `a` answers
 * whatever the cursor is *on*. Otherwise that is `h`, `j`, `a`, three keys to
 * carry on doing the one thing the speech consists of.
 *
 * Nothing past the bottom of that column: there is nothing left to answer
 * there, and starting an argument of your own is `n`.
 */
const answerNext: Command = (ctx) => {
  const { state, flow, speeches } = ctx;
  if (!state.cursorId || !flow.has(state.cursorId)) return state;
  const next = nextAlong(ctx);
  if (!next) return state;
  // The cursor's own speech, not the parent's next: you are already writing in
  // the column this belongs in. A count still names one outright, as everywhere.
  const speech = counted(ctx) ?? flow.speechOf(state.cursorId);
  if (speech >= speeches.length) return state;
  return editing(state, flow.addResponse(next, "", speech));
};

/**
 * Another argument alongside the cursor's — helix's `o` / `O`, opening below
 * or above. Same parent, so on a root this makes another root.
 */
const sibling =
  (where: "after" | "before"): Command =>
  (ctx) => {
    const { state, flow } = ctx;
    if (!state.cursorId) return state;
    const speech = counted(ctx) ?? flow.speechOf(state.cursorId);
    const anchor =
      where === "after" ? { after: state.cursorId } : { before: state.cursorId };
    return editing(state, flow.add(anchor, { text: "", speech }));
  };

/**
 * A fresh argument tree, clear of the one the cursor is inside — below it, or
 * above it for an overview.
 */
const newRoot =
  (where: "after" | "before"): Command =>
  (ctx) => {
    const { state, flow } = ctx;
    const speech =
      counted(ctx) ?? (state.cursorId ? flow.speechOf(state.cursorId) : 0);
    return editing(state, flow.addRoot(state.cursorId, "", speech, where));
  };

/**
 * The order `#` walks the marks in, and the whole of the design.
 *
 * The mark is not chosen at creation. A new argument takes the mark of
 * whichever same-speech neighbour it lands next to (see `Flow.add`) — the
 * second answer to an argument is marked like the first — and `#` re-marks it
 * when that's wrong. One key rather than three marks apiece across five
 * creating keys, and it asks about the argument rather than about the list.
 *
 * It re-marks whatever `v` has selected. There is no group to imply: a mark is
 * a per-argument fact and a column can hold several independent runs (see
 * `markIndices` in grid.ts).
 */
const MARKS: Mark[] = ["num", "alpha", "none"];

/**
 * The arguments a command that reads "the selection" should act on: the
 * visual range if one is open, else just the cursor's own argument. Never
 * empty when there's a cursor — the fallback is what lets `#` and `x` work
 * exactly as before `v` existed, for anyone who never presses it.
 */
function selectedIds({ state, placed }: CommandContext): string[] {
  if (!state.cursorId) return [];
  const range = selectionRange(placed, state.selectAnchor, state.cursorId);
  return range.length ? range.map((p) => p.id) : [state.cursorId];
}

/**
 * Re-mark the selection: 1. → a. → nothing → 1. for every argument in it, in
 * one commit — so a multi-argument `#` is one undo step, not one per
 * argument.
 *
 * Cycling rather than three keys because there are three states and a glance
 * at the sheet says which one a run is in. The "next" value comes from the
 * cursor's own argument, not the selection's first — pressing `#` always
 * means "away from what the cursor is currently marked", whichever end of the
 * range the cursor happens to be at.
 */
const cycleMark: Command = (ctx) => {
  const { state, flow } = ctx;
  if (!state.cursorId || !flow.has(state.cursorId)) return state;
  const at = MARKS.indexOf(flow.markOf(state.cursorId));
  flow.setMarks(selectedIds(ctx), MARKS[(at + 1) % MARKS.length]);
  return { ...state, count: null };
};

/**
 * Say whether the argument was read off evidence or simply spoken — see
 * `Support`.
 *
 * A toggle rather than a cycle because there are two states, and it reads off
 * the cursor's own argument for the same reason `#` does: `c` means "away from
 * what the cursor currently is", so a selection ends up uniform whichever end
 * of it you pressed from. Which is the point of applying it to a run at all —
 * a block is a block, and saying so once beats saying it six times.
 */
const toggleSupport: Command = (ctx) => {
  const { state, flow } = ctx;
  if (!state.cursorId || !flow.has(state.cursorId)) return state;
  const next = flow.supportOf(state.cursorId) === "card" ? "analytic" : "card";
  flow.setSupports(selectedIds(ctx), next);
  return { ...state, count: null };
};

/**
 * Memorize the answers to the cursor's argument — every response already
 * written under it, in order, kept in `~/.flow` against the argument itself
 * (see memory/store.ts). ⌘P puts them back the next time it comes up.
 *
 * What is memorized is what is on the sheet rather than something typed into a
 * separate list — a block file you maintain elsewhere is one that goes stale.
 * Which means the same key revises and forgets without being a mode: `m` makes
 * the store agree with the sheet, whatever it currently says.
 *
 * The cursor's argument only, not the selection: a block belongs to the one
 * argument it answers.
 */
const memorize: Command = ({ state, flow, memory, sheets, placed }) => {
  if (state.memory) return state; // already looking at the store
  if (!state.cursorId || !flow.has(state.cursorId)) return state;
  // Each answer is written with the marker the sheet is drawing beside it (see
  // memory/answer.ts). Off `placed` rather than recomputed, because the number
  // that goes into the block should be the one you were looking at when you
  // pressed `m` — this is the one caller that already has the layout in hand.
  const answers = flow
    .childrenOf(state.cursorId)
    // Before the marker goes on, not after: `o` makes an argument before you
    // have typed into it, and an answer that is still empty used to drop out
    // here on its own. Marked first, it would be stored as a bare "1.".
    .filter((id) => flow.textOf(id).trim())
    .map((id) => {
      const index = placed.find((p) => p.id === id)?.index ?? null;
      return encodeAnswer(markerOf(index, flow.markOf(id)), flow.textOf(id));
    });
  memory.keep(positionOf(sheets), flow.textOf(state.cursorId), answers);
  return { ...state, count: null };
};

/**
 * The position a block memorized here belongs to: the name of the sheet it is
 * being flowed on. Free — you have already named the sheet "Assurance DA", and
 * a block is only ever memorized while you are standing on one.
 */
function positionOf({ list, active }: CommandContext["sheets"]): string {
  return list.find((sheet) => sheet.id === active)?.title ?? "";
}

/**
 * Show what you have memorized, or go back to the round.
 *
 * Not an overlay and not a sheet in the round: the same window with a different
 * document under it, which is why there is no keymap for it. A block is an
 * argument with answers under it, so `i`, `a`, `o`, `x`, `#`, `J`/`K` and `u`
 * already mean the right things (see useMemoryRound.ts).
 *
 * The cursor is put down rather than carried across — the two documents share
 * no arguments — and picked back up on the way home.
 */
const toggleMemory: Command = ({ state, sheets }) => ({
  ...state,
  memory: !state.memory,
  cursors: sheets.active
    ? { ...state.cursors, [sheets.active]: state.cursorId }
    : state.cursors,
  cursorId: null,
  editingId: null,
  count: null,
  selectAnchor: null,
  focus: null,
});

/**
 * Insert the answers to the cursor's argument, as responses in the next speech
 * — ⌘P, and the only key that also works while you are typing.
 *
 * Which is why it is on the platform chord rather than a letter: the moment you
 * want your block is *while* you are still writing down the argument it answers
 * and they are already a sentence ahead of you. What you have typed is written
 * through to the flow first, so the lookup is against the argument as it now
 * reads (see useKeymap), and the answers land under it without the editor
 * closing. A letter could only be reached after `Esc`.
 *
 * `a` and this are the same gesture at two speeds: one empty answer to write
 * yourself, or every answer you already know you make. Which is why the cursor
 * lands on the first of them and the editor stays shut — the text is there, and
 * what you do next is read it. `4⌘P` names a speech further out, the same way
 * `a` takes a count, outside the editor where digits are digits and not text.
 *
 * The block is whichever answers it, memorized or imported; where it came from
 * makes no difference here. What it cannot be is a guess between several files
 * — `recall` returns nothing at all in that case. One commit for the lot.
 */
const recall: Command = (ctx) => {
  const { state, flow, speeches, memory, sheets } = ctx;
  if (!state.cursorId || !flow.has(state.cursorId)) return state;
  const { block } = memory.recall(flow.textOf(state.cursorId), positionOf(sheets));
  if (!block || block.answers.length === 0) return state;

  const speech = counted(ctx) ?? flow.speechOf(state.cursorId) + 1;
  if (speech >= speeches.length) return state; // nothing past the last speech

  const parent = state.cursorId;
  let first: string | null = null;
  flow.batch(() => {
    for (const line of block.answers) {
      // Marked as the block says, not as the neighbouring column says: a block
      // is a list you wrote down once, and landing it beside a lettered aside
      // shouldn't quietly re-letter it. What the markers count *to* is still
      // the landing sheet's — see memory/answer.ts.
      const { mark, text } = decodeAnswer(line);
      const id = flow.add({ under: parent }, { text, speech, mark });
      first ??= id;
    }
  });
  // Except mid-sentence, where the cursor is what the open editor is on: moving
  // it to the answers would leave the two pointing at different arguments, and
  // you are not finished with this one — that is why you are still typing it.
  if (state.editingId) return { ...state, count: null };
  return { ...state, cursorId: first ?? state.cursorId, count: null };
};

/**
 * Enter or leave visual selection: `v` anchors it at the cursor; `v` again
 * (or anything that isn't a selection-aware command — see `KEEPS_SELECTION`) drops
 * it. With no cursor there is nothing to anchor to.
 */
const toggleSelect: Command = ({ state }) => {
  if (state.selectAnchor !== null) return { ...state, selectAnchor: null };
  return state.cursorId ? { ...state, selectAnchor: state.cursorId } : state;
};

/**
 * The selection with anything already inside it dropped — the arguments a copy
 * should actually be taken of.
 *
 * A selection ranges over a *column*, and an argument's responses are usually
 * in the next one, so this is normally the selection unchanged. Usually, not
 * always: `4a` can answer an argument in its own speech, and then a parent and
 * its child can both be selected. Copying an argument copies what responds to
 * it, so taking both would put the child in twice.
 */
function outermost({ flow }: CommandContext, ids: string[]): string[] {
  const selected = new Set(ids);
  return ids.filter((id) => {
    for (let at = flow.parentOf(id); at; at = flow.parentOf(at)) {
      if (selected.has(at)) return false;
    }
    return true;
  });
}

/**
 * Copy the selection — each argument and everything responding to it — for `p`
 * to put back.
 *
 * The unit is the argument *and its subtree*, the same unit `x` deletes, and
 * for the same reason: on a flow an argument is not a line, it is a line and
 * the exchange hanging off it. Copying "1. perm do both" without the two
 * answers under it would be copying half of what is on the sheet there. A leaf
 * is its own subtree, so the narrow case costs nothing.
 *
 * Nothing is written to the document — this is the one command that touches the
 * flow and leaves it exactly as it was.
 */
const yank: Command = (ctx) => {
  const { state, flow } = ctx;
  const ids = outermost(ctx, selectedIds(ctx)).filter((id) => flow.has(id));
  if (ids.length === 0) return state;
  return { ...state, yanked: ids.map((id) => flow.copy(id)), count: null };
};

/**
 * Put the copy back: below the cursor's argument, or above it for `P` — the
 * same two directions, and the same pair of keys, that `o` and `O` already
 * mean. A count names the speech, as it does everywhere else: `3p` puts the
 * copy in the 3rd speech rather than the cursor's own.
 *
 * A sibling rather than a response: "put this here" is about where on the sheet
 * it goes, not what it answers. Answering is `a`, and the two compose.
 *
 * With no cursor — an empty sheet, the point of `:new` then `p` — it goes in as
 * a fresh tree at the end, in the speech it was copied *from*. One commit for
 * the lot, so four arguments are one undo; the cursor lands on the first and
 * the editor stays shut. A copy put down too late in the round for its
 * responses arrives without them (see `Flow.paste`).
 */
const put =
  (where: "after" | "before"): Command =>
  (ctx) => {
    const { state, flow, speeches } = ctx;
    const yanked = state.yanked;
    if (!yanked || yanked.length === 0) return state;

    const on = state.cursorId && flow.has(state.cursorId) ? state.cursorId : null;
    const last = speeches.length - 1;
    // Clamped for the one default that can name a column this sheet hasn't
    // got: the copy's own, which was a column on the sheet it came off. A
    // count is already checked against the speeches (see `counted`), and the
    // cursor is by definition standing in one.
    const wanted = counted(ctx) ?? (on ? flow.speechOf(on) : yanked[0].speech);
    const speech = Math.min(wanted, last);
    let anchor: Anchor = on
      ? where === "after"
        ? { after: on }
        : { before: on }
      : { root: null, before: where === "before" };

    let first: string | null = null;
    flow.batch(() => {
      for (const copied of yanked) {
        const id = flow.paste(anchor, copied, speech, last);
        first ??= id;
        // The rest chain off the one before, so several copied arguments keep
        // their order. Anchoring each of them at the cursor instead would put
        // them back in reverse.
        anchor = { after: id };
      }
    });
    return { ...state, cursorId: first ?? state.cursorId, count: null };
  };

/**
 * Delete every selected argument, and everything responding to each — one
 * commit, so a multi-argument `x` is one undo step. Lands on the parent of
 * the first selected argument, the same rule single-argument delete already
 * used.
 *
 * What was deleted is kept, exactly as `y` would have kept it, so `x` … `p` is
 * how an argument *moves* — including onto another sheet, which nothing else
 * can do: a flow's structural moves (`J`/`K`) only reorder siblings, and there
 * is no gesture for "this belongs on the counterplan, not the case". It is also
 * what vim does with its unnamed register, and the cost is the same one vim
 * has: an `x` between a copy and its `p` replaces the copy.
 */
const remove: Command = (ctx) => {
  const { state, flow } = ctx;
  if (!state.cursorId) return state;
  const ids = selectedIds(ctx);
  const parent = flow.parentOf(ids[0]);
  // Before the deletion, plainly: there is nothing to read afterwards.
  const yanked = outermost(ctx, ids).map((id) => flow.copy(id));
  flow.batch(() => {
    for (const id of ids) {
      // A selected descendant of another selected argument is already gone by
      // the time its own turn comes — deleting an argument takes its subtree
      // with it.
      if (flow.has(id)) flow.remove(id);
    }
  });
  return {
    ...state,
    yanked,
    cursorId: parent,
    editingId: null,
    count: null,
    selectAnchor: null,
  };
};

/**
 * Shift the whole selection one slot earlier ("up") or later ("down") among
 * its own siblings — arguments actually sharing a parent and a speech, not
 * merely a column. A selection that crosses parents is exactly the "forest" a
 * column can hold (see `markIndices`), and "move it up a slot" has no one
 * meaning for arguments that aren't siblings of each other — so this does
 * nothing there rather than guess. Reparenting a selection is a different
 * feature.
 *
 * Implemented by moving the *neighbour* past the block instead of moving the
 * block: `Flow.move`'s index is a position in the parent's full child list —
 * every speech mixed together — so hopping one argument over it is one
 * `move` call regardless of how many arguments the selection covers, where
 * relocating each selected argument individually would have to renumber the
 * others out from under it as it went.
 */
const moveSelection =
  (dir: "up" | "down"): Command =>
  (ctx) => {
    const { state, flow } = ctx;
    const ids = selectedIds(ctx);
    if (ids.length === 0) return state;

    const parent = flow.parentOf(ids[0]);
    if (ids.some((id) => flow.parentOf(id) !== parent)) return state;

    const speech = flow.speechOf(ids[0]);
    const siblings = flow.childrenOf(parent);
    const firstAt = siblings.indexOf(ids[0]);
    const lastAt = siblings.indexOf(ids[ids.length - 1]);

    if (dir === "up") {
      let prevAt = -1;
      for (let i = firstAt - 1; i >= 0; i--) {
        if (flow.speechOf(siblings[i]) === speech) {
          prevAt = i;
          break;
        }
      }
      if (prevAt < 0) return state; // already first among its speech
      // `prevAt` is removed from ahead of the block, so every later position
      // — `lastAt` included — shifts back by one before the reinsertion is
      // read; naming `lastAt` puts it exactly one slot past where the block
      // now sits, i.e. immediately after it.
      flow.move(siblings[prevAt], parent ?? undefined, lastAt);
    } else {
      let nextAt = -1;
      for (let i = lastAt + 1; i < siblings.length; i++) {
        if (flow.speechOf(siblings[i]) === speech) {
          nextAt = i;
          break;
        }
      }
      if (nextAt < 0) return state; // already last among its speech
      // `nextAt` is removed from behind the block, so positions at or before
      // `firstAt` are undisturbed — naming `firstAt` puts it immediately
      // before the block, i.e. one slot later than where it started.
      flow.move(siblings[nextAt], parent ?? undefined, firstAt);
    }
    return { ...state, count: null };
  };

/**
 * Undo / redo, landing the cursor where the change was made rather than
 * wherever it happens to be now — undoing a delete puts you back on the
 * argument that came back, not on its parent.
 */
const history =
  (direction: "undo" | "redo"): Command =>
  ({ state, round, sheets }) => {
    const at = direction === "undo" ? round.undo() : round.redo();
    if (at === undefined) return state; // nothing on that stack
    if (!at) return { ...state, editingId: null, count: null };

    // The change may have been made on a sheet you have since left — `u` means
    // "take back the last thing I did", and the last thing you did is not
    // always on the position you happen to be reading now. So undo carries you
    // to it, which is also the only way to see what it undid.
    let next = state;
    if (at.sheet !== sheets.active) {
      sheets.open(at.sheet);
      next = openSheet(next, sheets.active, at.sheet);
    }
    return {
      ...next,
      cursorId: at.id ?? next.cursorId,
      editingId: null,
      count: null,
    };
  };

/**
 * Pin the sheet to the speech the cursor is in — collapsing everything but it
 * and its two neighbours — or unpin it. With no cursor there is nothing to pin
 * to, so nothing happens.
 */
const toggleFocus: Command = ({ state, flow }) => {
  if (state.focus !== null) return { ...state, focus: null };
  if (!state.cursorId || !flow.has(state.cursorId)) return state;
  return { ...state, focus: flow.speechOf(state.cursorId) };
};

/**
 * The range the sheet may be drawn over. The floor is where the type stops
 * being text and becomes the shape of the round — past it you want focus mode,
 * not a smaller font. The ceiling is roughly a printed sheet held at arm's
 * length, which is as far as reading a flow ever needs to go.
 */
export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 2.5;

/** One press of `+` or `-`. Geometric, so a step means the same at either end. */
const ZOOM_STEP = 1.15;

/** Scale the sheet by `factor`, clamped. */
function scaleZoom(state: EditorState, factor: number): EditorState {
  const zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, state.zoom * factor));
  return { ...state, zoom };
}

const zoomBy =
  (factor: number): Command =>
  ({ state }) =>
    scaleZoom(state, factor);

/** Back to the authored size — the one place the clamped scale is exact. */
const resetZoom: Command = ({ state }) => ({ ...state, zoom: 1 });

/**
 * Move to the sheet `delta` along — the next position, or the previous one.
 *
 * Clamps rather than wraps, the same way `j` stops at the bottom of a column:
 * the sheets are an ordered stack, and running off the end of it to arrive back
 * at the case is disorienting in exactly the moment you can least afford it.
 */
const goToSheet =
  (delta: number): Command =>
  ({ state, sheets }) => {
    const at = sheets.list.findIndex((sheet) => sheet.id === sheets.active);
    if (at < 0) return state;
    const next = sheets.list[at + delta];
    if (!next) return state;
    sheets.open(next.id);
    return openSheet(state, sheets.active, next.id);
  };

/**
 * Shift the open sheet up or down the list — the same move a row dragged in
 * the sidebar makes, and the reason both go through `SheetControls.move`
 * rather than the round directly.
 */
const shiftSheet =
  (delta: number): Command =>
  ({ state, sheets }) => {
    if (sheets.active) sheets.move(sheets.active, delta);
    return state;
  };

/**
 * Show or hide the list of sheets. On the platform chord, not a bare key — a
 * one-sheet round (a practice speech, a rebuttal drill) has nothing to list
 * and the width is better spent on the flow, but that's a rare enough reach
 * that it doesn't need a letter of its own, and Cmd+B is where every other
 * editor already keeps it.
 */
const toggleSidebar: Command = ({ state }) => ({ ...state, sidebar: !state.sidebar });

/**
 * Build up the pending count. A leading `0` is ignored rather than starting
 * one, leaving the key free to mean something later.
 */
const digit =
  (d: number): Command =>
  ({ state }) =>
    state.count === null && d === 0
      ? state
      : { ...state, count: (state.count ?? 0) * 10 + d };

const DIGITS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

/**
 * The digits, as ten commands — `digit3` and the rest.
 *
 * They are in the registry like everything else so that a config can move
 * them (a numeric keypad, a layout where the digits are shifted), and named
 * rather than special-cased so that `run` can ask what a key *did* rather
 * than what it was: only these ten leave a count standing, and after a remap
 * the character on the key no longer says which ten they are.
 */
const digits = Object.fromEntries(DIGITS.map((d) => [`digit${d}`, digit(d)]));

/** Their names, for the one rule that has to know them. */
const COUNTING = new Set(DIGITS.map((d) => `digit${d}`));

/**
 * The keymap's lookup key for an event. Shift is already baked into `key`
 * (`O` vs `o`), so only Ctrl and Meta are encoded.
 */
export function keyOf(e: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
}): string {
  return `${e.ctrlKey ? "C-" : ""}${e.metaKey ? "M-" : ""}${e.key}`;
}

/**
 * Everything a key can be made to do, by name.
 *
 * The names are the other half of the keymap and are why this is a registry
 * rather than the key-to-function table it used to be: a key is a *preference*
 * — a US bracket, a hand that learned Colemak, a left-hander who wants the
 * creating keys somewhere else — and what an editor can do is not. So the two
 * are separated, the names are the stable thing, and `~/.flow/config.json`
 * binds them (see config.ts).
 *
 * They are what somebody writes in that file, so they are named for what they
 * do to a flow rather than for how they are implemented: `answer`, not
 * `addChildInNextSpeech`.
 */
export const commands: Record<string, Command> = {
  ...digits,
  left: motion("h"),
  down: motion("j"),
  up: motion("k"),
  right: motion("l"),
  commandLine: openCommand, // :2ac — jump to a speech by name
  edit,
  answer: respond, // a child, next speech column
  answerNext, // …and on to the next argument down the column you're answering
  recall, // every answer you have memorized to this one, as a block
  memorize, // memorize the answers under the cursor, as the block for it
  memorySheet: toggleMemory, // …and everything you have memorized, as a flow of its own
  addBelow: sibling("after"), // another argument below…
  addAbove: sibling("before"), // …and above
  newBelow: newRoot("after"), // a new argument tree, clear of this one
  newAbove: newRoot("before"), // …above it: the overview case
  focus: toggleFocus, // narrow the speeches you aren't in
  select: toggleSelect, // select a run in this column — mark / delete / copy act on it
  copy: yank, // …and everything answering it
  putBelow: put("after"), // put the copy below the cursor, or `3p` in the 3rd speech
  putAbove: put("before"), // …above it
  nextSheet: goToSheet(1),
  prevSheet: goToSheet(-1),
  sheetDown: shiftSheet(1), // the sheet itself moves down the list…
  sheetUp: shiftSheet(-1), // …or up it
  sidebar: toggleSidebar, // show or hide the list of sheets
  mark: cycleMark, // how the selection is marked off: 1. / a. / nothing
  support: toggleSupport, // was it a card, or did they just say it
  shiftDown: moveSelection("down"), // shift the selection past its next sibling…
  shiftUp: moveSelection("up"), // …or its previous one
  zoomIn: zoomBy(ZOOM_STEP),
  zoomOut: zoomBy(1 / ZOOM_STEP),
  zoomReset: resetZoom, // "actual size", where every other desktop app keeps it
  delete: remove,
  undo: history("undo"),
  redo: history("redo"),
  cancel: ({ state }) => state, // just drops the pending count, below
};

/**
 * The keys as they come out of the box.
 *
 * `a` is the one that means something different here than in vim: an *answer*,
 * the core move in flowing a round. Editing keeps `i` — "insert" would be
 * ambiguous as a command here anyway (insert text, or insert an argument?),
 * and a mis-pressed `i` that silently made an argument would swallow the edit
 * you meant to type.
 *
 * Several keys may name one command and nothing stops them: that is what the
 * pairs below are. It reads the way it does — key on the left, command on the
 * right — because that is the question being asked at a keypress, and because
 * it is the shape a config file has to be in to add a key without restating
 * the one it is joining.
 */
export const DEFAULT_KEYS: Record<string, string> = {
  ...Object.fromEntries(DIGITS.map((d) => [String(d), `digit${d}`])),
  h: "left",
  j: "down",
  k: "up",
  l: "right",
  ":": "commandLine",
  i: "edit",
  Enter: "edit",
  a: "answer",
  A: "answerNext",
  "M-p": "recall",
  m: "memorize",
  M: "memorySheet",
  o: "addBelow",
  O: "addAbove",
  n: "newBelow",
  N: "newAbove",
  f: "focus",
  v: "select",
  y: "copy",
  p: "putBelow",
  P: "putAbove",
  // The round's other sheets. Brackets because they are the pair vim already
  // uses for "the next one of these, the previous one", and because the keys
  // that make arguments are all letters — reaching for a bracket is never half
  // of writing something down.
  "]": "nextSheet",
  "[": "prevSheet",
  // And on the platform chord, the sheet itself moves — the same relation ⌘
  // has to the arrow keys everywhere else, and the pair of the brackets above
  // rather than a second gesture to remember.
  "M-]": "sheetDown",
  "M-[": "sheetUp",
  "M-b": "sidebar", // the chord every editor uses for a side panel
  "#": "mark",
  c: "support",
  J: "shiftDown",
  K: "shiftUp",
  // Zoom, on the platform chord — this is a desktop app, and Cmd +/- is where
  // a Mac user's hand already goes. It was on the bare keys because Cmd +/- is
  // the *browser's* zoom and can't be taken off it, but that is only true of
  // the dev preview: the shipped WKWebView binds nothing to it, so the chord
  // is ours. (Run the sheet in a browser and the page zooms under the flow
  // instead — a dev artifact, not the app.)
  //
  // Both faces of each key, since the shift state of `=/+` and `-/_` is not
  // something anyone thinks about while reaching for zoom.
  "M-+": "zoomIn",
  "M-=": "zoomIn",
  "M--": "zoomOut",
  "M-_": "zoomOut",
  "M-0": "zoomReset",
  x: "delete",
  // Undo: vim's u / Ctrl-r, plus the platform chord this is a desktop app on.
  u: "undo",
  "C-r": "redo",
  "M-z": "undo",
  "M-Z": "redo",
  Escape: "cancel",
};

/**
 * The commands that run while an argument is open for editing. Every other key
 * belongs to the textarea, which is the rule that lets `a`, `o` and `x` be
 * letters at all.
 *
 * Only what is worth interrupting a sentence for. Recall is: the answers to
 * what you are typing are wanted while the argument is still being said, and
 * every second the editor is shut is a second of the speech you are not
 * writing down. Zoom and the sidebar can wait for `Esc`.
 *
 * By command and not by key, so that a config which moves recall moves this
 * with it — and so that whatever it is bound to has to be a chord, which is
 * the config's own business to get right: a letter here would simply be a
 * letter you can no longer type.
 *
 * Both ends of the keyboard have to agree about this — the window listener
 * that runs the command (useKeymap) and the textarea that otherwise stops keys
 * reaching it (ArgumentEditor) — so they ask here rather than each keeping
 * their own list.
 */
const WHILE_EDITING = new Set(["recall"]);

export function runsWhileEditing(key: string, keys: Record<string, string>): boolean {
  return WHILE_EDITING.has(keys[key]);
}

/**
 * Commands that read or extend the selection rather than starting fresh from
 * the cursor — `run` leaves `selectAnchor` standing for these and drops it for
 * everything else (see `run`, below). The motions are here even though left
 * and right usually end up dropping the selection anyway (`releaseSelection`
 * catches that once they've actually left the column) — while they haven't,
 * mid-selection movement has to be allowed to run at all.
 *
 * `copy` is deliberately *not* here even though it reads the selection: `run`
 * calls the command before clearing the anchor, so the copy is taken correctly
 * either way, and dropping the selection afterwards is what vim does — the
 * selection was there to say what to copy, and it has said it.
 */
const KEEPS_SELECTION = new Set([
  "left",
  "down",
  "up",
  "right",
  "select",
  "mark",
  "support",
  "delete",
  "shiftDown",
  "shiftUp",
]);

/**
 * Run whatever `key` is bound to in `keys`. Returns null when nothing is — the
 * caller should leave the event alone rather than swallowing it.
 *
 * The bindings are handed in rather than reached for, because they are the
 * user's (see config.ts) and this stays a pure transition from one editor
 * state to the next. `DEFAULT_KEYS` is the default so that a caller with no
 * config — a test, most usefully — can go on asking what `x` does.
 *
 * Clearing the pending count lives here and not in the commands: only the
 * digits build it up, and every other key spends it and is done. The selection
 * is cleared the same way and for the same reason — only the commands that
 * read or extend it (`KEEPS_SELECTION`, plus the digits a count for one of
 * them might need) get to leave it standing; anything else — editing an
 * argument, answering, undo — is a normal-mode action that shouldn't inherit a
 * selection some earlier `select` left lying around.
 */
export function run(
  key: string,
  ctx: CommandContext,
  keys: Record<string, string> = DEFAULT_KEYS,
): EditorState | null {
  // The keymap on screen owns the keyboard. Every key is swallowed rather than
  // run, so that reaching for something while reading the help sheet can't
  // quietly answer an argument on the flow behind it — and `Escape`, or the
  // `?` that opened it, puts it away.
  //
  // Non-null for every key, unlike the fall-through below, which is what makes
  // the caller call `preventDefault` and actually swallow them.
  if (ctx.state.help) {
    // Whatever `cancel` is bound to, plus the two keys that put it away
    // without being commands at all — the `?` that asked for it, and Enter.
    const closes = keys[key] === "cancel" || key === "?" || key === "Enter";
    return closes ? { ...ctx.state, help: false } : ctx.state;
  }
  const name = keys[key];
  const command = name ? commands[name] : undefined;
  if (!command) return null;
  const next = command(ctx);
  const counting = COUNTING.has(name);
  const spent = counting ? next : { ...next, count: null };
  const kept =
    counting || KEEPS_SELECTION.has(name) ? spent : { ...spent, selectAnchor: null };
  return releaseSelection(followFocus(kept, ctx.flow), ctx.placed);
}
