import { useEffect, useMemo, useRef, useState } from "react";
import { Flow } from "./flow_crdt";
import type { Argument } from "./types";

/**
 * Create a `Flow` (once) and re-render whenever it changes — locally or from a
 * remote peer. Returns the live `flow` for mutations and its current `roots`.
 */
export function useFlow(seed?: (flow: Flow) => void): {
  flow: Flow;
  roots: Argument[];
} {
  const flow = useMemo(() => {
    const f = new Flow();
    seed?.(f);
    // The document as loaded is the floor — undo shouldn't rewind into a blank
    // flow the user never typed.
    f.clearHistory();
    return f;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [roots, setRoots] = useState<Argument[]>(() => flow.roots());

  // Guard against setState after unmount (Loro fires async on import).
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    const unsub = flow.subscribe(() => {
      if (mounted.current) setRoots(flow.roots());
    });
    setRoots(flow.roots());
    return () => {
      mounted.current = false;
      unsub();
    };
  }, [flow]);

  return { flow, roots };
}
