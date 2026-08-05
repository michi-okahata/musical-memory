import type { Role } from "../model/types";

/**
 * Who else is on the sheet, and where.
 *
 * Presence is not the document: it is thrown away when a peer disconnects, and
 * it is never undoable. Where a partner's cursor is has no business in the
 * history of a round. Loro's `EphemeralStore` carries it (see session.ts) —
 * last-write-wins per peer, with a timeout that reaps whoever stops speaking.
 */

/**
 * What a peer publishes about itself. Flat and small: it is sent on every move.
 *
 * A type alias rather than an interface so it satisfies Loro's `Value` — an
 * interface has no implicit index signature, and presence has to be a thing the
 * ephemeral store can encode.
 */
export type Presence = {
  name: string;
  role: Role;
  /**
   * The sheet they are looking at. Null before they have one.
   *
   * The single most useful thing presence carries once a round is more than one
   * sheet: your partner working two positions away is invisible on the sheet
   * you're reading, and "they're on the politics DA" is the answer to where
   * everybody is that you actually want mid-round.
   */
  sheet: string | null;
  /** The argument their cursor is on, or null if they have no cursor yet. */
  cursorId: string | null;
  /** Whether they are inside that argument, typing. */
  editing: boolean;
  /**
   * The speech column they are working in. Not derivable from `cursorId` by
   * anyone who hasn't got that argument yet — which is exactly the moment you
   * want to know, since a peer flowing the 2NC is about to send you arguments
   * you've never seen.
   */
  speech: number | null;
  /**
   * When this was last published, by the publisher's own clock.
   *
   * Not read by anything — it is here to make every heartbeat a *different*
   * value. The ephemeral store forwards a state that changed, and a peer
   * reading one argument for a minute publishes the same presence every time,
   * so without this its heartbeats would be deduplicated into silence and the
   * others would time it out while it sat there. Never compared between peers,
   * whose clocks have no reason to agree.
   */
  at: number;
};

/** A peer as the sheet draws it: their presence, plus who they are. */
export type Peer = Presence & {
  /** Their Loro peer id — the key their presence is published under. */
  id: string;
  /** A colour derived from that id, stable everywhere it's drawn. */
  color: string;
};

/**
 * A peer's colour, from their id.
 *
 * Derived rather than assigned because nothing here allocates: two peers pick
 * their colours without talking, and a peer looks the same on every sheet in
 * the room. Hue only — the saturation and lightness are fixed, and low, so a
 * peer marker sits in the same register as the rest of the sheet instead of
 * competing with the cursor for attention.
 */
export function peerColor(id: string, role: Role = "human"): string {
  // An assistant is not given a hue of its own to be lost among the others: it
  // is the one peer you want to be able to pick out of a sheet without reading
  // a name, because what it wrote is the part you have to check.
  if (role === "ai") return "hsl(172 42% 42%)";
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return `hsl(${hash % 360} 45% 48%)`;
}

/** Fill out a raw presence record into something drawable. */
export function toPeer(id: string, presence: Presence): Peer {
  return { ...presence, id, color: peerColor(id, presence.role) };
}

/* ---- this peer's name ---------------------------------------------------
   Kept out of the document and out of the session: it is a property of the
   person, not of the round, and it should be the same next time they open the
   app. */

const NAME_KEY = "flow.peer.name";

/**
 * Names for a peer who hasn't chosen one. Debate words, so an unnamed partner
 * still reads as somebody rather than as "user 2" — and short, because the name
 * is drawn at 10px next to their cursor.
 */
const DEFAULT_NAMES = [
  "impact",
  "warrant",
  "uniqueness",
  "turn",
  "brink",
  "spike",
  "voter",
  "kritik",
  "topicality",
  "overview",
];

export function loadName(storage?: Storage): string {
  const store = storage ?? safeStorage();
  const saved = store?.getItem(NAME_KEY);
  if (saved) return saved;
  const name = DEFAULT_NAMES[Math.floor(Math.random() * DEFAULT_NAMES.length)];
  store?.setItem(NAME_KEY, name);
  return name;
}

export function saveName(name: string, storage?: Storage): void {
  (storage ?? safeStorage())?.setItem(NAME_KEY, name);
}

/** `localStorage` throws rather than returns null in a few configurations. */
function safeStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}
