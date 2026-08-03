import { LoroDoc, UndoManager } from "loro-crdt";
import type { LoroTree, LoroTreeNode, TreeID, Subscription } from "loro-crdt";
import type { Argument } from "./types";

/**
 * A debate "flow": the tree of arguments and the responses made to them across
 * speeches. Structure lives in a Loro `LoroTree` (a movable-tree CRDT), so
 * concurrent add / move / delete from multiple peers merge without cycles,
 * orphans, or lost children. Each node carries its own `LoroMap` of metadata.
 *
 * `speech` is the column an argument sits in (0 = first speech, 1 = next, ...);
 * the tree edges are the "who responded to what" relationships.
 */

const TREE_KEY = "flow";

/**
 * Commits closer together than this collapse into one undo step. Text writes
 * are already throttled (see the editor), so continuous typing arrives as a
 * commit every ~150ms; this merges a burst of typing — and the keystroke that
 * created the card it went into — into a single undo.
 */
const UNDO_MERGE_MS = 500;

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
   * This is a convenience, not an invariant: a card's column is the speech it
   * was made in, which is independent of what it answers. A 2AR can respond to
   * a 1NC argument.
   */
  speech?: number;
}

/** Resolved placement: which parent, which slot, and the column to default to. */
interface Placement {
  parent?: LoroTreeNode;
  index?: number;
  speech: number;
}

export class Flow {
  readonly doc: LoroDoc;
  private readonly tree: LoroTree;
  private readonly history: UndoManager;
  private txDepth = 0;
  /** Reads the editor's cursor, once `trackCursor` has been called. */
  private readCursor: (() => string | null) | null = null;
  /** The cursor's whereabouts as of the mutation being committed. */
  private mark = "";
  /** The mark carried by the step just popped off the undo/redo stack. */
  private popped = "";

  constructor(doc: LoroDoc = new LoroDoc()) {
    this.doc = doc;
    this.tree = doc.getTree(TREE_KEY);
    // Keep siblings in a deterministic, stable order and allow positional
    // moves (moveTo / createAt with an index).
    this.tree.enableFractionalIndex(0);
    this.history = new UndoManager(doc, { mergeInterval: UNDO_MERGE_MS });
  }

  /**
   * Remember where the cursor is with every change, so undo can put it back.
   * `read` is the editor's answer to "which card is the cursor on?".
   *
   * Returns a function that stops the tracking.
   */
  trackCursor(read: () => string | null): () => void {
    this.readCursor = read;
    // Loro's step metadata is a plain `Value`; a string keeps it simple, and
    // "" stands in for "we don't know where the cursor was".
    this.history.setOnPush(() => ({ value: this.mark, cursors: [] }));
    this.history.setOnPop((_isUndo, meta) => {
      this.popped = typeof meta.value === "string" ? meta.value : "";
    });
    return () => {
      this.readCursor = null;
      this.history.setOnPush(undefined);
      this.history.setOnPop(undefined);
    };
  }

  /**
   * Note where the cursor is *before* a mutation touches the tree.
   *
   * The timing is the whole point. Loro pushes its undo step when the change
   * commits, by which time a deletion has already taken the cursor's card with
   * it — there'd be nothing left to describe. Every mutator calls this on the
   * way in instead, while the tree still holds the answer.
   */
  private markCursor(): void {
    const id = this.readCursor?.() ?? null;
    this.mark = id && this.has(id) ? `${id}#${this.pathOf(id).join(",")}` : "";
  }

  /**
   * A card's structural position: its index among the roots, then among its
   * parent's children, and so on down.
   *
   * Recorded next to the id because the id alone does not survive an undo.
   * Loro reverses a deletion by *re-creating* the subtree, and a created node
   * takes a fresh `TreeID` — so the card the user is looking at after undo has
   * a different name than the one that went away. Its place in the flow, on
   * the other hand, is exactly the one it left.
   */
  private pathOf(id: string): number[] {
    const path: number[] = [];
    let node: LoroTreeNode | undefined = this.tree.getNodeByID(id as TreeID);
    while (node) {
      path.unshift(node.index() ?? 0);
      node = node.parent();
    }
    return path;
  }

  /** The card now sitting at `path`, if anything does. */
  private atPath(path: number[]): string | null {
    let siblings = this.tree.roots();
    let node: LoroTreeNode | undefined;
    for (const i of path) {
      node = siblings[i];
      if (!node) return null;
      siblings = node.children() ?? [];
    }
    return node?.id ?? null;
  }

  /** Turn a mark back into a card: by id if it still names one, else by place. */
  private locate(mark: string): string | null {
    const [id, path] = mark.split("#");
    if (id && this.has(id)) return id;
    if (!path) return null;
    return this.atPath(path.split(",").filter(Boolean).map(Number));
  }

  /**
   * Undo the last local change.
   *
   * Returns the card the cursor should go to — where the undone change was
   * made — or null if that isn't known, or `undefined` when there was nothing
   * to undo at all. The caller has to tell those last two apart.
   *
   * Only *your* edits are undone — a peer's concurrent changes are left in
   * place, which is what you want when two people flow the same round.
   */
  undo(): string | null | undefined {
    return this.step("undo");
  }

  redo(): string | null | undefined {
    return this.step("redo");
  }

  private step(direction: "undo" | "redo"): string | null | undefined {
    // The opposite stack gets a step pushed during this call; mark first so it
    // carries the cursor as it is now, not as it was two changes ago.
    this.markCursor();
    this.popped = "";
    const moved = direction === "undo" ? this.history.undo() : this.history.redo();
    if (!moved) return undefined;
    // Resolved only now: `locate` has to read the tree as the undo left it.
    return this.locate(this.popped);
  }

  canUndo(): boolean {
    return this.history.canUndo();
  }

  canRedo(): boolean {
    return this.history.canRedo();
  }

  /**
   * Drop the undo history, making the current state the floor. Call after
   * seeding or loading a snapshot so undo can't rewind into an empty flow.
   */
  clearHistory(): void {
    this.history.clear();
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
    const node = at.parent
      ? at.parent.createNode(at.index)
      : this.tree.createNode(undefined, at.index);
    node.data.set("text", init.text ?? "");
    node.data.set("speech", init.speech ?? at.speech);
    this.commit();
    return node.id;
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

  setText(id: string, text: string): void {
    this.markCursor();
    this.requireNode(id).data.set("text", text);
    this.commit();
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

  /**
   * Subscribe to any change (local or remote). Returns an unsubscribe fn.
   * Typical use: re-read `roots()` and re-render.
   */
  subscribe(listener: () => void): Subscription {
    return this.doc.subscribe(() => listener());
  }

  /** Snapshot for persistence / initial sync. */
  export(): Uint8Array {
    return this.doc.export({ mode: "snapshot" });
  }

  /** Incremental update since the peer's known version, for live sync. */
  exportUpdates(): Uint8Array {
    return this.doc.export({ mode: "update" });
  }

  /** Merge a snapshot or update from another peer / disk. */
  import(bytes: Uint8Array): void {
    this.doc.import(bytes);
  }

  static fromSnapshot(bytes: Uint8Array): Flow {
    const flow = new Flow();
    flow.import(bytes);
    return flow;
  }

  private requireNode(id: string): LoroTreeNode {
    const node = this.tree.getNodeByID(id as TreeID);
    if (!node || node.isDeleted()) {
      throw new Error(`Flow: no argument with id ${id}`);
    }
    return node;
  }
}

/** Convert a live Loro tree node into the immutable view `Argument`. */
function toArgument(node: LoroTreeNode): Argument {
  return {
    id: node.id,
    text: (node.data.get("text") as string) ?? "",
    speech: (node.data.get("speech") as number) ?? 0,
    children: (node.children() ?? []).map(toArgument),
  };
}
