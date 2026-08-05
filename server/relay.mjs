import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LoroDoc } from "loro-crdt";
import { WebSocketServer } from "ws";

/**
 * The relay: one process, one room per code, no accounts.
 *
 * It does two things. It forwards — every message from a peer goes to everyone
 * else in that room, and nothing else. And it remembers — it keeps each room's
 * document merged in memory and on disk, so the third person to arrive gets the
 * flow even if the first two have gone home, and so a round survives the
 * process restarting.
 *
 * It does not understand a flow. The document is a Loro blob it merges and
 * re-exports; the relay has no idea what an argument is, which is what lets the
 * sheet's model change without the server being redeployed.
 *
 * ---- writing another peer ------------------------------------------------
 * Anything that speaks this protocol is a peer, including something with no
 * screen. An assistant that transcribes a speech into arguments would connect
 * here exactly as the app does: open a socket, send
 *
 *   { "t": "join", "room": "<code>", "peer": "<loro peer id>", "role": "ai" }
 *
 * then send `{ "t": "doc", "data": "<base64 loro update>" }` as it writes into
 * its own `Flow`, and `{ "t": "presence", … }` so the sheet can show where it
 * is working. `src/model/flow.ts` and `src/sync/session.ts` are free of the DOM
 * for this reason — the same session class runs here.
 */

const PORT = Number(process.env.FLOW_RELAY_PORT ?? 1421);
const DATA_DIR = process.env.FLOW_RELAY_DATA ?? ".flow-rooms";
/** How long after the last change a room is written to disk. */
const SAVE_DEBOUNCE_MS = 2_000;

const ROOM_ALPHABET = "bcdfghjkmnpqrstvwxyz23456789";
const ROOM_LENGTH = 6;

/** A room code becomes a filename, so it is validated rather than sanitised. */
const isRoomCode = (code) =>
  typeof code === "string" &&
  code.length === ROOM_LENGTH &&
  [...code].every((c) => ROOM_ALPHABET.includes(c));

mkdirSync(DATA_DIR, { recursive: true });

/** code -> { doc, clients: Set<ws>, saveTimer } */
const rooms = new Map();

function openRoom(code) {
  const existing = rooms.get(code);
  if (existing) return existing;

  const doc = new LoroDoc();
  const path = join(DATA_DIR, `${code}.loro`);
  if (existsSync(path)) {
    try {
      doc.import(new Uint8Array(readFileSync(path)));
    } catch (error) {
      // A snapshot we can't read is worse than none: starting empty lets the
      // room work, and the peers still hold the flow between them.
      console.error(`[relay] ${code}: unreadable snapshot, starting empty`, error);
    }
  }
  // Whether this room's document has ever been written to. Tracked rather than
  // asked of the document, because asking would mean knowing what an empty flow
  // looks like — the one thing the relay is built not to know.
  const written = existsSync(path);
  const room = { doc, path, clients: new Set(), saveTimer: null, written };
  rooms.set(code, room);
  return room;
}

function save(room) {
  if (room.saveTimer) return;
  room.saveTimer = setTimeout(() => {
    room.saveTimer = null;
    try {
      writeFileSync(room.path, Buffer.from(room.doc.export({ mode: "snapshot" })));
    } catch (error) {
      console.error(`[relay] could not save ${room.path}`, error);
    }
  }, SAVE_DEBOUNCE_MS);
}

function broadcast(room, from, message) {
  const payload = JSON.stringify(message);
  for (const client of room.clients) {
    if (client !== from && client.readyState === 1) client.send(payload);
  }
}

const send = (ws, message) => {
  if (ws.readyState === 1) ws.send(JSON.stringify(message));
};

const server = new WebSocketServer({ port: PORT });

server.on("connection", (ws) => {
  // Set by `join`; until then the connection belongs to no room and anything
  // else it says is ignored.
  ws.room = null;
  ws.peer = null;

  ws.on("message", (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (message.t === "join") {
      if (!isRoomCode(message.room)) {
        send(ws, { t: "error", reason: "bad room code" });
        return;
      }
      leaveRoom(ws);
      const room = openRoom(message.room);
      ws.room = room;
      ws.peer = typeof message.peer === "string" ? message.peer : null;
      room.clients.add(ws);
      send(ws, {
        t: "welcome",
        room: message.room,
        doc: room.written
          ? Buffer.from(room.doc.export({ mode: "snapshot" })).toString("base64")
          : null,
      });
      console.log(`[relay] ${message.room}: ${room.clients.size} peer(s)`);
      return;
    }

    const room = ws.room;
    if (!room) return;

    if (message.t === "doc" && typeof message.data === "string") {
      try {
        room.doc.import(new Uint8Array(Buffer.from(message.data, "base64")));
      } catch (error) {
        // Still forwarded: the peers can merge what the relay's own copy
        // choked on, and a room that keeps working is worth more than a
        // relay whose snapshot is complete.
        console.error(`[relay] bad update`, error);
      }
      room.written = true;
      save(room);
      broadcast(room, ws, message);
      return;
    }

    if (message.t === "presence" && typeof message.data === "string") {
      broadcast(room, ws, message);
    }
  });

  ws.on("close", () => leaveRoom(ws));
  ws.on("error", () => leaveRoom(ws));
});

function leaveRoom(ws) {
  const room = ws.room;
  if (!room) return;
  room.clients.delete(ws);
  ws.room = null;
  // Presence expires on its own, but not for half a minute — telling the room
  // now is what takes a closed laptop's cursor off the sheet immediately.
  if (ws.peer) broadcast(room, ws, { t: "gone", peer: ws.peer });
}

console.log(`[relay] listening on ws://0.0.0.0:${PORT}, rooms in ${DATA_DIR}/`);
