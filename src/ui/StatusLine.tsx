import React from "react";
import { CommandLine } from "./CommandLine";
import type { Mark } from "../model/types";
import type { Peer } from "../sync/presence";
import type { ConnectionStatus } from "../sync/transport";

/**
 * A status line rather than a banner: the sheet is what the screen is for, and
 * a hint above it pushed the first speech down the page.
 *
 * It shows three things, left to right — the pending count, what the keys do
 * (or the command line, which takes that space over), and which modes are on.
 */

// The keymap, as it appears on the status line: key, then what it does. A list
// rather than prose so the line stays one shape — every key in the sheet's ink,
// every gloss in the status line's grey, and the separators quieter than both.
const HINTS: [key: string, does: string][] = [
  ["hjkl", "move"],
  ["[/]", "sheet"],
  [":2ac", "speech"],
  ["a", "answer"],
  ["o/O", "below/above"],
  ["n/N", "new argument"],
  ["i", "edit"],
  ["Tab", "complete"],
  ["f", "focus"],
  ["v", "select"],
  ["#", "1./a./–"],
  ["J/K", "move sel"],
  ["⌘+/-", "zoom"],
  ["x", "delete"],
  ["u", "undo"],
  [":new", "sheet"],
  [":host", "flow together"],
];

interface StatusLineProps {
  /** Digits typed but not yet spent, echoed so a half-typed `10j` is visible. */
  count: number | null;
  /** The command line's contents while it's open, or null when it isn't. */
  command: string | null;
  editing: boolean;
  /**
   * Whether a visual selection is open, and how many arguments it covers.
   *
   * Two values rather than one, because they can disagree for a tick: the
   * anchor is editor state, the size is derived from the layout, and the
   * layout trails the document by a render (Loro delivers its change events
   * asynchronously). The chip follows the anchor — that's the state the line
   * is reporting — and only the wording follows the count.
   */
  selecting: boolean;
  selectionSize: number;
  /** How the cursor's own argument is marked. */
  mark: Mark;
  /** The pinned speech's name, or null when the whole flow is shown. */
  focusLabel: string | null;
  zoom: number;
  /** The room code, or null when flowing alone. */
  room: string | null;
  status: ConnectionStatus;
  /**
   * The one string somebody else has to type to get here — the address and the
   * code together. Shown in place of the bare code, because the code alone is
   * only half of what the other person needs and the half they'd have to ask
   * for is the one nobody knows off the top of their head.
   */
  invitation: string | null;
  /** Whether this app is the relay the room is on. */
  hosting: boolean;
  /** The last thing that went wrong: a bad code, a relay that won't start. */
  error: string | null;
  /** Everyone else in the room. */
  peers: Peer[];
  /**
   * Who wrote the argument the cursor is on, when that wasn't you. Null the
   * rest of the time — on a flow you are writing by yourself, every argument
   * is yours, and saying so on every keystroke would be noise.
   */
  authorLabel: string | null;
  onCommandChange: (text: string) => void;
  onCommandSubmit: () => void;
  onCommandCancel: () => void;
}

/** What the room chip says about the connection. */
const STATUS_TEXT: Record<ConnectionStatus, string> = {
  offline: "offline",
  connecting: "connecting",
  online: "",
  retrying: "reconnecting",
};

export function StatusLine({
  count,
  command,
  editing,
  selecting,
  selectionSize,
  mark,
  focusLabel,
  zoom,
  room,
  status,
  invitation,
  hosting,
  error,
  peers,
  authorLabel,
  onCommandChange,
  onCommandSubmit,
  onCommandCancel,
}: StatusLineProps): React.ReactElement {
  return (
    <footer className="app__status">
      <span className="app__count">{count ?? ""}</span>

      {command !== null ? (
        <CommandLine
          value={command}
          onChange={onCommandChange}
          onSubmit={onCommandSubmit}
          onCancel={onCommandCancel}
        />
      ) : (
        <span className="app__hint">
          {HINTS.map(([key, what], i) => (
            <span key={key}>
              {i > 0 && <i> · </i>}
              <kbd>{key}</kbd> {what}
            </span>
          ))}
        </span>
      )}

      {/* The room, and everyone in it. First of the right-hand group, because
          it is the only thing on this line that is true of the *document*
          rather than of how you happen to be looking at it — and because the
          code is what you read out to get somebody else onto the sheet.

          Shown at all only once there is a room: flowing alone is the ordinary
          case and needs no chip to say so. */}
      {room !== null && (
        <span
          className={`app__room is-${status}${hosting ? " is-hosting" : ""}`}
          title={
            hosting
              ? "this app is hosting the room — read this out to whoever is joining"
              : "read this out to whoever is joining"
          }
        >
          <i className="app__room-dot" />
          {STATUS_TEXT[status] || invitation || room}
        </span>
      )}

      {/* What went wrong, where the room chip would be if there were a room:
          the things that fail here are all about getting into one. It stays
          until the next thing happens rather than fading — a message you have
          to catch is a message you miss. */}
      {error !== null && room === null && <span className="app__error">{error}</span>}

      {/* Who else is here, by name. The sheet says where they are; this says
          that they arrived at all — which is the part you can't see when your
          partner is working three speeches away, or when the assistant is
          connected and hasn't written anything yet.

          A dot in their colour rather than a filled tag, because the same
          colour is doing louder work out on the sheet and this is a roll
          call. */}
      {peers.length > 0 && (
        <span className="app__peers">
          {peers.map((peer) => (
            <span
              key={peer.id}
              className={`app__peer${peer.editing ? " is-editing" : ""}`}
              title={peer.editing ? `${peer.name} is writing` : peer.name}
            >
              <i className="app__peer-dot" style={{ background: peer.color }} />
              {peer.name}
            </span>
          ))}
        </span>
      )}

      {/* Who wrote what the cursor is on, when it wasn't you. The one place the
          sheet attributes an argument: a marker per argument would turn a flow
          into a changelog, and this answers the same question at the moment you
          are actually asking it. It is also where an argument written by an
          assistant declares itself. */}
      {authorLabel !== null && <span className="app__mode">by {authorLabel}</span>}

      {/* Edit mode, first of all — every other key on the line stops doing
          what the hints say the moment it's on, since the textarea owns the
          keyboard instead (see useKeymap.ts), and that's the one state a
          status line exists to not let you forget you're in. */}
      {editing && <span className="app__mode">edit</span>}

      {/* Visual mode, next — it's the newest of what's left and the one most
          likely to be forgotten about, so it goes where the eye lands first
          among the rest of the chips. Named "select" until there's something
          to count: `v` alone hasn't ranged over anything yet, and "1 selected"
          would be true of every cursor all the time. */}
      {selecting && (
        <span className="app__mode">
          {selectionSize > 1 ? `${selectionSize} selected` : "select"}
        </span>
      )}

      {/* Only when the cursor's own argument isn't marked the ordinary way, on
          the same terms as the zoom below: the default says nothing worth a
          chip, and the two that aren't the default are invisible on a run that
          has only one argument so far. */}
      {mark !== "num" && (
        <span className="app__mode">{mark === "alpha" ? "a. b. c." : "no marks"}</span>
      )}

      {/* Naming the pinned speech matters now that it doesn't follow the
          cursor — it's the difference between "focus is on" and knowing which
          three columns you're inside. */}
      {focusLabel !== null && <span className="app__mode">focus {focusLabel}</span>}

      {/* Only once it's been touched: at 1 the sheet is at its authored size,
          and a permanent "100%" would be one more thing on the line saying
          nothing. Shown at all because a pinch can leave you at a scale you
          didn't choose deliberately, and ⌘0 is the way back. */}
      {zoom !== 1 && <span className="app__mode">{Math.round(zoom * 100)}%</span>}
    </footer>
  );
}
