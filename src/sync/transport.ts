import type { ClientMessage, ServerMessage } from "./protocol";

/**
 * The wire, as the session sees it: somewhere to send messages, somewhere they
 * arrive from, and a status.
 *
 * An interface rather than a WebSocket directly because the session shouldn't
 * know what it's talking over. Today there is one implementation; the ones
 * worth leaving room for are a `BroadcastChannel` (two windows on one machine,
 * no server), and an in-process pipe — which is how an assistant flowing a
 * round could run inside the app rather than across a network, without the
 * session being written twice.
 */

export type ConnectionStatus =
  /** Not trying to be connected. */
  | "offline"
  /** First attempt, or an attempt after the connection dropped. */
  | "connecting"
  /** Connected, and the room has been joined. */
  | "online"
  /** Dropped, waiting out the backoff before trying again. */
  | "retrying";

export interface Transport {
  send(message: ClientMessage): void;
  close(): void;
}

export interface TransportHandlers {
  /**
   * The connection is up. Whatever has to be said before anything else — the
   * `join`, and the snapshot that follows it — is said here, because it has to
   * be said again after every reconnect and this is the one place that knows a
   * reconnect happened.
   */
  onOpen(): void;
  onMessage(message: ServerMessage): void;
  onStatus(status: ConnectionStatus): void;
}

/** Backoff between reconnection attempts: doubling, capped, from a half-second. */
const RETRY_MIN_MS = 500;
const RETRY_MAX_MS = 10_000;

export interface WebSocketOptions {
  /**
   * The WebSocket constructor to use. Browsers and Node 22+ both have one
   * globally; this is for a headless peer on a runtime that doesn't, which can
   * pass `ws`'s.
   */
  WebSocketImpl?: typeof WebSocket;
}

/**
 * A relay connection that keeps trying.
 *
 * Reconnection is not a nicety here: a flow is written in the twenty minutes
 * where nobody can stop to fix anything, over conference-room wifi. Messages
 * sent while the socket is down are dropped rather than queued — every one of
 * them is either a CRDT update, which the snapshot sent on reconnect makes good
 * anyway, or presence, which is worthless by the time it would be delivered.
 */
export function websocketTransport(
  url: string,
  handlers: TransportHandlers,
  options: WebSocketOptions = {},
): Transport {
  const Impl = options.WebSocketImpl ?? WebSocket;
  let socket: WebSocket | null = null;
  let retryMs = RETRY_MIN_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  const open = () => {
    if (closed) return;
    handlers.onStatus("connecting");
    let ws: WebSocket;
    try {
      ws = new Impl(url);
    } catch {
      // A malformed URL, or a scheme the runtime won't open. Retrying is still
      // right — the URL can be corrected while the app runs.
      retry();
      return;
    }
    socket = ws;
    ws.binaryType = "arraybuffer";

    ws.onopen = () => {
      retryMs = RETRY_MIN_MS;
      handlers.onStatus("online");
      handlers.onOpen();
    };

    ws.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      let message: ServerMessage;
      try {
        message = JSON.parse(event.data) as ServerMessage;
      } catch {
        return; // not ours; the alternative is taking the connection down
      }
      handlers.onMessage(message);
    };

    // Both paths end the same way. `onerror` fires before `onclose` on a failed
    // connection, so the retry is scheduled from `onclose` alone.
    ws.onerror = () => {};
    ws.onclose = () => {
      if (socket === ws) socket = null;
      retry();
    };
  };

  const retry = () => {
    if (closed || timer !== null) return;
    handlers.onStatus("retrying");
    timer = setTimeout(() => {
      timer = null;
      open();
    }, retryMs);
    retryMs = Math.min(RETRY_MAX_MS, retryMs * 2);
  };

  open();

  return {
    send(message) {
      if (socket?.readyState === 1) socket.send(JSON.stringify(message));
    },
    close() {
      closed = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      const ws = socket;
      socket = null;
      // Detached first: closing fires `onclose`, and this one is not a drop to
      // recover from.
      if (ws) {
        ws.onclose = null;
        ws.onerror = null;
        ws.onmessage = null;
        ws.close();
      }
      handlers.onStatus("offline");
    },
  };
}
