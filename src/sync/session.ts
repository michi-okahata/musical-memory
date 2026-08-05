import { EphemeralStore } from "loro-crdt";
import type { Flow } from "../model/flow";
import { Round, type SheetInfo } from "../model/round";
import type { Argument, Role } from "../model/types";
import {
  decodeBytes,
  encodeBytes,
  newRoomCode,
  parseInvitation,
  relayUrlFor,
  type ClientMessage,
  type ServerMessage,
} from "./protocol";
import { toPeer, type Peer, type Presence } from "./presence";
import {
  websocketTransport,
  type ConnectionStatus,
  type Transport,
  type TransportHandlers,
} from "./transport";

/**
 * A flow, and everybody else who is on it.
 *
 * This owns the document, the connection and the presence store together,
 * because they change together: joining a room replaces the document, a
 * reconnect has to re-announce the peer, and a peer that goes away takes its
 * cursor off the sheet. Written as a plain object with a subscription rather
 * than as hooks so that none of that ordering has to be expressed as an effect
 * — and so the same class runs headless, which is what a transcribing
 * assistant would be.
 *
 * ---- what is shared, and what isn't ------------------------------------
 * The document is the flow: arguments, their responses, which speech each was
 * made in, how it's marked. It merges, it persists, it is what undo walks.
 * Presence — where a peer's cursor is, whether they're typing — is ephemeral
 * and never enters the document. The editor's own state (the pending count, the
 * focused speech, the zoom) is not shared at all: those are how *you* are
 * reading the sheet, and two people reading one flow differently is the point.
 */

/** How long a peer's presence survives without a heartbeat. */
const PRESENCE_TIMEOUT_MS = 25_000;
/** How often we re-announce ourselves, comfortably inside that. */
const HEARTBEAT_MS = 8_000;

export interface SessionState {
  /** The live document. Replaced — not mutated — when joining someone's room. */
  round: Round;
  /** Every sheet in the round, in order. */
  sheets: SheetInfo[];
  /**
   * The sheet being looked at. Which sheet *you* are on is not in the document
   * and never goes in it: two people reading one round from different positions
   * is the ordinary case, not a conflict to resolve. It is published as
   * presence, so they can each see where the other is, and that is all.
   */
  activeSheet: string | null;
  /** The active sheet's flow, or null when the round has no sheets yet. */
  flow: Flow | null;
  /** `flow.roots()` as of the last change, so React has a value to render. */
  roots: Argument[];
  status: ConnectionStatus;
  /** The room code, or null when flowing alone. */
  room: string | null;
  /** The relay this peer is pointed at. Changeable while the app runs. */
  relayUrl: string;
  /** Everyone else in the room, self excluded. */
  peers: Peer[];
  /** This peer, as others see it. */
  me: Peer;
  /** The last thing that went wrong, for the status line. */
  error: string | null;
}

export interface SessionOptions {
  /** Where the relay is to begin with. Changeable later — see `useRelay`. */
  relayUrl: string;
  name: string;
  role?: Role;
  /** Fills a fresh solo document. Never run for a document being joined. */
  seed?: (round: Round) => void;
  /**
   * How to open a connection. The default is a WebSocket to `relayUrl`;
   * overridden in tests, and the seam for any other wire (see transport.ts).
   */
  connect?: (url: string, handlers: TransportHandlers) => Transport;
}

export class FlowSession {
  state: SessionState;

  private readonly options: SessionOptions;
  private readonly role: Role;
  private readonly listeners = new Set<() => void>();
  /**
   * Presence for the whole session, not per connection: it outlives a reconnect
   * (so a wifi blip doesn't wipe everyone off the sheet) and is re-sent whole
   * when the socket comes back.
   */
  private readonly presence = new EphemeralStore<Record<string, Presence>>(
    PRESENCE_TIMEOUT_MS,
  );
  private transport: Transport | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private detachFlow: (() => void) | null = null;
  private local: Presence;

  constructor(options: SessionOptions) {
    this.options = options;
    this.role = options.role ?? "human";
    this.local = {
      name: options.name,
      role: this.role,
      sheet: null,
      cursorId: null,
      editing: false,
      speech: null,
      at: 0,
    };

    const round = new Round();
    options.seed?.(round);
    // The document as opened is the floor — undo shouldn't rewind into a blank
    // round the user never typed.
    round.clearHistory();

    const sheets = round.sheets();
    const activeSheet = sheets[0]?.id ?? null;
    this.local.sheet = activeSheet;
    this.state = {
      round,
      sheets,
      activeSheet,
      flow: activeSheet ? round.flow(activeSheet) : null,
      roots: activeSheet ? round.flow(activeSheet).roots() : [],
      status: "offline",
      room: null,
      relayUrl: options.relayUrl,
      peers: [],
      me: toPeer(round.peerId, this.local),
      error: null,
    };
    this.attach(round);

    this.presence.subscribe(() => this.readPeers());
    this.presence.subscribeLocalUpdates((bytes) =>
      this.send({ t: "presence", data: encodeBytes(bytes) }),
    );
  }

  /* ---- reading ---------------------------------------------------------- */

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** The current state. Stable between changes, so React can compare it. */
  getState = (): SessionState => this.state;

  /* ---- the room --------------------------------------------------------- */

  /**
   * Publish this flow into a new room and return its code.
   *
   * The document is kept: sharing is how a flow you have already started gets
   * onto the wire, which is the ordinary case — you flow the 1AC, then your
   * partner sits down.
   */
  share(): string {
    const room = newRoomCode();
    this.connect(room);
    return room;
  }

  /**
   * Join someone else's room, adopting their flow.
   *
   * Takes the whole invitation — `192.168.1.42/k7fmqp`, or a bare code for a
   * room on the relay already configured — because that is the one string the
   * other person read out, and splitting it into "set the address, then join"
   * is two chances to mistype instead of one.
   *
   * This *replaces* the local document rather than merging into it, and the
   * distinction is the whole reason `share` and `join` are two commands. Both
   * are defensible mergers of two CRDTs, but they mean opposite things to a
   * person: `share` means "here is my flow", `join` means "show me yours".
   * Merging on join is what would put your sample flow — or last round's — into
   * your partner's sheet, sideways, with no way to tell which arguments were
   * real.
   */
  join(invitation: string): void {
    const parsed = parseInvitation(invitation);
    if (!parsed) {
      this.patch({ error: `not a room: ${invitation.trim()}` });
      return;
    }
    const relayUrl = parsed.host ? relayUrlFor(parsed.host) : this.state.relayUrl;
    if (parsed.room === this.state.room && relayUrl === this.state.relayUrl) return;

    const round = new Round();
    round.clearHistory();
    this.attach(round);
    this.patch({
      round,
      sheets: [],
      activeSheet: null,
      flow: null,
      roots: [],
      relayUrl,
      me: toPeer(round.peerId, this.local),
    });
    this.connect(parsed.room);
  }

  /**
   * Point at a different relay. Reconnects if we're in a room, since the room
   * is a room *on* a relay and the code alone doesn't name it.
   */
  setRelayUrl(relayUrl: string): void {
    if (relayUrl === this.state.relayUrl) return;
    this.patch({ relayUrl });
    if (this.state.room) this.connect(this.state.room);
  }

  /**
   * Leave the room, keeping the flow. What you have on screen is yours — it
   * simply stops being anyone else's.
   */
  leave(): void {
    this.disconnect();
    this.presence.delete(this.state.round.peerId);
    this.patch({ room: null, peers: [], status: "offline", error: null });
  }

  /**
   * Say that something went wrong, in the same place the relay's own refusals
   * land — so a failure to start hosting reads exactly like a bad room code,
   * and the status line only has one thing to render.
   */
  reportError(reason: string): void {
    this.patch({ error: reason });
  }

  rename(name: string): void {
    this.local = { ...this.local, name };
    this.state.round.identify(name, this.role);
    this.publish();
    this.patch({ me: toPeer(this.state.round.peerId, this.local) });
  }

  /**
   * Say where this peer is now. Called as the cursor moves, so it is written to
   * be cheap and idempotent: unchanged presence is not re-sent.
   */
  setLocal(update: Partial<Presence>): void {
    const next = { ...this.local, ...update };
    if (
      next.sheet === this.local.sheet &&
      next.cursorId === this.local.cursorId &&
      next.editing === this.local.editing &&
      next.speech === this.local.speech &&
      next.name === this.local.name
    ) {
      return;
    }
    this.local = next;
    this.publish();
  }

  /**
   * Drop the connection but remember the room, so `resume` puts it back.
   *
   * The pair exists because a React root is mounted and unmounted for reasons
   * that have nothing to do with a debate — StrictMode's double mount in
   * development, a hot reload mid-round. Tearing the session down and
   * rebuilding it there would drop the document; suspending only costs a
   * reconnect, and reconnecting is a path that has to work anyway.
   */
  suspend(): void {
    this.disconnect();
    this.patch({ status: "offline" });
  }

  resume(): void {
    if (this.state.room && !this.transport) this.connect(this.state.room);
  }

  destroy(): void {
    this.disconnect();
    this.detachFlow?.();
    this.detachFlow = null;
    this.presence.destroy();
    this.listeners.clear();
  }

  /* ---- the document ----------------------------------------------------- */

  /** Wire a document up to the room: name its peer, render it, broadcast it. */
  private attach(round: Round): void {
    this.detachFlow?.();
    round.identify(this.local.name, this.role);

    const unsubscribeDoc = round.subscribe(() => this.refresh());
    const unsubscribeLocal = round.onLocalUpdate((bytes) =>
      this.send({ t: "doc", data: encodeBytes(bytes) }),
    );
    this.detachFlow = () => {
      unsubscribeDoc();
      unsubscribeLocal();
    };
  }

  /**
   * Re-read everything derived from the document: which sheets there are, and
   * what is on the one being looked at.
   *
   * This is also where the active sheet is kept honest, and it has to be: a
   * peer can delete the sheet you are reading, and a peer who has just joined
   * has no sheets at all until the room's snapshot arrives a moment later.
   * Falling back to the first sheet covers both — including the case where the
   * first sheet you ever see arrives over the network.
   */
  private refresh(): void {
    const round = this.state.round;
    const sheets = round.sheets();
    const active =
      this.state.activeSheet && sheets.some((s) => s.id === this.state.activeSheet)
        ? this.state.activeSheet
        : (sheets[0]?.id ?? null);
    const flow = active ? round.flow(active) : null;
    this.patch({
      sheets,
      activeSheet: active,
      flow,
      roots: flow ? flow.roots() : [],
    });
    if (active !== this.local.sheet) this.setLocal({ sheet: active });
  }

  /** Look at a different sheet. Local to this peer, and published as presence. */
  setActiveSheet(sheetId: string): void {
    if (sheetId === this.state.activeSheet || !this.state.round.has(sheetId)) return;
    const flow = this.state.round.flow(sheetId);
    this.patch({ activeSheet: sheetId, flow, roots: flow.roots() });
    this.setLocal({ sheet: sheetId });
  }

  /* ---- the wire --------------------------------------------------------- */

  private connect(room: string): void {
    this.disconnect();
    this.patch({ room, error: null });

    const connect = this.options.connect ?? websocketTransport;
    this.transport = connect(this.state.relayUrl, {
      onOpen: () => this.hello(room),
      onMessage: (message) => this.receive(message),
      onStatus: (status) => this.patch({ status }),
    });

    // Presence is a heartbeat, not a state: a peer that stops sending is gone,
    // which is the only way to notice a laptop that closed mid-round.
    this.heartbeat = setInterval(() => this.publish(), HEARTBEAT_MS);
  }

  private disconnect(): void {
    if (this.heartbeat !== null) clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.transport?.close();
    this.transport = null;
  }

  /**
   * Everything that has to be said on a new connection, in order: who we are,
   * the whole document, and where our cursor is.
   *
   * The document goes as a full snapshot rather than as updates since some
   * remembered version, and that is the point of using a CRDT: the relay merges
   * it against whatever it has, duplicates cost nothing, and there is no
   * bookkeeping to get wrong when the reconnecting peer is the one that has
   * been offline writing arguments.
   */
  private hello(room: string): void {
    const round = this.state.round;
    this.send({ t: "join", room, peer: round.peerId, role: this.role });
    this.send({ t: "doc", data: encodeBytes(round.export()) });
    this.send({ t: "presence", data: encodeBytes(this.presence.encodeAll()) });
    this.publish();
  }

  private receive(message: ServerMessage): void {
    switch (message.t) {
      case "welcome": {
        if (message.doc) {
          this.state.round.import(decodeBytes(message.doc));
          // The room as it stands is the floor. Undo may walk back over your own
          // edits from here, never into the room's history before you arrived.
          this.state.round.clearHistory();
        }
        break;
      }
      case "doc":
        this.state.round.import(decodeBytes(message.data));
        break;
      case "presence":
        this.presence.apply(decodeBytes(message.data));
        break;
      case "gone":
        this.presence.delete(message.peer);
        break;
      case "error":
        this.patch({ error: message.reason });
        break;
    }
  }

  private send(message: ClientMessage): void {
    this.transport?.send(message);
  }

  /**
   * Write this peer's presence into the store, which broadcasts it. Stamped
   * with the time on every call, so a heartbeat is never mistaken for a
   * repetition and dropped — see `Presence.at`.
   */
  private publish(): void {
    if (!this.transport) return;
    this.presence.set(this.state.round.peerId, { ...this.local, at: Date.now() });
  }

  /* ---- state ------------------------------------------------------------ */

  /** Everyone in the store except us, in a stable order so nothing jumps. */
  private readPeers(): void {
    const mine = this.state.round.peerId;
    const states = this.presence.getAllStates();
    const peers = Object.entries(states)
      .filter(([id, presence]) => id !== mine && presence)
      .map(([id, presence]) => toPeer(id, presence as Presence))
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    // Heartbeats arrive whether or not anything moved, and every one of them
    // would otherwise re-render the sheet on a timer. Compared by what is
    // actually drawn, so the timestamp that makes a heartbeat a heartbeat
    // doesn't count as news.
    if (drawnAs(peers) === drawnAs(this.state.peers)) return;
    this.patch({ peers });
  }

  private patch(next: Partial<SessionState>): void {
    this.state = { ...this.state, ...next };
    for (const listener of this.listeners) listener();
  }
}

/** Everything about a set of peers that the sheet actually draws. */
function drawnAs(peers: Peer[]): string {
  return peers
    .map((p) => `${p.id}:${p.name}:${p.sheet}:${p.cursorId}:${p.editing}`)
    .join("|");
}
