import { useCallback, useEffect, useRef, useState } from "react";
import { canRemember, readConfigFile, seedConfigFile } from "../memory/store";
import {
  DEFAULT_CONFIG,
  defaultConfigText,
  readConfig,
  type Config,
} from "../editor/config";

/**
 * The keys, as the user has them, and the one thing you can do to them.
 *
 * The shape `useMemory` has, for the same reason: a file on disk, what is
 * wrong with it, what last worked, and the action that touches it — all from
 * one place, so nothing else has to know where `~/.flow` is.
 */
export interface Configuration extends Config {
  /**
   * What last worked and was worth saying — `:config` wrote a file, or found
   * one already there. Separate from `problems`, which the status line draws
   * as a failure.
   */
  note: string | null;
  /** Write the defaults out, where there is no config yet. See `:config`. */
  seed: () => void;
}

/**
 * `~/.flow/config.json` read over the defaults (see editor/config.ts for the
 * file, and `commands` for what can go in it).
 *
 * Read at launch and again whenever the window is given the focus back. A
 * config is edited in another application — that is what a text file is for —
 * and the moment you have finished editing it is the moment you come back
 * here, so that is when to look. It costs one small read of one small file on
 * a gesture the user has just made deliberately; the alternative is quitting
 * the app to see whether you got the JSON right.
 *
 * In a browser tab there is no `~/.flow` and so no config: the defaults stand,
 * silently, the same way memory and files do (see `canRemember`).
 */
export function useConfig(): Configuration {
  const [config, setConfig] = useState<Config>(DEFAULT_CONFIG);
  const [note, setNote] = useState<string | null>(null);

  /**
   * The file as it read last time. A keymap that was a new object on every
   * focus would have the window listener resubscribing and the sheet
   * re-rendering each time you came back to a config nobody had touched.
   */
  const last = useRef<string | null>(null);

  const read = useCallback(() => {
    if (!canRemember()) return;
    readConfigFile()
      .then((text) => {
        if (text === last.current) return;
        last.current = text;
        setConfig(readConfig(text));
      })
      // Only the read itself can fail here — the parse reports its own
      // problems rather than throwing — and that means the file is there and
      // unreadable, which is worth saying out loud.
      .catch((e: unknown) => setConfig({ ...DEFAULT_CONFIG, problems: [String(e)] }));
  }, []);

  useEffect(() => {
    read();
    window.addEventListener("focus", read);
    return () => window.removeEventListener("focus", read);
  }, [read]);

  /**
   * Both answers are worth saying and neither is a failure: one tells you the
   * file is there now, the other tells you it was already — which is the reply
   * to "did that do anything?" when you have forgotten you ran it before.
   *
   * No re-read afterwards. A seed is the defaults, which is what is already in
   * force, so the keymap it produces is the keymap on screen; the next focus
   * picks up whatever you then change in it, which is the same path every
   * other edit to the file takes.
   */
  const seed = useCallback(() => {
    if (!canRemember()) {
      setConfig((c) => ({ ...c, problems: ["a config needs the desktop app"] }));
      return;
    }
    seedConfigFile(defaultConfigText()).then(
      (wrote) => setNote(wrote ? "wrote ~/.flow/config.json" : "~/.flow/config.json already exists"),
      (reason: unknown) => setConfig((c) => ({ ...c, problems: [String(reason)] })),
    );
  }, []);

  return { ...config, note, seed };
}
