import React from "react";
import { CommandLine } from "./CommandLine";
import { folderName } from "../files/disk";
import type { Mark, Support } from "../model/types";
import type { Peer } from "../sync/presence";
import type { ConnectionStatus } from "../sync/transport";

/**
 * A status line rather than a banner: the sheet is what the screen is for, and
 * a hint above it pushed the first speech down the page.
 *
 * It shows three things, left to right — the pending count, the command line
 * when it's open, and which modes are on.
 *
 * It used to carry the whole keymap along the middle as well, and no longer
 * does: the list outgrew the line, and a truncated reference is worse than
 * none. It is a sheet of its own now, on `:?` — see Keymap.tsx. What's left
 * here is only what is *true right now*, which is what a status line is for.
 */

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
  /** Whether the cursor's own argument was read off evidence. */
  support: Support;
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
  /**
   * The directory the round is being written to, or null when it isn't being
   * written anywhere. Shown whenever there is one — it is the only thing that
   * says autosave is on, and "is this being saved" is not a question anybody
   * should have to open a file manager to answer.
   */
  savedIn: string | null;
  /** What went wrong writing it, if anything. */
  saveError: string | null;
  /**
   * How many memorized answers the cursor's own argument has — i.e. what `A`
   * would put in the next speech, and 0 when there is nothing to put there.
   */
  answers: number;
  /** What went wrong reaching `~/.flow`, if anything. */
  memoryError: string | null;
  /** Whether the sheet showing is what you have memorized rather than the round. */
  memory: boolean;
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
  support,
  focusLabel,
  zoom,
  room,
  status,
  invitation,
  hosting,
  error,
  savedIn,
  saveError,
  answers,
  memoryError,
  memory,
  peers,
  authorLabel,
  onCommandChange,
  onCommandSubmit,
  onCommandCancel,
}: StatusLineProps): React.ReactElement {
  // Which mode the keyboard is in. They are exclusive in practice and the
  // order here is the order they'd win in anyway: the textarea takes the
  // keyboard from the keymap, the keymap can't be reached while it has it, and
  // anything that isn't a selection key drops the selection on its way past
  // (see `run`). So this reads as a list of what owns the keys, most
  // exclusive first.
  const mode = editing
    ? "insert"
    : command !== null
      ? "command"
      : selecting
        ? "select"
        : "normal";

  return (
    <footer className="app__status">
      {/* First thing on the line and never absent: what a modal editor owes
          you is the answer to "what will the next key do", and an indicator
          that comes and goes is one you have to find before you can read it.

          So the place is fixed and only the weight changes — `normal` is the
          line's own quiet grey, because it is not news, and every other mode
          lights the chip up. The size rides along with `select` rather than
          getting a chip of its own: it is the same fact, and it is the number
          you want at exactly the moment you are looking here. */}
      <span className={`app__mode is-${mode}`}>
        {mode === "select" && selectionSize > 1 ? `select ${selectionSize}` : mode}
      </span>

      <span className="app__count">{count ?? ""}</span>

      {command !== null && (
        <CommandLine
          value={command}
          onChange={onCommandChange}
          onSubmit={onCommandSubmit}
          onCancel={onCommandCancel}
        />
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

      {/* Where the round is kept. Beside the room chip because it answers the
          same kind of question — this is what is true of the document, rather
          than of how you are looking at it — and because between them they are
          the two ways a flow outlives the window it is in.

          The folder's name, not its path: the path is what a tooltip is for,
          and a status line has one line. A failure takes the chip over rather
          than adding a second one, because the answer to "where is this being
          saved" and the answer to "why isn't it" belong in the same place. */}
      {(savedIn !== null || saveError !== null) && (
        <span
          className={`app__file${saveError !== null ? " is-error" : ""}`}
          title={saveError ?? (savedIn ? `saving to ${savedIn}` : undefined)}
        >
          {saveError ?? folderName(savedIn ?? "")}
        </span>
      )}

      {/* Why the last `m` didn't take, next to the folder for the same reason
          the folder is next to the room: these are the two places a flow
          reaches past the window it is in. There is no chip for the ordinary
          case — a store that is working is one nobody should have to think
          about, and how many arguments are in it is not a thing you act on. */}
      {memoryError !== null && (
        <span className="app__file is-error" title={memoryError}>
          {memoryError}
        </span>
      )}

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
      {authorLabel !== null && <span className="app__flag">by {authorLabel}</span>}

      {/* Editing and selecting used to be flagged here too, and are the mode
          indicator's job now: the line said "edit" on the right while saying
          "insert" on the left would be one fact in two places, and the left is
          where a modal editor's mode belongs. What is left over here is not
          modes at all — it is what happens to be true of the argument under
          the cursor, and of the sheet you are reading it on. */}

      {/* Which document is under the sheet, and the first of these because it
          is the one fact here you cannot afford to be wrong about. The keys all
          behave exactly as they do on a flow — that is the point of building
          the memory sheet as a round — so nothing else on screen would tell you
          that what `x` deletes is a block you keep between rounds rather than
          an argument in this one. Not a mode: no key means anything different,
          and the mode chip on the left would be lying if it said so. */}
      {memory && <span className="app__flag is-memory">memorized</span>}

      {/* Only when the cursor's own argument isn't marked the ordinary way, on
          the same terms as the zoom below: the default says nothing worth a
          chip, and the two that aren't the default are invisible on a run that
          has only one argument so far. */}
      {mark !== "num" && (
        <span className="app__flag">{mark === "alpha" ? "a. b. c." : "no marks"}</span>
      )}

      {/* That the cursor's argument was something they said rather than
          something they read. Beside the mark because it is the same kind of
          fact — what is true of this one argument — and only when it isn't the
          default, on the same terms: a sheet nobody has pressed `c` on has
          nothing to report here. */}
      {support === "analytic" && <span className="app__flag">analytic</span>}

      {/* That there are answers memorized to the cursor's argument. A fact
          about the argument rather than about the editor, like the mark above
          it — and the only thing that says `A` has something to insert here,
          since what is in `~/.flow` is otherwise invisible until it lands on
          the sheet. Counted, because how many are coming is the difference
          between pressing it and writing the answer yourself. */}
      {answers > 0 && (
        <span className="app__flag">
          {answers} answer{answers === 1 ? "" : "s"}
        </span>
      )}

      {/* Naming the pinned speech matters now that it doesn't follow the
          cursor — it's the difference between "focus is on" and knowing which
          three columns you're inside. */}
      {focusLabel !== null && <span className="app__flag">focus {focusLabel}</span>}

      {/* Only once it's been touched: at 1 the sheet is at its authored size,
          and a permanent "100%" would be one more thing on the line saying
          nothing. Shown at all because a pinch can leave you at a scale you
          didn't choose deliberately, and ⌘0 is the way back. */}
      {zoom !== 1 && <span className="app__flag">{Math.round(zoom * 100)}%</span>}
    </footer>
  );
}
