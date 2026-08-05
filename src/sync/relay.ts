import { invoke } from "@tauri-apps/api/core";
import { RELAY_PORT } from "./protocol";

/**
 * Where the relay is, and — on the desktop app — being one.
 *
 * The second half is the point. A relay has to exist somewhere for two people
 * to flow together, and asking a debater to start a server on tournament wifi
 * ten minutes before a round is asking for it not to happen. So the app hosts:
 * one of them presses `:host`, their own copy starts listening, and the address
 * it reports is the whole of the setup. See `src-tauri/src/relay.rs`.
 */

/** What the Rust side reports once it's listening. */
export interface RelayInfo {
  port: number;
  /** This machine's addresses on the networks it is on, loopback excluded. */
  addresses: string[];
}

/**
 * Whether this build can host — i.e. whether it is the desktop app rather than
 * a browser tab. A browser can still *join* anything; it just has nowhere to
 * put a listening socket.
 */
export function canHost(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function startHosting(port?: number): Promise<RelayInfo> {
  return invoke<RelayInfo>("relay_start", { port });
}

export async function stopHosting(): Promise<void> {
  await invoke("relay_stop");
}

export async function hostingInfo(): Promise<RelayInfo | null> {
  return invoke<RelayInfo | null>("relay_info");
}

/* ---- where we are pointed ------------------------------------------------
   A setting, not a build flag. It used to be baked in at build time, which
   meant the packaged app could only ever talk to whatever relay it was
   compiled against — fine for a dev server, useless for two people meeting in
   a room. It is stored per machine because it is a fact about where you are,
   not about the round. */

const RELAY_KEY = "flow.relay.url";

export function loadRelayUrl(fallback: string): string {
  return safeStorage()?.getItem(RELAY_KEY) || fallback;
}

export function saveRelayUrl(url: string): void {
  safeStorage()?.setItem(RELAY_KEY, url);
}

/** Forget the configured relay and go back to the built-in default. */
export function clearRelayUrl(): void {
  safeStorage()?.removeItem(RELAY_KEY);
}

/**
 * The `host` or `host:port` half of a relay URL — what an invitation carries.
 * The default port is left off: it is the one everybody's app already tries,
 * and a code with a number in it is a code somebody reads out wrong.
 */
export function hostFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    const port = Number(parsed.port);
    return port && port !== RELAY_PORT
      ? `${parsed.hostname}:${port}`
      : parsed.hostname;
  } catch {
    return null;
  }
}

/** The address to read out, for a relay this app is hosting. */
export function hostAddressOf(info: RelayInfo): string | null {
  const address = info.addresses[0];
  if (!address) return null;
  return info.port === RELAY_PORT ? address : `${address}:${info.port}`;
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}
