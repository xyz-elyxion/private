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
//      (e.g. "https://your-backend.example.com") at build time so accounts/progression
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

// Runtime overrides (portal distribution). One static build ships to many
// portals, so the backend origin must be changeable after the build:
//   · `?api=` URL parameter — highest precedence, good for portal launch URLs
//     (e.g. ?api=https://your-backend.example.com) and for quick testing.
//   · localStorage 'elyxion-api-base' — persists the ?api= value so the
//     override survives the portal stripping query params from launch links.
// Only https origins (or localhost for testing) are accepted, and the value
// must look like a bare origin — otherwise it is ignored, so a portal can't
// be tricked into pointing at an arbitrary path on its own domain.
const RUNTIME_API_KEY = 'elyxion-api-base';
function runtimeApiOverride(): string {
  const theLocal = hasDom
    ? ((globalThis as Record<string, unknown>).window as unknown as {
        location: { protocol: string; host: string; search: string };
        localStorage?: { getItem(k: string): string | null; setItem(k: string, v: string): void };
      })
    : undefined;
  let raw = '';
  try {
    const param = theLocal?.location.search ?? '';
    const m = /[?&]api=([^&]+)/.exec(param);
    if (m) raw = decodeURIComponent(m[1]).trim();
    if (!raw && theLocal?.localStorage) raw = (theLocal.localStorage.getItem(RUNTIME_API_KEY) ?? '').trim();
  } catch {
    return '';
  }
  if (!raw) return '';
  // Normalize: allow 'host', 'host:port', or full URL; store as origin.
  const candidate = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const u = new URL(candidate);
    const isLocal = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname);
    if (u.protocol !== 'https:' && !isLocal) return '';
    if (u.pathname !== '/' && u.pathname !== '') return '';
    const origin = u.origin;
    // Remember a URL-supplied override so it survives param-stripped reloads.
    if (theLocal?.localStorage) {
      try {
        if (theLocal.localStorage.getItem(RUNTIME_API_KEY) !== origin) {
          theLocal.localStorage.setItem(RUNTIME_API_KEY, origin);
        }
      } catch {
        /* storage may be unavailable (private mode) — override still applies */
      }
    }
    return origin === 'https://' || origin.endsWith('://') ? '' : origin;
  } catch {
    return '';
  }
}

/** REST base (no trailing slash). '' = same-origin. */
export function apiBase(): string {
  if (apiBaseCache !== null) return apiBaseCache;
  let base = '';
  try {
    // Runtime override first (portal distribution / testing), then the
    // build-time define for CrazyGames-style cross-origin hosting.
    base = trimSlashes(runtimeApiOverride() || (typeof __CG_API_BASE__ === 'string' ? __CG_API_BASE__ : ''));
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

/** Default game-server WebSocket URL: ws(s)://<api-base-or-host>/ws/elyxion. */
export function defaultWsUrl(): string {
  if (!theWindow) return 'ws://localhost:8787/ws/elyxion';
  const proto = theWindow.location.protocol === 'https:' ? 'wss' : 'ws';
  const base = apiBase();
  if (base) {
    // Cross-origin backend: reuse its scheme + host (https→wss).
    const wsBase = base.replace(/^http/, 'ws');
    return `${wsBase}/ws/elyxion`;
  }
  return `${proto}://${theWindow.location.host}/ws/elyxion`;
}
