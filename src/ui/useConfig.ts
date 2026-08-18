import { useCallback, useEffect, useRef, useState } from "react";
import { canRemember, readConfigFile } from "../memory/store";
import { DEFAULT_CONFIG, readConfig, type Config } from "../editor/config";

/**
 * The keys, as the user has them: `~/.flow/config.json` read over the defaults
 * (see editor/config.ts for the file, and `commands` for what can go in it).
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
export function useConfig(): Config {
  const [config, setConfig] = useState<Config>(DEFAULT_CONFIG);

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

  return config;
}
