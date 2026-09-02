// Background auto-update for the deployed client.
//
// The server never caches index.html (prod), so fetching it and comparing the
// `elyxion-build` meta tag (stamped by vite.config.ts at build time) reveals a
// fresh deployment without touching any API. When a newer build exists we:
//   1. PREFETCH its hashed /assets/* files in the background (an honest "trying
//      to update while the player is playing" — the running bundle is untouched
//      and keeps working);
//   2. hand the caller an onUpdate signal so IT chooses the safe moment to
//      reload — e.g. back in the lobby after a match ends, or after a short
//      grace on the landing page.
//
// No-ops in dev: the dev server stamps 'dev' (and Vite HMR owns dev updates),
// and the built bundle's import.meta.env.DEV is statically false in prod.

const ASSET_RE = /(?:src|href)="(\/assets\/[^"]+\.(?:js|css))"/g;

export type UpdateInfo = {
  buildId: string;
  // The newer build's hashed bundle files, already prefetched into the HTTP
  // cache by the time onUpdate fires, so the reload is a cache hit.
  assets: string[];
};

// The build id of the page that's CURRENTLY running (read from the live DOM).
export function currentBuildId(): string | null {
  if (typeof document === 'undefined') return null;
  return (
    document.querySelector('meta[name="elyxion-build"]')?.getAttribute('content') ??
    null
  );
}

// Parse the build id out of a fetched index.html document.
export function parseBuildId(html: string): string | null {
  const m = /<meta[^>]+name="elyxion-build"[^>]*content="([^"]+)"/i.exec(html);
  return m ? m[1] : null;
}

// The hashed bundle URLs referenced by that index.html.
export function parseAssetUrls(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(ASSET_RE)) {
    const url = m[1];
    if (url && !out.includes(url)) out.push(url);
  }
  return out;
}

// Warm the browser's cache with the new bundle (rel=prefetch is lower priority
// than page assets, so it never competes with gameplay downloads).
function prefetch(assets: string[]): void {
  for (const url of assets) {
    const link = document.createElement('link');
    link.rel = 'prefetch';
    link.href = url;
    document.head.appendChild(link);
  }
}

// Poll for a newer deployment; calls onUpdate once per distinct newer build
// (the caller reloads, ending the session — if it can't yet, e.g. mid-match,
// a later deployment still reaches the player when they're ready). Returns a
// stop fn.
export function startUpdateChecker(opts: {
  intervalMs?: number;
  onUpdate: (info: UpdateInfo) => void;
}): () => void {
  if (import.meta.env.DEV) return () => {};
  const current = currentBuildId();
  if (!current || current === 'dev') return () => {};

  const intervalMs = opts.intervalMs ?? 45_000;
  let stopped = false;
  let lastSeen = current;

  const check = async (): Promise<void> => {
    if (stopped) return;
    try {
      // Same path + query (e.g. a ?join= invite) so we compare like-for-like.
      const url = `${window.location.pathname}${window.location.search}`;
      const res = await fetch(url, { cache: 'no-store', headers: { Accept: 'text/html' } });
      if (!res.ok) return;
      const html = await res.text();
      const next = parseBuildId(html);
      if (!next || next === current || next === lastSeen) return;
      lastSeen = next;
      const info: UpdateInfo = { buildId: next, assets: parseAssetUrls(html) };
      // Background update attempt: preload the new bundle, keep playing on the
      // old one until the caller picks the safe boundary.
      prefetch(info.assets);
      opts.onUpdate(info);
    } catch {
      /* transient failure (offline, mid-deploy) — retry next poll */
    }
  };

  void check();
  const t = window.setInterval(() => void check(), intervalMs);
  return () => {
    stopped = true;
    window.clearInterval(t);
  };
}