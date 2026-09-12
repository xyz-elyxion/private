/* ─────────────────────────────────────────────────────────────────────────────
 * Platform WebSocket auth (CrazyGames) — a tiny neutral seam.
 *
 * The game runs inside a cross-origin iframe on CrazyGames, where browsers that
 * partition third-party cookies never deliver the `igsession` session cookie to
 * the backend. Without it the game server can only treat the player as a guest
 * ("Guest N", chat locked, no cosmetics ownership). The fix: sockets carry a
 * fresh CrazyGames SDK user token (1h JWT) as a query param, which the server
 * verifies against the platform public key and uses to bind the account.
 *
 * This module stays dependency-free so src/game/net.ts can import it without
 * pulling in the SDK wrapper; the app registers the actual token provider.
 * ────────────────────────────────────────────────────────────────────────── */

import { apiBase } from './urls';

let provider: (() => Promise<string | null>) | null = null;

/**
 * Register the token provider. Called once by the app: on CrazyGames (or the
 * ?cgdev=1 sim) this returns the current SDK user token; anywhere else it
 * returns null and sockets connect exactly as before.
 */
export function setWsAuthProvider(fn: (() => Promise<string | null>) | null): void {
  provider = fn;
}

/**
 * Resolve the `cgToken=<jwt>` query fragment for the next socket connection.
 * Returns '' when there is no provider, the SDK is inactive, or fetching the
 * token failed — callers then connect with a bare URL (cookie path).
 */
export async function wsAuthQuery(): Promise<string> {
  if (!provider) return '';
  try {
    const token = await provider();
    return token ? `cgToken=${encodeURIComponent(token)}` : '';
  } catch {
    return '';
  }
}

/**
 * `sess=<token>` fragment: the portal session-token fallback for socket
 * upgrades (browsers cannot attach headers to a WebSocket handshake). Stored
 * by the app's auth layer when a portal-embedded bundle logs in cross-origin
 * and the browser blocks the third-party session cookie. Empty when absent.
 */
export function wsSessQuery(): string {
  try {
    const base = apiBase();
    const crossOrigin = base ? window.location.origin !== new URL(base).origin : false;
    if (!crossOrigin) return '';
    const token = localStorage.getItem('elyxion-session-token');
    return token ? `sess=${encodeURIComponent(token)}` : '';
  } catch {
    return '';
  }
}

/** Compose both fragments into one ready-to-append URL query string. */
export function wsQueryPair(pairs: Array<string>): string {
  const list = pairs.filter(Boolean);
  return list.length ? `?${list.join('&')}` : '';
}
