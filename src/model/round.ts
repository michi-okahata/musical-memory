import { LoroDoc, UndoManager } from "loro-crdt";
import type { LoroMovableList, Subscription } from "loro-crdt";
import { Flow, LEGACY_SHEET_ID } from "./flow";
import type { PeerRecord, Role } from "./types";

/**
 * A round: every sheet in it, and the document they all live in.
 *
 * A debate isn't one flow. Each position gets its own sheet — the case, the
 * topicality violation, each disadvantage — and they are independent: an
 * argument on the politics DA answers nothing on topicality, and the two are
 * read side by side, not merged. So a sheet is a whole `Flow` with its own
 * tree, and this is the ordered set of them.
 *
 * What lives here rather than on a sheet is everything that is true of the
 * *document*: the bytes that go on the wire, who the peers are, and the undo
 * history. Undo especially — one history for the round, not one per sheet,
 * because `u` means "take back the last thing I did" and a debater who typed
 * on the wrong sheet and pressed undo means the thing they just typed, not the
 * last thing they happened to do on whichever sheet they are looking at now.
 * Undoing across a sheet boundary carries you back to the sheet it happened on
 * (see `undo`).
 */

/** The ordered list of sheets: `{ id, title }`, id doubling as its tree's key. */
const SHEETS_KEY = "sheets";

/**
 * Who each peer is, keyed by Loro peer id. Written by `identify`, and read to
 * put a name on an argument long after its author has disconnected.
 */
const PEERS_KEY = "peers";

/**
 * Commit origin for writes that are bookkeeping rather than flowing — the peer
 * registry, for now. `UndoManager` is told to ignore this prefix, so pressing
 * `u` after a peer joins undoes your last argument rather than their arrival.
 */
const SYNC_ORIGIN = "sync";

/**
 * Commits closer together than this collapse into one undo step. Text writes
 * are already throttled (see the editor), so continuous typing arrives as a
 * commit every ~150ms; this merges a burst of typing — and the keystroke that
 * created the argument it went into — into a single undo.
 */
const UNDO_MERGE_MS = 500;

export interface SheetInfo {
  id: string;
  title: string;
}

/** Where the cursor was when a change was made: which sheet, and where on it. */
export interface Place {
  sheet: string;
  /** Null when the sheet is known but the argument isn't. */
  id: string | null;
}

export class Round {
  readonly doc: LoroDoc;
  /** Untyped on purpose: `isSheet` is what turns an entry into a `SheetInfo`,
      and it has to run anyway — a peer on a newer version may write a shape
      this one doesn't know. */
  private readonly list: LoroMovableList;
  private readonly history: UndoManager;
  /** One `Flow` per sheet, built on demand and kept — a sheet's tree handle is
      cheap, but handing out a new one per render would break identity for
      every hook that depends on it. */
  private readonly flows = new Map<string, Flow>();
  private readCursor: (() => Place | null) | null = null;
  /** Where the cursor was as of the change being committed. */
  private undoMark = "";
  /** The mark carried by the step just popped off the undo/redo stack. */
  private popped = "";

  constructor(doc: LoroDoc = new LoroDoc()) {
    this.doc = doc;
    this.list = doc.getMovableList(SHEETS_KEY);
    this.history = new UndoManager(doc, {
      mergeInterval: UNDO_MERGE_MS,
      excludeOriginPrefixes: [SYNC_ORIGIN],
    });
  }

  /* ---- the sheets -------------------------------------------------------- */

  /**
   * Every sheet, in the order they are flowed in.
   *
   * A document written before sheets existed kept its arguments in a single
   * tree named `flow`, and it is reported here as one sheet without anything
   * being written: a migration that wrote to the document would be a change
   * made by whichever peer happened to open it first, which is a strange thing
   * for opening a file to do — and two peers opening it at once would each make
   * their own.
   */
  sheets(): SheetInfo[] {
    const listed = this.list.toArray().filter(isSheet);
    if (listed.length > 0) return listed;
    return this.doc.getTree(LEGACY_SHEET_ID).roots().length > 0
      ? [{ id: LEGACY_SHEET_ID, title: "Case" }]
      : [];
  }

  has(sheetId: string): boolean {
    return this.sheets().some((sheet) => sheet.id === sheetId);
  }

  titleOf(sheetId: string): string {
    return this.sheets().find((sheet) => sheet.id === sheetId)?.title ?? "";
  }

  /** The sheet itself — the flow of arguments on it. */
  flow(sheetId: string): Flow {
    const existing = this.flows.get(sheetId);
    if (existing) return existing;
    const flow = new Flow(this.doc, sheetId, {
      beforeChange: () => this.markCursor(),
    });
    this.flows.set(sheetId, flow);
    return flow;
  }

  /**
   * Start a sheet. Returns its id.
   *
   * The id is random rather than derived from the title, because a sheet gets
   * renamed — "DA" becomes "Politics DA" once you hear which one it is — and a
   * rename must not be a different sheet.
   */
  addSheet(title: string, at?: number): string {
    this.markCursor();
    const id = `sheet-${Math.random().toString(36).slice(2, 8)}`;
    const sheets = this.materialize();
    const index = at ?? sheets.length;
    this.list.insert(index, { id, title });
    this.doc.commit();
    return id;
  }

  renameSheet(sheetId: string, title: string): void {
    this.markCursor();
    const index = this.materialize().findIndex((sheet) => sheet.id === sheetId);
    if (index < 0) return;
    this.list.set(index, { id: sheetId, title });
    this.doc.commit();
  }

  /**
   * Delete a sheet and everything on it.
   *
   * The arguments go with it — a sheet is not a folder, and a position nobody
   * is flowing any more is not a position with an empty sheet. Undo brings the
   * whole thing back, which is the only reason this can be one keystroke.
   */
  removeSheet(sheetId: string): void {
    this.markCursor();
    const sheets = this.materialize();
    const index = sheets.findIndex((sheet) => sheet.id === sheetId);
    if (index < 0) return;
    const flow = this.flow(sheetId);
    this.doc.commit();
    // The registry entry and the arguments in one commit, so undo brings the
    // sheet back whole rather than as an empty sheet you then have to undo
    // again to fill.
    flow.batch(() => {
      for (const root of flow.roots()) flow.remove(root.id);
      this.list.delete(index, 1);
    });
    this.flows.delete(sheetId);
  }

  /** Shift a sheet to a different place in the order. */
  moveSheet(sheetId: string, to: number): void {
    this.markCursor();
    const sheets = this.materialize();
    const from = sheets.findIndex((sheet) => sheet.id === sheetId);
    if (from < 0 || to < 0 || to >= sheets.length || to === from) return;
    // A movable list moves in one op rather than as a delete and an insert, so
    // two peers reordering at once end with both moves rather than one of them
    // resurrecting a sheet the other deleted.
    this.list.move(from, to);
    this.doc.commit();
  }

  /**
   * Write the registry out if it is only being inferred, and return it.
   *
   * The read path reports a pre-sheets document as one sheet without touching
   * it (see `sheets`). The moment anything is actually changed, that inference
   * has to become a fact — otherwise adding a second sheet would leave the
   * first one, the one with all the arguments on it, unlisted.
   */
  private materialize(): SheetInfo[] {
    const listed = this.list.toArray().filter(isSheet);
    if (listed.length > 0) return listed;
    const inferred = this.sheets();
    for (const sheet of inferred) this.list.push(sheet);
    return inferred;
  }

  /* ---- the document ------------------------------------------------------ */

  /**
   * This peer's id, as Loro stamps it into every op it makes. Also the key its
   * presence is published under while it's connected — one identity for the
   * document and the network both, so "who is on this argument now" and "who
   * wrote this argument" are answered in the same terms.
   */
  get peerId(): string {
    return this.doc.peerIdStr;
  }

  /**
   * Record who this peer is, in the document itself.
   *
   * In the document rather than only in presence because presence is
   * ephemeral: it evaporates when the peer disconnects, and the arguments they
   * flowed do not. Written under the sync origin so it never becomes an undo
   * step.
   */
  identify(name: string, role: Role = "human"): void {
    const peers = this.doc.getMap(PEERS_KEY);
    const known = peers.get(this.peerId) as PeerRecord | undefined;
    if (known?.name === name && known?.role === role) return;
    peers.set(this.peerId, { name, role });
    this.doc.commit({ origin: SYNC_ORIGIN });
  }

  /**
   * Which peer created an argument, read straight out of its id — a `TreeID` is
   * `counter@peer`, so authorship costs no storage and cannot disagree with the
   * op log.
   *
   * It is the *creating* peer: an argument someone else later rewrote still
   * reads as theirs, which is the useful answer on a flow ("did my partner take
   * this down, or did the assistant?") even though it isn't the whole story of
   * who typed which character.
   */
  authorOf(id: string): string | null {
    return id.includes("@") ? id.slice(id.indexOf("@") + 1) : null;
  }

  /** What a peer is called, if it ever said. */
  peerRecord(peerId: string): PeerRecord | null {
    return (this.doc.getMap(PEERS_KEY).get(peerId) as PeerRecord | undefined) ?? null;
  }

  /**
   * Subscribe to any change (local or remote). Returns an unsubscribe fn.
   * Typical use: re-read the sheets and the active flow's roots, and re-render.
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

  /**
   * Everything this peer changes, as it commits, encoded for the wire. Fires
   * only for local edits — an update that arrived from someone else does not
   * come back out of here, which is what keeps two peers from echoing a change
   * at each other forever.
   */
  onLocalUpdate(listener: (bytes: Uint8Array) => void): () => void {
    return this.doc.subscribeLocalUpdates(listener);
  }

  static fromSnapshot(bytes: Uint8Array): Round {
    const round = new Round();
    round.import(bytes);
    return round;
  }

  /* ---- history ----------------------------------------------------------- */

  /**
   * Remember where the cursor is with every change, so undo can put it back.
   * `read` is the editor's answer to "which argument, on which sheet?".
   *
   * Returns a function that stops the tracking.
   */
  trackCursor(read: () => Place | null): () => void {
    this.readCursor = read;
    // Loro's step metadata is a plain `Value`; a string keeps it simple, and
    // "" stands in for "we don't know where the cursor was".
    this.history.setOnPush(() => ({ value: this.undoMark, cursors: [] }));
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
   * Note where the cursor is *before* a mutation touches the document.
   *
   * The timing is the whole point. Loro pushes its undo step when the change
   * commits, by which time a deletion has already taken the cursor's argument
   * with it — there'd be nothing left to describe. Every mutator calls this on
   * the way in instead, while the tree still holds the answer.
   */
  private markCursor(): void {
    const at = this.readCursor?.() ?? null;
    if (!at) {
      this.undoMark = "";
      return;
    }
    const flow = this.flow(at.sheet);
    const where =
      at.id && flow.has(at.id) ? `${at.id}#${flow.pathOf(at.id).join(",")}` : "";
    this.undoMark = `${at.sheet}|${where}`;
  }

  /** Turn a mark back into a place: by id if it still names one, else by path. */
  private locate(mark: string): Place | null {
    const cut = mark.indexOf("|");
    if (cut < 0) return null;
    const sheet = mark.slice(0, cut);
    const [id, path] = mark.slice(cut + 1).split("#");
    if (!this.has(sheet)) return null;
    const flow = this.flow(sheet);
    if (id && flow.has(id)) return { sheet, id };
    if (!path) return { sheet, id: null };
    return { sheet, id: flow.atPath(path.split(",").filter(Boolean).map(Number)) };
  }

  /**
   * Undo the last local change.
   *
   * Returns where the cursor should go — the sheet the undone change was made
   * on, and the argument if that is known — or `undefined` when there was
   * nothing to undo at all. The caller has to tell those apart: a null `id`
   * still names a sheet worth switching to.
   *
   * Only *your* edits are undone — a peer's concurrent changes are left in
   * place, which is what you want when two people flow the same round.
   */
  undo(): Place | null | undefined {
    return this.step("undo");
  }

  redo(): Place | null | undefined {
    return this.step("redo");
  }

  private step(direction: "undo" | "redo"): Place | null | undefined {
    // The opposite stack gets a step pushed during this call; mark first so it
    // carries the cursor as it is now, not as it was two changes ago.
    this.markCursor();
    this.popped = "";
    const moved = direction === "undo" ? this.history.undo() : this.history.redo();
    if (!moved) return undefined;
    // Resolved only now: `locate` has to read the document as the undo left it.
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
   * seeding or loading a snapshot so undo can't rewind into an empty round.
   */
  clearHistory(): void {
    this.history.clear();
  }
}

/** A registry entry we can actually use — a peer on a newer version may not be. */
function isSheet(value: unknown): value is SheetInfo {
  const sheet = value as SheetInfo | null;
  return (
    typeof sheet?.id === "string" &&
    sheet.id.length > 0 &&
    typeof sheet.title === "string"
  );
}
