import { LoroDoc } from "loro-crdt";
import type { LoroTree, LoroTreeNode, TreeID, Subscription } from "loro-crdt";
import type { Argument } from "./Flow.tsx";

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

export class Flow {
  readonly doc: LoroDoc;
  private readonly tree: LoroTree;

  constructor(doc: LoroDoc = new LoroDoc()) {
    this.doc = doc;
    this.tree = doc.getTree(TREE_KEY);
    // Keep siblings in a deterministic, stable order and allow positional
    // moves (moveTo / createAt with an index).
    this.tree.enableFractionalIndex(0);
  }

  /**
   * Add an argument. With no `parent` it's a root (an opening argument);
   * otherwise it's a response to `parent`. Returns the new node's id.
   */
  addArgument(text: string, speech: number, parent?: string): TreeID {
    const node = parent
      ? this.requireNode(parent).createNode()
      : this.tree.createNode();
    node.data.set("text", text);
    node.data.set("speech", speech);
    this.doc.commit();
    return node.id;
  }

  /**
   * Add a response to an existing argument. Defaults the response into the
   * next speech column unless `speech` is given explicitly.
   */
  addResponse(parent: string, text: string, speech?: number): TreeID {
    const parentNode = this.requireNode(parent);
    const col = speech ?? (parentNode.data.get("speech") as number) + 1;
    return this.addArgument(text, col, parent);
  }

  /**
   * Add another response alongside `id` — a new node under the same parent, in
   * the same speech column. If `id` is a root, the sibling is another root.
   */
  addSibling(id: string, text: string): TreeID {
    const node = this.requireNode(id);
    const parent = node.parent();
    const speech = (node.data.get("speech") as number) ?? 0;
    const sibling = parent ? parent.createNode() : this.tree.createNode();
    sibling.data.set("text", text);
    sibling.data.set("speech", speech);
    this.doc.commit();
    return sibling.id;
  }

  setText(id: string, text: string): void {
    this.requireNode(id).data.set("text", text);
    this.doc.commit();
  }

  setSpeech(id: string, speech: number): void {
    this.requireNode(id).data.set("speech", speech);
    this.doc.commit();
  }

  /**
   * Re-parent an argument (e.g. it was actually a response to a different
   * point). `newParent` undefined promotes it to a root. `index` positions it
   * among siblings. Cycles throw.
   */
  move(id: string, newParent?: string, index?: number): void {
    this.tree.move(id as TreeID, newParent as TreeID | undefined, index);
    this.doc.commit();
  }

  /** Delete an argument and everything responding to it. */
  remove(id: string): void {
    this.tree.delete(id as TreeID);
    this.doc.commit();
  }

  /**
   * Start a new argument tree (a root) in `speech`, placed directly after the
   * tree that `near` belongs to. Passing null appends it to the end.
   *
   * Unlike `addResponse`, the new argument answers nothing — it's a fresh
   * top-level argument that can sit in any speech column, not just the 1AC.
   */
  addRootAfter(near: string | null, text: string, speech: number): TreeID {
    let index: number | undefined;
    if (near && this.has(near)) {
      const rootId = this.rootIdOf(near);
      const i = this.tree.roots().findIndex((r) => r.id === rootId);
      if (i >= 0) index = i + 1;
    }
    const node = this.tree.createNode(undefined, index);
    node.data.set("text", text);
    node.data.set("speech", speech);
    this.doc.commit();
    return node.id;
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
