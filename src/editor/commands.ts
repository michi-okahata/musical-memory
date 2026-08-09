import { type Mark, type Speech } from "../model/types";
import { type Anchor } from "../model/flow";
import { moveCursor, moveToColumn, selectionRange, type Motion } from "../layout/navigate";
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
  | { kind: "save" };

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
 * The obvious reading of "a new argument numbered, lettered, or plain" is three
 * more creating keys — but there are five creating keys already (`a`, `o`, `O`,
 * `n`, `N`), and three marks apiece is fifteen bindings for a keymap that fits
 * on the status line today. It also asks the wrong question at the wrong time:
 * you are making an argument, and it wants to know about the *list*.
 *
 * So the mark is not chosen at creation at all. A new argument takes the mark
 * of whichever same-speech neighbour it lands next to (see `Flow.add`), which
 * is right nearly always — the second answer to an argument is marked like
 * the first — and `#` re-marks it when that's wrong: a lettered aside in the
 * middle of a numbered run, an independent point that should carry no mark at
 * all. One key, no mode, and it composes with every way of making an argument
 * rather than doubling each of them. Helix earns its keyboard the same way:
 * operators on a selection, not a verb per noun.
 *
 * That selection is `v`, below — one argument by default, or a run picked out
 * in a column. `#` was originally "re-mark the whole group *for* you", back
 * when a column numbered as a single block; now that a mark is a per-argument
 * fact and a column can hold several independent runs (an implicit forest —
 * see `markIndices` in grid.ts), there is no group to imply, so it
 * re-marks whatever is selected instead.
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
 * (see memory/store.ts). `A` puts them back the next time it comes up.
 *
 * What is memorized is what is on the sheet, not something typed into a
 * separate list: you have just flowed the four answers to neg flex, they are
 * sitting under it in the 2AC column, and the whole gesture is one key that
 * says "these — keep them". A block file you have to maintain somewhere else
 * is a block file that goes stale, and this cannot: the sheet is the only
 * place it can come from.
 *
 * Which means the same key also revises and forgets, without being a mode or a
 * toggle. `m` makes the store agree with the sheet, whatever it currently says
 * — drop an answer you have stopped making and press it again and the block is
 * the three that are left; `x` the answers entirely and press it and the block
 * is gone.
 *
 * The cursor's argument only, not the selection: a block belongs to the one
 * argument it answers, and there is no single argument a range of them is the
 * answers to.
 */
const memorize: Command = ({ state, flow, memory, sheets }) => {
  if (state.memory) return state; // already looking at the store
  if (!state.cursorId || !flow.has(state.cursorId)) return state;
  const answers = flow.childrenOf(state.cursorId).map((id) => flow.textOf(id));
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
 * Not an overlay and not a sheet in the round: the same window, laid out the
 * same way, with a different document under it — your positions down the side
 * and the blocks in each as a two-column flow. Which is why there is no keymap
 * for it. A block is an argument with answers under it, so `i`, `a`, `o`, `x`,
 * `#`, `J`/`K` and `u` already mean the right things, and what they edit is
 * written back to `~/.flow` as you go (see useMemoryRound.ts).
 *
 * The cursor is put down rather than carried across — the two documents share
 * no arguments — and picked back up on the way home, the same way leaving a
 * sheet and coming back to it does.
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
 * Insert the memorized answers to the cursor's argument, as responses in the
 * next speech — `4A` for a speech further out, the same way `a` takes a count.
 *
 * `a` and `A` are the same gesture at two speeds: one empty answer to write
 * yourself, or every answer you already know you make. Which is why this lands
 * the cursor on the first of them and does *not* open the editor — the text is
 * already there, and what you do next is read down the block and add the one
 * thing this round called for.
 *
 * One commit for the lot, so the block is one undo rather than four.
 */
const recall: Command = (ctx) => {
  const { state, flow, speeches, memory, sheets } = ctx;
  if (!state.cursorId || !flow.has(state.cursorId)) return state;
  const block = memory.answersTo(flow.textOf(state.cursorId), positionOf(sheets));
  if (!block || block.answers.length === 0) return state;

  const speech = counted(ctx) ?? flow.speechOf(state.cursorId) + 1;
  if (speech >= speeches.length) return state; // nothing past the last speech

  const parent = state.cursorId;
  let first: string | null = null;
  flow.batch(() => {
    for (const answer of block.answers) {
      const id = flow.addResponse(parent, answer, speech);
      first ??= id;
    }
  });
  return { ...state, cursorId: first ?? state.cursorId, count: null };
};

/**
 * Enter or leave visual selection: `v` anchors it at the cursor; `v` again
 * (or anything that isn't a selection-aware key — see `SELECTION_KEYS`) drops
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
 * A sibling rather than a response, because "put this here" is a statement
 * about where on the sheet it goes, not about what it answers — `p` next to an
 * argument gives you an argument next to it. Answering is `a`, and the two
 * compose: `a` an empty response and `p` into it.
 *
 * With no cursor — an empty sheet, which is the whole point of `:new` then `p`
 * — it goes in as a fresh argument tree at the end of the flow, the way `n`
 * does, and in the speech it was copied *from*: an argument made in the 1NC
 * belongs in the 1NC of whatever position you file it under, and there is no
 * cursor to say otherwise.
 *
 * One commit for the lot, so a copy of four arguments is one undo. The cursor
 * lands on the first of them and the editor stays shut: the text is already
 * there, and what you do next is read it, not type it.
 *
 * A copy put down late enough in the round that its responses have no speech
 * left to go in arrives without them — see `Flow.paste`, which is also what
 * makes a seven-column exchange land readably on the two-column memory sheet.
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

/** Shift the open sheet up or down the list. */
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

const digits = Object.fromEntries(
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => [String(d), digit(d)]),
);

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
 * `a` is the one key that means something different here than in vim: an
 * *answer*, the core move in flowing a round. Editing keeps `i` — "insert"
 * would be ambiguous as a command here anyway (insert text, or insert an
 * argument?), and a mis-pressed `i` that silently made an argument would
 * swallow the edit you meant to type.
 */
export const commands: Record<string, Command> = {
  ...digits,
  h: motion("h"),
  j: motion("j"),
  k: motion("k"),
  l: motion("l"),
  ":": openCommand, // :2ac — jump to a speech by name
  i: edit,
  Enter: edit,
  a: respond, // answer — a child, next speech column
  A: recall, // …or every answer you have memorized to it, as a block
  m: memorize, // memorize the answers under the cursor, as the block for it
  M: toggleMemory, // …and everything you have memorized, as a flow of its own
  o: sibling("after"), // another argument below…
  O: sibling("before"), // …and above
  n: newRoot("after"), // a new argument tree, clear of this one
  N: newRoot("before"), // …above it: the overview case
  f: toggleFocus, // narrow the speeches you aren't in
  v: toggleSelect, // select a run in this column — # / x / y / J / K act on it
  y: yank, // copy it and everything answering it…
  p: put("after"), // …and put it back below the cursor, or `3p` in the 3rd speech
  P: put("before"), // …above it
  // The round's other sheets. Brackets because they are the pair vim already
  // uses for "the next one of these, the previous one", and because the keys
  // that make arguments are all letters — reaching for a bracket is never half
  // of writing something down.
  "]": goToSheet(1),
  "[": goToSheet(-1),
  "}": shiftSheet(1), // and shifted, the sheet itself moves
  "{": shiftSheet(-1),
  "M-b": toggleSidebar, // the list of sheets — Cmd+B, same chord every editor uses for this
  "#": cycleMark, // how the selection is marked off: 1. / a. / nothing
  c: toggleSupport, // was it a card, or did they just say it
  J: moveSelection("down"), // shift the selection past its next sibling…
  K: moveSelection("up"), // …or its previous one
  // Zoom, on the platform chord — this is a desktop app, and Cmd +/- is where
  // a Mac user's hand already goes. It was on the bare keys because Cmd +/- is
  // the *browser's* zoom and can't be taken off it, but that is only true of
  // the dev preview: the shipped WKWebView binds nothing to it, so the chord
  // is ours. (Run the sheet in a browser and the page zooms under the flow
  // instead — a dev artifact, not the app.)
  //
  // Both faces of each key, since the shift state of `=/+` and `-/_` is not
  // something anyone thinks about while reaching for zoom.
  "M-=": zoomBy(ZOOM_STEP),
  "M-+": zoomBy(ZOOM_STEP),
  "M--": zoomBy(1 / ZOOM_STEP),
  "M-_": zoomBy(1 / ZOOM_STEP),
  "M-0": resetZoom, // "actual size", where every other desktop app keeps it
  x: remove,
  // Undo: vim's u / Ctrl-r, plus the platform chord this is a desktop app on.
  u: history("undo"),
  "C-r": history("redo"),
  "M-z": history("undo"),
  "M-Z": history("redo"),
  Escape: ({ state }) => state, // just drops the pending count, below
};

const isDigit = (key: string) => key.length === 1 && key >= "0" && key <= "9";

/**
 * Keys that read or extend the selection rather than starting fresh from the
 * cursor — `run` leaves `selectAnchor` standing for these and drops it for
 * everything else (see `run`, below). `h`/`j`/`k`/`l` are here even though
 * `h`/`l` usually end up dropping the selection anyway (`releaseSelection`
 * catches that once they've actually left the column) — while they haven't,
 * mid-selection movement has to be allowed to run at all.
 *
 * `y` is deliberately *not* here even though it reads the selection: `run`
 * calls the command before clearing the anchor, so the copy is taken correctly
 * either way, and dropping the selection afterwards is what vim does — the
 * selection was there to say what to copy, and it has said it.
 */
const SELECTION_KEYS = new Set(["h", "j", "k", "l", "v", "#", "c", "x", "J", "K"]);

/**
 * Run whatever `key` is bound to. Returns null when nothing is — the caller
 * should leave the event alone rather than swallowing it.
 *
 * Clearing the pending count lives here and not in the commands: only the
 * digits build it up, and every other key spends it and is done. The
 * selection is cleared the same way and for the same reason — only the keys
 * that read or extend it (`SELECTION_KEYS`, plus the digits a count for one of
 * them might need) get to leave it standing; anything else — editing an
 * argument, answering, undo — is a normal-mode action that shouldn't inherit
 * a selection some earlier `v` left lying around.
 */
export function run(key: string, ctx: CommandContext): EditorState | null {
  // The keymap on screen owns the keyboard. Every key is swallowed rather than
  // run, so that reaching for something while reading the help sheet can't
  // quietly answer an argument on the flow behind it — and `Escape`, or the
  // `?` that opened it, puts it away.
  //
  // Non-null for every key, unlike the fall-through below, which is what makes
  // the caller call `preventDefault` and actually swallow them.
  if (ctx.state.help) {
    const closes = key === "Escape" || key === "?" || key === "Enter";
    return closes ? { ...ctx.state, help: false } : ctx.state;
  }
  const command = commands[key];
  if (!command) return null;
  const next = command(ctx);
  const spent = isDigit(key) ? next : { ...next, count: null };
  const kept =
    isDigit(key) || SELECTION_KEYS.has(key) ? spent : { ...spent, selectAnchor: null };
  return releaseSelection(followFocus(kept, ctx.flow), ctx.placed);
}
