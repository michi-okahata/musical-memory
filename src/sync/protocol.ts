import type { Role } from "../model/types";

/**
 * What a peer and the relay say to each other.
 *
 * Deliberately small, deliberately JSON. The relay never interprets a flow — it
 * merges opaque CRDT bytes and hands them on — so the protocol only has to name
 * three things: which room you want, document bytes, and presence bytes.
 *
 * JSON with base64 payloads rather than a binary framing, because the thing
 * this protocol has to survive is being implemented a second time. A future
 * assistant that flows a round — writing arguments as it transcribes a speech —
 * is a peer like any other: it opens a socket, says `join`, and sends `doc`
 * messages. Anything that can speak JSON and merge Loro bytes can be one, and
 * you can read the traffic to see what it did.
 */

/** The port the relay listens on by default: the dev server's, plus one. */
export const RELAY_PORT = 1421;

/**
 * The alphabet room codes are drawn from — no vowels (so a code can't spell
 * anything), and no `i`/`l`/`o`/`0`/`1`, which are the pairs people mishear and
 * mistype when a code is read out across a table.
 */
export const ROOM_ALPHABET = "bcdfghjkmnpqrstvwxyz23456789";
export const ROOM_LENGTH = 6;

/** Whether `code` is a well-formed room code. The relay is strict about this:
    a room code becomes a filename, so anything else is refused rather than
    sanitised. */
export function isRoomCode(code: string): boolean {
  return (
    code.length === ROOM_LENGTH &&
    [...code].every((c) => ROOM_ALPHABET.includes(c))
  );
}

/** A fresh room code. */
export function newRoomCode(random: () => number = Math.random): string {
  let code = "";
  for (let i = 0; i < ROOM_LENGTH; i++) {
    code += ROOM_ALPHABET[Math.floor(random() * ROOM_ALPHABET.length)];
  }
  return code;
}

/**
 * Where a room is and what it is called, as one string: `192.168.1.42/k7fmqp`,
 * or just `k7fmqp` for a room on the relay you are already pointed at.
 *
 * One token because a debater has to say this out loud to somebody across a
 * table, ten minutes before a round, and two things to type is how one of them
 * gets typed wrong. The host's own status line shows exactly the string the
 * other person needs, so it is read off and typed in with nothing in between.
 */
export interface Invitation {
  room: string;
  /** The relay's host — with a port if it isn't the default. Null means "the
      one already configured", which is what a bare code means. */
  host: string | null;
}

export function formatInvitation({ room, host }: Invitation): string {
  return host ? `${host}/${room}` : room;
}

/**
 * Read an invitation. Accepts the bare code, `host/code`, `host:port/code`,
 * and a whole `ws://host:port/#code` — because what somebody pastes is
 * whatever they had, and refusing it teaches nothing.
 */
export function parseInvitation(text: string): Invitation | null {
  const cleaned = text.trim().toLowerCase().replace(/^wss?:\/\//, "");
  const parts = cleaned.split(/[/#]/).filter(Boolean);
  if (parts.length === 0) return null;
  const room = parts[parts.length - 1];
  if (!isRoomCode(room)) return null;
  return { room, host: parts.length > 1 ? parts[parts.length - 2] : null };
}

/** The relay URL a host names. A bare host takes the default port. */
export function relayUrlFor(host: string): string {
  const withScheme = /^wss?:\/\//.test(host) ? host : `ws://${host}`;
  return /:\d+$/.test(withScheme) ? withScheme : `${withScheme}:${RELAY_PORT}`;
}

export type ClientMessage =
  /**
   * Always first, and again after every reconnect. `peer` is the sender's Loro
   * peer id — the same id its ops carry and its presence is keyed by, so the
   * relay can tell the room who left without knowing anything about presence.
   */
  | { t: "join"; room: string; peer: string; role: Role }
  /** CRDT bytes: a snapshot on joining, incremental updates after. */
  | { t: "doc"; data: string }
  /** Ephemeral state: who is where, and who is typing. */
  | { t: "presence"; data: string };

export type ServerMessage =
  /** The room as it stands. `doc` is null for a room nobody has written yet. */
  | { t: "welcome"; room: string; doc: string | null }
  | { t: "doc"; data: string }
  | { t: "presence"; data: string }
  /**
   * A peer disconnected. Presence expires on its own, but only after a timeout
   * long enough to keep a stale cursor on the sheet for half a minute — this is
   * what makes someone closing their laptop show up immediately.
   */
  | { t: "gone"; peer: string }
  | { t: "error"; reason: string };

/* ---- base64 -------------------------------------------------------------
   Both ends of this protocol run in both places: the app in a browser (and in
   a WKWebView), the relay and any headless peer in Node. `btoa`/`atob` are the
   pair both have, which is why they're used here in preference to Node's own
   `Buffer`, faster though it is on a large flow. */

export function encodeBytes(bytes: Uint8Array): string {
  let binary = "";
  // In chunks: `apply` on a several-hundred-kilobyte flow would blow the
  // argument limit.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function decodeBytes(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
