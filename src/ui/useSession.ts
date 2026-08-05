import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { Round } from "../model/round";
import { formatInvitation, isRoomCode, RELAY_PORT, relayUrlFor } from "../sync/protocol";
import { loadName, saveName } from "../sync/presence";
import {
  canHost,
  clearRelayUrl,
  hostAddressOf,
  hostFromUrl,
  hostingInfo,
  loadRelayUrl,
  saveRelayUrl,
  startHosting,
  stopHosting,
  type RelayInfo,
} from "../sync/relay";
import { FlowSession, type SessionState } from "../sync/session";

/**
 * The session, as React sees it.
 *
 * `useSyncExternalStore` rather than state and effects, because the session is
 * already a store — it has to be, since it outlives any render and changes for
 * reasons React never hears about (a peer's cursor moving, a socket dropping).
 * The hook's job is the three things React genuinely owns: when the store is
 * subscribed to, the address bar, and — because it is a desktop app talking to
 * its own Rust half — whether this copy is hosting.
 */

export interface SessionActions {
  /** Publish this flow into a new room on the relay we're pointed at. */
  share: () => void;
  /**
   * Host a relay in this app and share into it. The one-step version of
   * `:share`, and the one to reach for: it needs no server to have been set up
   * anywhere, which is the whole difficulty with the other one.
   */
  host: () => void;
  /** Join by invitation — `192.168.1.42/k7fmqp`, or a bare code. */
  join: (invitation: string) => void;
  /** Leave the room, and stop hosting if this app was. */
  leave: () => void;
  rename: (name: string) => void;
  /** Point at a relay somebody else is running. Empty resets to the default. */
  useRelay: (host: string) => void;
  /** Tell the room where this peer's cursor is. */
  setLocal: (update: {
    cursorId?: string | null;
    editing?: boolean;
    speech?: number | null;
  }) => void;

  /* ---- sheets ---- */
  /** Look at a different sheet. */
  openSheet: (sheetId: string) => void;
  /** Start a sheet and open it. Returns its id. */
  addSheet: (title: string) => string;
  renameSheet: (sheetId: string, title: string) => void;
  /** Delete a sheet and everything on it. Undo brings it back. */
  removeSheet: (sheetId: string) => void;
  /** Shift a sheet earlier or later in the order. */
  moveSheet: (sheetId: string, by: number) => void;
}

export interface UseSession extends SessionState {
  round: Round;
  /** Where this app is hosting, or null when it isn't. */
  hosting: RelayInfo | null;
  /** Whether hosting is possible at all — false in a browser tab. */
  canHost: boolean;
  /**
   * The one string to read out so somebody else can join, or null when there
   * is no room. Carries the address as well as the code, so the person typing
   * it needs nothing else.
   */
  invitation: string | null;
  actions: SessionActions;
}

export function useSession(seed?: (round: Round) => void): UseSession {
  const sessionRef = useRef<FlowSession | null>(null);
  if (sessionRef.current === null) {
    sessionRef.current = new FlowSession({
      relayUrl: loadRelayUrl(defaultRelayUrl()),
      name: loadName(),
      seed,
    });
  }
  const session = sessionRef.current;

  const subscribe = useCallback((listener: () => void) => session.subscribe(listener), [session]);
  const state = useSyncExternalStore(subscribe, session.getState, session.getState);

  const [hosting, setHosting] = useState<RelayInfo | null>(null);

  // A room in the address is a room to be in: it is what a shared link is, and
  // what survives the reload a desktop app does on every rebuild.
  useEffect(() => {
    const fromHash = invitationFromHash();
    if (fromHash) session.join(fromHash);
    session.resume();
    // The app may already be hosting from before this mount — a hot reload, or
    // StrictMode's second pass. The Rust side is the authority on that.
    //
    // Wrapped rather than only `.catch`ed: this is a call across into another
    // language, and the failure that matters is the one where it doesn't get
    // far enough to return a promise at all. Nothing here is worth taking the
    // sheet down for — see the history effect below.
    if (canHost()) {
      try {
        hostingInfo().then(setHosting, () => {});
      } catch {
        // Not hosting, then.
      }
    }

    const onHashChange = () => {
      const invitation = invitationFromHash();
      if (invitation) session.join(invitation);
      else session.leave();
    };
    window.addEventListener("hashchange", onHashChange);
    return () => {
      window.removeEventListener("hashchange", onHashChange);
      // Suspended, not destroyed — see `FlowSession.suspend`. The relay is
      // deliberately left running: it belongs to the app, not to this mount,
      // and taking it down here would drop every peer on a hot reload.
      session.suspend();
    };
  }, [session]);

  // The other direction: the room the session is actually in is what the
  // address should say. Written without a history entry, so the back gesture
  // doesn't walk through every room you have been in.
  //
  // Only where there is an address to write. The packaged app is served from
  // `tauri://localhost`, and WebKit treats a custom scheme as an origin it will
  // not let you rewrite the history of — `replaceState` throws there. Thrown
  // from an effect, that took React's root down with it and left the window
  // blank: the whole sheet lost to keeping a URL tidy that the desktop app
  // doesn't even show. The `try` is the second half of the same thought —
  // nothing about an address bar is worth a blank window.
  useEffect(() => {
    if (!window.location.protocol.startsWith("http")) return;
    const want = state.room ? `#${state.room}` : "";
    if (window.location.hash === want) return;
    const url = `${window.location.pathname}${window.location.search}${want}`;
    try {
      window.history.replaceState(null, "", url || window.location.pathname);
    } catch {
      // A link to this room is a browser convenience, and this is one of the
      // browsers where it isn't available.
    }
  }, [state.room]);

  const actions = useMemo<SessionActions>(
    () => ({
      share: () => session.share(),

      host: () => {
        if (!canHost()) {
          // A browser tab can join anything; it has nowhere to put a listening
          // socket. Said plainly, because the alternative is a peer sitting
          // there wondering why nothing happened.
          session.reportError("hosting needs the desktop app — try :relay <address>");
          return;
        }
        // Point at our own relay before opening the room: `share` connects
        // immediately, and connecting to the address we are about to stop
        // using would only mean a reconnect a moment later.
        startHosting()
          .then((info) => {
            setHosting(info);
            session.setRelayUrl(`ws://127.0.0.1:${info.port}`);
            session.share();
          })
          .catch((error) => session.reportError(String(error)));
      },

      join: (invitation: string) => session.join(invitation),

      leave: () => {
        session.leave();
        // Hosting is what `:solo` ends as much as the room is — you are the
        // relay, and staying up after leaving would hold a socket open for a
        // room you are no longer in.
        if (hosting) {
          stopHosting().catch(() => {});
          setHosting(null);
        }
      },

      rename: (name: string) => {
        saveName(name);
        session.rename(name);
      },

      useRelay: (host: string) => {
        const url = host.trim() ? relayUrlFor(host.trim()) : defaultRelayUrl();
        if (host.trim()) saveRelayUrl(url);
        else clearRelayUrl();
        session.setRelayUrl(url);
      },

      setLocal: (update) => session.setLocal(update),

      openSheet: (sheetId: string) => session.setActiveSheet(sheetId),

      addSheet: (title: string) => {
        const id = session.state.round.addSheet(title);
        // Opened straight away: you made a sheet because there is an argument
        // to put on it, and the next thing you do is put it there.
        session.setActiveSheet(id);
        return id;
      },

      renameSheet: (sheetId: string, title: string) =>
        session.state.round.renameSheet(sheetId, title),

      removeSheet: (sheetId: string) => session.state.round.removeSheet(sheetId),

      moveSheet: (sheetId: string, by: number) => {
        const sheets = session.state.sheets;
        const at = sheets.findIndex((sheet) => sheet.id === sheetId);
        if (at >= 0) session.state.round.moveSheet(sheetId, at + by);
      },
    }),
    [session, hosting],
  );

  // What to read out. Hosting is the case worth getting right: the session is
  // pointed at its own loopback address, which is true and useless to anybody
  // else, so the invitation carries the address the machine has on the network
  // instead.
  const invitation = useMemo(() => {
    if (!state.room) return null;
    const host = hosting ? hostAddressOf(hosting) : hostFromUrl(state.relayUrl);
    return formatInvitation({ room: state.room, host });
  }, [state.room, state.relayUrl, hosting]);

  return { ...state, hosting, canHost: canHost(), invitation, actions };
}

/** The invitation in the address bar, if there is a well-formed one. */
function invitationFromHash(): string | null {
  const hash = window.location.hash.replace(/^#/, "").trim().toLowerCase();
  if (!hash) return null;
  // Either `#code` or `#host/code` — the same string `:join` takes.
  const room = hash.slice(hash.lastIndexOf("/") + 1);
  return isRoomCode(room) ? hash : null;
}

/**
 * Where the relay is before anybody says otherwise.
 *
 * Only a starting point now: the address is a setting the app can change while
 * it runs (see `useRelay` and `sync/relay.ts`), which is what it has to be for
 * a packaged app whose peers aren't known at build time. `VITE_FLOW_RELAY`
 * still sets the default, for a build that ships pointed at a relay you run.
 * Failing that, the machine the app is on: the desktop build is served from
 * `tauri://localhost`, whose hostname names nothing on a network, so it is
 * spelled out rather than derived.
 */
export function defaultRelayUrl(): string {
  const configured = import.meta.env?.VITE_FLOW_RELAY;
  if (configured) return configured;
  const onHttp = window.location.protocol.startsWith("http");
  const host = onHttp && window.location.hostname ? window.location.hostname : "127.0.0.1";
  return `ws://${host}:${RELAY_PORT}`;
}
