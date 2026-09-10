// Hosting-proof asset + backend base URLs.
//
// CrazyGames hosts the static bundle on their own domain, while the game's
// backend (REST + WebSocket) stays on the developer's origin. Three distinct
// bases are needed:
//
//   1. Asset base  (models / sounds): CRAZYGAMES REQUIREMENT — "Use only
//      relative paths when referring to other files in the game bundle."
//      A root-relative path like '/models/x.glb' breaks when the bundle is
//      served from a subdirectory, so asset URLs are resolved against
//      import.meta.env.BASE_URL (which honors Vite's `base` config).
//   2. API base (REST): defaults to same-origin. When the bundle runs on a
//      foreign host (CrazyGames, itch embed, etc.) set VITE_API_BASE
//      (e.g. "https://instagib.win") at build time so accounts/progression
//      still reach the real backend.
//   3. WebSocket base: derived from the API base (https→wss), falling back to
//      window.location.host for same-origin deploys.
//
// Everything is computed lazily and cached; all helpers are safe in SSR-guarded
// contexts (typeof window === 'undefined') and return the plain paths there.

declare const __CG_API_BASE__: string | undefined; // injected by vite.config.ts `define`

const trimSlashes = (s: string) => s.replace(/\/+$/, '');

// SSR/type-safe guards: this file is imported by shared (client+server) modules
// (cosmetics.ts), so it must compile under the server tsconfig (no DOM lib).
const hasDom = typeof globalThis !== 'undefined' && typeof (globalThis as { window?: unknown }).window !== 'undefined';
const theWindow = hasDom
  ? ((globalThis as Record<string, unknown>).window as {
      location: { protocol: string; host: string };
    })
  : undefined;
const theImportMeta = typeof import.meta !== 'undefined' ? import.meta : undefined;

let assetBaseCache: string | null = null;

/** Prefix for files in /public (models, sounds). Always ends WITHOUT a slash. */
export function assetBase(): string {
  if (assetBaseCache !== null) return assetBaseCache;
  let base = '/';
  try {
    // Vite injects BASE_URL ('/' by default, or the configured `base` path).
    const env = (theImportMeta as { env?: { BASE_URL?: string } } | undefined)?.env;
    base = env?.BASE_URL ?? '/';
  } catch {
    base = '/';
  }
  assetBaseCache = trimSlashes(base) || '';
  return assetBaseCache;
}

/** Resolve a root-relative public-asset path ('/models/x.glb') for hosting. */
export function assetUrl(path: string): string {
  if (!path || /^(https?:|blob:|data:)/i.test(path)) return path;
  return `${assetBase()}${path.startsWith('/') ? path : `/${path}`}`;
}

let apiBaseCache: string | null = null;

/** REST base (no trailing slash). '' = same-origin. */
export function apiBase(): string {
  if (apiBaseCache !== null) return apiBaseCache;
  let base = '';
  try {
    // Build-time override (Vite define): the bundle's real backend origin when
    // hosted cross-origin (CrazyGames). Unset for normal same-origin deploys.
    base = trimSlashes(typeof __CG_API_BASE__ === 'string' ? __CG_API_BASE__ : '');
  } catch {
    base = '';
  }
  apiBaseCache = base;
  return apiBaseCache;
}

/** Fetch wrapper for /api routes that respects the cross-origin API base. */
export function apiUrl(path: string): string {
  if (!path.startsWith('/')) return path;
  return `${apiBase()}${path}`;
}

/** Default game-server WebSocket URL: ws(s)://<api-base-or-host>/ws/instagib. */
export function defaultWsUrl(): string {
  if (!theWindow) return 'ws://localhost:8787/ws/instagib';
  const proto = theWindow.location.protocol === 'https:' ? 'wss' : 'ws';
  const base = apiBase();
  if (base) {
    // Cross-origin backend: reuse its scheme + host (https→wss).
    const wsBase = base.replace(/^http/, 'ws');
    return `${wsBase}/ws/instagib`;
  }
  return `${proto}://${theWindow.location.host}/ws/instagib`;
}
