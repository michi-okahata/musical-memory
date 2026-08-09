import { LoroDoc, LoroText } from "loro-crdt";
import type { LoroTree, LoroTreeNode, TreeID } from "loro-crdt";
import {
  DEFAULT_MARK,
  DEFAULT_SUPPORT,
  type Argument,
  type Copied,
  type Mark,
  type Support,
} from "./types";

/**
 * One sheet of a flow: the tree of arguments on a single position, and the
 * responses made to them across speeches. Structure lives in a Loro `LoroTree`
 * (a movable-tree CRDT), so concurrent add / move / delete from multiple peers
 * merge without cycles, orphans, or lost children. Each node carries its own
 * `LoroMap` of metadata.
 *
 * `speech` is the column an argument sits in (0 = first speech, 1 = next, ...);
 * the tree edges are the "who responded to what" relationships.
 *
 * A round is several of these — the case, topicality, each disadvantage — and
 * the set of them is `Round` (see round.ts), which owns the document all these
 * trees live in. This class knows about one sheet and nothing else: it does not
 * export, import, or undo, because those are things you do to a round.
 *
 * Everything here is deliberately free of the DOM and of React: the same class
 * is what a headless peer runs — a relay keeping a room's document, or an
 * assistant transcribing a speech into it — so a flow can be joined by
 * something that has no sheet to draw.
 */

/** The tree a document written before sheets existed keeps its arguments in. */
export const LEGACY_SHEET_ID = "flow";

export interface FlowHooks {
  /**
   * Called on the way into every mutation, while the tree still holds what is
   * about to change. It is how the round notes where the cursor was before a
   * deletion takes the argument it was on — see `Round.markCursor`.
   */
  beforeChange?: () => void;
}

/**
 * Where a new argument goes, as a *value* rather than a method name — so a
 * keybinding, a drag-and-drop drop target, or a paste can each compute a
 * position and hand it to the same `add`.
 *
 * `root` anchors against the whole tree `near` belongs to — past the end of it,
 * or `before` it, which is how an overview gets written above an argument that
 * is already on the sheet. A null `near` means the far end of the flow.
 * `after` / `before` anchor against `id` itself among its siblings.
 */
export type Anchor =
  | { under: string }
  | { after: string }
  | { before: string }
  | { root: string | null; before?: boolean };

export interface ArgumentInit {
  text?: string;
  /**
   * Which speech column the argument sits in. Defaults to the anchor's own
   * column, or the next one for a response.
   *
   * This is a convenience, not an invariant: an argument's column is the
   * speech it was made in, which is independent of what it answers. A 2AR can
   * respond to a 1NC argument.
   */
  speech?: number;
  /**
   * How the argument is marked off. Defaults to whatever the group it lands in
   * is already marked with, so the choice is made once per group and every
   * argument added to it afterwards agrees without being asked.
   */
  mark?: Mark;
  /**
   * Whether it was read off evidence. Defaults to its same-speech neighbour's,
   * on exactly the same terms as `mark` — a debater reading a block of cards
   * says so once, not once per card.
   */
  support?: Support;
}

/** Resolved placement: which parent, which slot, and the column to default to. */
interface Placement {
  parent?: LoroTreeNode;
  index?: number;
  speech: number;
}

export class Flow {
  readonly doc: LoroDoc;
  /** Which sheet this is, in the round that owns it. Also its tree's key. */
  readonly id: string;
  private readonly tree: LoroTree;
  private readonly hooks: FlowHooks;
  private txDepth = 0;

  constructor(doc: LoroDoc = new LoroDoc(), id: string = LEGACY_SHEET_ID, hooks: FlowHooks = {}) {
    this.doc = doc;
    this.id = id;
    // The sheet's id names its tree. One container per sheet rather than one
    // tree with the sheets as its roots: a sheet is a whole flow — the layout,
    // the keymap and the cursor all speak in terms of *its* roots — and making
    // them all say "the children of the sheet I'm on" instead would put the
    // same fact in thirty places.
    this.tree = doc.getTree(id);
    // Keep siblings in a deterministic, stable order and allow positional
    // moves (moveTo / createAt with an index).
    this.tree.enableFractionalIndex(0);
    this.hooks = hooks;
  }

  /** Note where the cursor is before this sheet changes — see `FlowHooks`. */
  private markCursor(): void {
    this.hooks.beforeChange?.();
  }

  /**
   * An argument's structural position: its index among the roots, then among
   * its parent's children, and so on down.
   *
   * Recorded next to the id because the id alone does not survive an undo.
   * Loro reverses a deletion by *re-creating* the subtree, and a created node
   * takes a fresh `TreeID` — so the argument the user is looking at after undo
   * has a different name than the one that went away. Its place in the flow,
   * on the other hand, is exactly the one it left.
   */
  pathOf(id: string): number[] {
    const path: number[] = [];
    let node: LoroTreeNode | undefined = this.tree.getNodeByID(id as TreeID);
    while (node) {
      path.unshift(node.index() ?? 0);
      node = node.parent();
    }
    return path;
  }

  /** The argument now sitting at `path`, if anything does. */
  atPath(path: number[]): string | null {
    let siblings = this.tree.roots();
    let node: LoroTreeNode | undefined;
    for (const i of path) {
      node = siblings[i];
      if (!node) return null;
      siblings = node.children() ?? [];
    }
    return node?.id ?? null;
  }

  /**
   * Run `fn` as one atomic change: a single commit, so subscribers render once
   * and undo treats it as one step. Nests safely — only the outermost `batch`
   * commits. Returns whatever `fn` returns.
   *
   * Note that a throw still commits: Loro applies each op as it happens, so
   * there is nothing to roll back, and leaving them uncommitted would only
   * fold them into the next unrelated commit.
   */
  batch<T>(fn: () => T): T {
    this.txDepth++;
    try {
      return fn();
    } finally {
      if (--this.txDepth === 0) this.doc.commit();
    }
  }

  /** The one place an argument is created. Every add* wrapper routes here. */
  add(anchor: Anchor, init: ArgumentInit = {}): TreeID {
    this.markCursor();
    const at = this.resolve(anchor);
    const speech = init.speech ?? at.speech;
    const siblings = at.parent ? (at.parent.children() ?? []) : this.tree.roots();
    // Read the neighbour before joining it: an argument starts out marked
    // like whichever same-speech sibling it lands next to, so it simply
    // continues that run. Done here rather than in the keymap so every way of
    // making an argument — a binding, a paste, a drop — inherits alike.
    const mark = init.mark ?? this.neighborMark(siblings, at.index, speech);
    const support = init.support ?? this.neighborSupport(siblings, at.index, speech);
    const node = at.parent
      ? at.parent.createNode(at.index)
      : this.tree.createNode(undefined, at.index);
    // Text is its own container, not a string in the map — see `setText`.
    const text = node.data.setContainer("text", new LoroText());
    if (init.text) text.insert(0, init.text);
    node.data.set("speech", speech);
    node.data.set("mark", mark);
    node.data.set("support", support);
    this.commit();
    return node.id;
  }

  /**
   * What a new argument should inherit from the argument it lands beside: read
   * off its same-speech neighbour, found by scanning outward from the insertion
   * point — backward first, since an argument usually continues the run before
   * it, then forward for one inserted at the very start of the list. The
   * document default if the list has nothing in that speech yet.
   *
   * `siblings` mixes every speech together (it's `parent.children()` as Loro
   * keeps it, or the roots) because `index` — the slot `resolve` computed — is
   * a position in that same mixed list, and the two must agree to find the
   * right neighbour.
   *
   * Generic over what is being read because the mark and the support inherit
   * by the identical rule, and the rule is the fiddly part: which direction to
   * scan first, and that only same-speech siblings count. Two copies of it
   * would be two places to get that wrong.
   */
  private inherited<T>(
    siblings: LoroTreeNode[],
    index: number | undefined,
    speech: number,
    read: (node: LoroTreeNode) => T,
    fallback: T,
  ): T {
    const at = index ?? siblings.length;
    for (let i = at - 1; i >= 0; i--) {
      if (this.readSpeech(siblings[i]) === speech) return read(siblings[i]);
    }
    for (let i = at; i < siblings.length; i++) {
      if (this.readSpeech(siblings[i]) === speech) return read(siblings[i]);
    }
    return fallback;
  }

  private neighborMark(
    siblings: LoroTreeNode[],
    index: number | undefined,
    speech: number,
  ): Mark {
    return this.inherited(siblings, index, speech, readMark, DEFAULT_MARK);
  }

  private neighborSupport(
    siblings: LoroTreeNode[],
    index: number | undefined,
    speech: number,
  ): Support {
    return this.inherited(siblings, index, speech, readSupport, DEFAULT_SUPPORT);
  }

  /** How the argument's own run is marked — see `Mark`. */
  markOf(id: string): Mark {
    return readMark(this.requireNode(id));
  }

  /** Whether the argument was read off evidence — see `Support`. */
  supportOf(id: string): Support {
    return readSupport(this.requireNode(id));
  }

  /**
   * Mark every argument in `ids` the same way, in one commit — so a
   * multi-argument selection re-marks as one undo step rather than one per
   * argument.
   *
   * Unlike the old whole-group behaviour, this touches only the arguments
   * named: a run is no longer a fixed unit the flow enforces, just whatever a
   * "1. 2. 3." reads as as you scan down a column — the keymap decides what
   * counts as "the selection" (see `selectedIds` in commands.ts), not this
   * method.
   */
  setMarks(ids: string[], mark: Mark): void {
    this.markCursor();
    this.batch(() => {
      for (const id of ids) {
        if (this.has(id)) this.requireNode(id).data.set("mark", mark);
      }
    });
  }

  /**
   * Say whether every argument in `ids` was read off evidence, in one commit —
   * same shape as `setMarks`, and for the same reason: `c` over a selected run
   * of a block is one undo step, not one per card.
   */
  setSupports(ids: string[], support: Support): void {
    this.markCursor();
    this.batch(() => {
      for (const id of ids) {
        if (this.has(id)) this.requireNode(id).data.set("support", support);
      }
    });
  }

  /**
   * The raw children of `parent` — or the roots, if null — in the order Loro
   * itself keeps: every speech mixed together, the same list `index` values
   * from `resolve`/`move` are positions in. For computing an absolute
   * insertion point (reordering a selection); nothing that walks the argument
   * tree for rendering should need it.
   */
  childrenOf(parent: string | null): string[] {
    const list = parent ? (this.requireNode(parent).children() ?? []) : this.tree.roots();
    return list.map((n) => n.id);
  }

  /**
   * Add a response to an existing argument — a child, in the next speech
   * column unless `speech` says otherwise.
   */
  addResponse(parent: string, text: string, speech?: number): TreeID {
    return this.add({ under: parent }, { text, speech });
  }

  /**
   * Add another response alongside `id` — same parent, same speech column,
   * positioned directly after it. If `id` is a root, the sibling is a root.
   */
  addSibling(id: string, text: string): TreeID {
    return this.add({ after: id }, { text });
  }

  /**
   * Start a new argument tree (a root) in `speech`, placed after — or before —
   * the whole tree that `near` belongs to. Passing null puts it at the end of
   * the flow, or at the top when `where` is "before".
   *
   * Going *before* is not symmetry for its own sake: an overview is written
   * once the argument it overviews is already on the sheet, and it belongs
   * above it.
   *
   * Unlike `addResponse`, the new argument answers nothing — it's a fresh
   * top-level argument that can sit in any speech column, not just the 1AC.
   */
  addRoot(
    near: string | null,
    text: string,
    speech: number,
    where: "after" | "before" = "after",
  ): TreeID {
    return this.add({ root: near, before: where === "before" }, { text, speech });
  }

  /**
   * Take an argument off the sheet as plain data — it and everything
   * responding to it — without changing anything. What `y` keeps; see `Copied`
   * for why it is data and not ids.
   */
  copy(id: string): Copied {
    const node = this.requireNode(id);
    return {
      text: readText(node),
      mark: readMark(node),
      support: readSupport(node),
      speech: this.readSpeech(node),
      children: (node.children() ?? []).map((child) => this.copy(child.id)),
    };
  }

  /**
   * Write a copy back in at `anchor`, in `speech`, responses and all. Returns
   * the id of the argument at the top of it.
   *
   * One commit for the whole subtree, so putting an exchange back is one undo
   * rather than one per argument.
   *
   * `lastSpeech` is the final column of the sheet being put onto, and a
   * response with no column left to go in is *not put in* — nor is anything
   * answering it. Two things make that case ordinary rather than defensive: the
   * memory sheet is two columns wide (see memory/sheet.ts) where the round is
   * seven, and a copy taken early in the round can always be put down late in
   * it.
   *
   * Dropping is the least bad of three. Writing them past the last column
   * leaves arguments the sheet never draws — in the document, invisible, and
   * unreachable by the cursor. Flattening them *onto* the last column is worse
   * still, and not merely untidy: a response drawn in its own parent's column
   * is laid out at its parent's row (see `layoutFlow`), so the two land on top
   * of each other and neither can be read. Leaving them out is the only one of
   * the three whose result is a sheet, and nothing is lost that isn't still
   * sitting in the copy — `u`, and put it somewhere with room.
   *
   * The mark comes with the copy rather than being inherited from whatever it
   * lands next to, which is the one place a new argument doesn't follow its
   * neighbour (see `neighborMark`). A copy is a copy — you took a lettered
   * aside, you get a lettered aside — and `#` re-marks it if the run it landed
   * in disagrees.
   */
  paste(anchor: Anchor, copied: Copied, speech: number, lastSpeech: number): TreeID {
    return this.batch(() =>
      this.pasteNode(anchor, copied, speech - copied.speech, lastSpeech),
    );
  }

  /**
   * `shift` is how far the whole copy is moving — the distance from the column
   * its top was taken from to the one it is going into. Applied to every
   * argument in it alike, which is what keeps an exchange's shape: the answers
   * stay a speech later than the argument they answer, wherever it lands.
   */
  private pasteNode(anchor: Anchor, node: Copied, shift: number, last: number): TreeID {
    const id = this.add(anchor, {
      text: node.text,
      mark: node.mark,
      support: node.support,
      speech: Math.max(node.speech + shift, 0),
    });
    for (const child of node.children) {
      // Past the last speech there is no column to draw a response in, so it
      // doesn't go in — and what answered *it* goes nowhere either, which needs
      // no check of its own: this simply doesn't recurse.
      if (child.speech + shift <= last) this.pasteNode({ under: id }, child, shift, last);
    }
    return id;
  }

  /** Turn an `Anchor` into a concrete parent + slot + default column. */
  private resolve(anchor: Anchor): Placement {
    if ("under" in anchor) {
      const parent = this.requireNode(anchor.under);
      return { parent, speech: this.readSpeech(parent) + 1 };
    }

    if ("root" in anchor) {
      const near = anchor.root;
      // No anchor: append, or — going before — start the flow.
      let index: number | undefined = anchor.before ? 0 : undefined;
      if (near && this.has(near)) {
        const rootId = this.rootIdOf(near);
        const i = this.tree.roots().findIndex((r) => r.id === rootId);
        if (i >= 0) index = anchor.before ? i : i + 1;
      }
      return { index, speech: 0 };
    }

    // after / before: slot in among `id`'s siblings (or among the roots).
    const id = "after" in anchor ? anchor.after : anchor.before;
    const node = this.requireNode(id);
    const i = node.index();
    const index =
      i === undefined ? undefined : "after" in anchor ? i + 1 : i;
    return { parent: node.parent(), index, speech: this.readSpeech(node) };
  }

  /**
   * Rewrite an argument's text.
   *
   * The text is a `LoroText`, not a string on the node's map, and the whole
   * reason is other people: a map entry merges last-writer-wins, so two peers
   * typing into one argument would end with one of them silently losing
   * everything they wrote. A text CRDT merges by character instead, which is
   * what makes an argument something two people — or a person and an assistant
   * transcribing the speech into it — can be inside at the same time.
   *
   * The editor hands over the whole string rather than keystrokes, so `update`
   * diffs it against what's there and writes only the difference. That keeps
   * the merge honest: retyping a word touches that word, not the paragraph.
   */
  setText(id: string, text: string): void {
    this.markCursor();
    this.textContainer(this.requireNode(id)).update(text);
    this.commit();
  }

  /** An argument's text as it stands in the document. */
  textOf(id: string): string {
    return this.textContainer(this.requireNode(id)).toString();
  }

  /**
   * Replace `remove` characters at `at` with `insert` — the one edit the user
   * actually made, rather than the whole argument they made it in.
   *
   * This is what `setText` cannot do while somebody else is in the same
   * argument. `update` diffs the new text against what the *document* holds,
   * so a sentence your partner added while you had the argument open reads as
   * something you deleted, and writing your version deletes it. Handing over
   * the span that changed instead touches only what you touched, and their
   * sentence is still there when you both stop typing.
   *
   * Offsets are UTF-16, which is what Loro's text API and JavaScript's own
   * strings both count in, so the editor's positions need no translation.
   */
  spliceText(id: string, at: number, remove: number, insert: string): void {
    this.markCursor();
    const text = this.textContainer(this.requireNode(id));
    // A concurrent edit can leave the span short of where it was; clamping is
    // the difference between an edit landing slightly early and one throwing.
    const start = Math.min(at, text.length);
    const count = Math.min(remove, text.length - start);
    if (count > 0 || insert) text.splice(start, count, insert);
    this.commit();
  }

  /**
   * The text container of a node, creating it if this is a document written
   * before text had one. `getOrCreateContainer` rather than `setContainer` so
   * that two peers reaching this line concurrently converge on one container
   * instead of each installing their own and losing a writer.
   */
  private textContainer(node: LoroTreeNode): LoroText {
    const existing = node.data.get("text");
    if (existing instanceof LoroText) return existing;
    // A legacy plain-string value: carry it across, then let the container own
    // it from here.
    const was = typeof existing === "string" ? existing : "";
    const text = node.data.getOrCreateContainer("text", new LoroText());
    if (was && text.length === 0) text.insert(0, was);
    return text;
  }

  setSpeech(id: string, speech: number): void {
    this.markCursor();
    this.requireNode(id).data.set("speech", speech);
    this.commit();
  }

  /**
   * Re-parent an argument (e.g. it was actually a response to a different
   * point). `newParent` undefined promotes it to a root. `index` positions it
   * among siblings. Cycles throw.
   *
   * `speech` is deliberately left alone: which speech an argument was made in
   * doesn't change just because we corrected what it answers.
   */
  move(id: string, newParent?: string, index?: number): void {
    this.markCursor();
    this.tree.move(id as TreeID, newParent as TreeID | undefined, index);
    this.commit();
  }

  /** Delete an argument and everything responding to it. */
  remove(id: string): void {
    this.markCursor();
    this.tree.delete(id as TreeID);
    this.commit();
  }

  /** Commit unless we're inside a `batch` that will commit for us. */
  private commit(): void {
    if (this.txDepth === 0) this.doc.commit();
  }

  /** Which speech column an argument sits in. */
  speechOf(id: string): number {
    return this.readSpeech(this.requireNode(id));
  }

  private readSpeech(node: LoroTreeNode): number {
    return (node.data.get("speech") as number) ?? 0;
  }

  /** Walk up to the root of the tree `id` belongs to (itself if a root). */
  private rootIdOf(id: string): TreeID {
    let node = this.requireNode(id);
    for (let p = node.parent(); p; p = node.parent()) node = p;
    return node.id;
  }

  /** The id of an argument's parent, or null if it's a root. */
  parentOf(id: string): string | null {
    return this.requireNode(id).parent()?.id ?? null;
  }

  has(id: string): boolean {
    return this.tree.has(id as TreeID) && !this.tree.isNodeDeleted(id as TreeID);
  }

  /** The forest of root arguments as the plain tree `Flow` renders. */
  roots(): Argument[] {
    return this.tree.roots().map((n) => toArgument(n));
  }

  private requireNode(id: string): LoroTreeNode {
    const node = this.tree.getNodeByID(id as TreeID);
    if (!node || node.isDeleted()) {
      throw new Error(`Flow: no argument with id ${id}`);
    }
    return node;
  }
}

/**
 * How a node's group is numbered. Anything unrecognised — an older document
 * written before marks existed, a peer on a newer version — reads as the
 * default, so a flow always renders.
 */
function readMark(node: LoroTreeNode): Mark {
  const m = node.data.get("mark");
  return m === "alpha" || m === "none" || m === "num" ? m : DEFAULT_MARK;
}

/**
 * Whether the argument was read off evidence. Unrecognised the same way a mark
 * is, and that branch is the ordinary case here rather than a defensive one:
 * every argument written before `c` existed has no `support` at all, and reads
 * as the default — which is why the default is the one that leaves those sheets
 * looking exactly as they did.
 */
function readSupport(node: LoroTreeNode): Support {
  const s = node.data.get("support");
  return s === "analytic" || s === "card" ? s : DEFAULT_SUPPORT;
}

/** Convert a live Loro tree node into the immutable view `Argument`. */
function toArgument(node: LoroTreeNode): Argument {
  return {
    id: node.id,
    text: readText(node),
    speech: (node.data.get("speech") as number) ?? 0,
    mark: readMark(node),
    support: readSupport(node),
    children: (node.children() ?? []).map(toArgument),
  };
}

/**
 * An argument's text. A container since text became something two peers can be
 * inside at once (see `setText`); the string branch is for documents written
 * before that, which still have to render.
 */
function readText(node: LoroTreeNode): string {
  const text = node.data.get("text");
  if (text instanceof LoroText) return text.toString();
  return typeof text === "string" ? text : "";
}
