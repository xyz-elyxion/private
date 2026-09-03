// Shared server core: the Express app (API routes, security headers, SPA
// fallback) plus the game WebSocket attachment + upgrade handling. Built once,
// then consumed two ways:
//   • standalone entry  server/index.ts   — owns its own http.Server (prod + dev:server)
//   • single-port dev   server/vite-plugin.ts — mounted inside Vite's dev server,
//     so `npm run dev` is ONE process on ONE port (client + API + WS + HMR).
//
// The upgrade handler deliberately does NOT destroy sockets for non-/ws/elyxion
// paths: embedded in Vite, other upgrades (Vite's HMR websocket) must fall
// through to Vite's own listener. In the standalone server nothing else listens,
// so returning is equally safe there.

// Load .env into process.env BEFORE any module reads env at import time (see
// server/env.ts for why: neither the standalone `tsx` entry nor the Vite dev
// process gets automatic .env handling).
import './env';

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import cookieParser from 'cookie-parser';
import { WebSocketServer, type WebSocket } from 'ws';
import { statsRouter } from './stats';
import { leaderboardRouter } from './leaderboard';
import { rankedRouter } from './ranked';
import { challengeRouter } from './challenge';
import { feedbackRouter } from './feedback';
import { supportRouter } from './support';
import { communityRouter } from './community';
import { tempReplaysRouter } from './tempReplays';
import { announcementsRouter } from './announcements';
import { authRouter, adminUsernamesFromEnv } from './auth';
import { adminApiTokenEnabled, adminRouter, setLiveCountsSource, setModerationActions } from './admin';
import { syncAdminsFromEnv } from './db';
import { attachElyxionWs } from './elyxion-game';

export const ELYXION_WS_PATH = '/ws/elyxion';

// Process-level safety net: a single uncaught throw (a `ws` internal error, a
// timer callback, an unexpected exception) must NOT take the whole server — and
// every connected player — down. Log and keep serving; the alpha favors uptime.
process.on('uncaughtException', (err) => console.error('[fatal] uncaughtException', err));
process.on('unhandledRejection', (reason) => console.error('[fatal] unhandledRejection', reason));

export const dev = process.env.NODE_ENV !== 'production';

const distDir = path.join(process.cwd(), 'dist');
const indexHtml = path.join(distDir, 'index.html');
const hasBuild = fs.existsSync(indexHtml);

// A private / loopback / mDNS hostname — i.e. something only reachable from the
// same machine or LAN. In dev we trust these so `npm run dev:lan` works when a
// phone or second laptop loads the app from this machine's WiFi IP (the origin
// is then http://192.168.x.x:5173, which the localhost-only check would reject).
const isPrivateHost = (hostname: string): boolean => {
  if (hostname === 'localhost' || hostname.endsWith('.local')) return true;
  if (hostname === '::1' || hostname.startsWith('127.')) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/.exec(hostname);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return (
    a === 10 || // 10.0.0.0/8
    (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12
    (a === 192 && b === 168) || // 192.168.0.0/16
    (a === 169 && b === 254) // 169.254.0.0/16 link-local
  );
};

// Only browsers that loaded the app from an allowed origin may open the socket.
const isAllowedWsOrigin = (
  origin: string | undefined,
  hostHeader: string,
): boolean => {
  if (!origin) return dev; // non-browser clients (curl, load tests) only in dev
  try {
    const originUrl = new URL(origin);
    const base = process.env.APP_BASE_URL;
    if (base && originUrl.origin === new URL(base).origin) return true;
    // In dev, trust loopback AND private-LAN origins so LAN testing works
    // regardless of how the dev proxy rewrites the Host header.
    if (dev && isPrivateHost(originUrl.hostname)) return true;
    // Fallback: same-origin (handles dynamic domains / no APP_BASE_URL set).
    return originUrl.host === hostHeader;
  } catch {
    return false;
  }
};

export const app = express();
app.disable('x-powered-by');
// Behind the Cloudflare tunnel / reverse proxy: trust the first proxy hop so
// `req.ip` is the real client IP (used as the rate-limit fallback for
// cookie-less callers), not the proxy's socket address.
app.set('trust proxy', 1);
// When Cloudflare proxies the origin, `CF-Connecting-IP` is the authoritative
// visitor IP (CF sets it and overwrites any client-supplied value). Normalize
// X-Forwarded-For to it so express `req.ip` — used for auth rate-limiting
// (auth.ts) and audit logging (stats/admin) — resolves to the real visitor
// instead of collapsing every request onto a single Cloudflare edge IP, which
// would let a handful of logins rate-limit everyone behind that edge. No-op when
// the header is absent (not proxied). NOTE: to make this unspoofable, also lock
// the origin to accept traffic only from Cloudflare (Authenticated Origin Pulls
// or an IP allowlist) so a client can't reach Railway directly with a forged header.
app.use((req, _res, next) => {
  const cf = req.headers['cf-connecting-ip'];
  if (typeof cf === 'string' && cf.length > 0) req.headers['x-forwarded-for'] = cf;
  next();
});

// Security headers on every response. The app is a single same-origin bundle —
// Vite-built JS/CSS under /assets, game assets (.glb/.ogg) and the /ws/elyxion
// socket are all same-origin — so a tight CSP costs nothing: scripts and
// connections (incl. the same-origin WebSocket) are 'self'; styles allow inline
// (React style props + the Play-of-the-Match <style> tag) and Google Fonts;
// images allow data:/blob: for three.js canvas textures. frame-ancestors 'none'
// + X-Frame-Options block clickjacking. HSTS is prod-only (TLS lives at the
// platform edge); sending it in local http dev would poison the browser.
const CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "img-src 'self' data: blob:",
  "media-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  // blob:/data: are needed by three.js: GLTFLoader decodes GLB-embedded textures
  // (e.g. the character model) by creating a blob: URL and fetch()-ing it, which
  // connect-src governs — without blob: those textures silently fail to load.
  "connect-src 'self' blob: data:",
  "worker-src 'self' blob:",
  "form-action 'self'",
].join('; ');
app.use((_req, res, next) => {
  // Strict CSP only in production. In dev the Vite dev server transforms the
  // HTML and injects an INLINE preamble script for React fast-refresh (and
  // @vite/client helpers) — serving the strict CSP here — now that the embedded
  // server's middleware runs before Vite's own in the single-port flow — would
  // block those inline scripts and break the page ("can't detect preamble").
  // Dev runs on localhost; the strict policy protects the built bundle users
  // actually load. Other headers apply everywhere.
  if (!dev) res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader(
    'Permissions-Policy',
    'geolocation=(), camera=(), microphone=(), payment=(), usb=()',
  );
  if (!dev) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});

app.use(cookieParser());
app.use(express.json({ limit: '16kb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, build: hasBuild });
});
// Live concurrency for the lobby/landing "N playing now" readout (set after the
// game WS is attached below).
let liveCounts: () => {
  online: number;
  inMatch: number;
  rooms: number;
  loopLagMs: number;
  loopLagMaxMs: number;
} = () => ({
  online: 0,
  inMatch: 0,
  rooms: 0,
  loopLagMs: 0,
  loopLagMaxMs: 0,
});
app.get('/api/live', (_req, res) => res.json(liveCounts()));
app.use('/api', authRouter);
app.use('/api', statsRouter);
app.use('/api', leaderboardRouter);
app.use('/api', rankedRouter);
app.use('/api', challengeRouter);
app.use('/api', feedbackRouter);
app.use('/api', supportRouter);
app.use('/api', communityRouter);
app.use('/api', tempReplaysRouter);
app.use('/api', announcementsRouter);
app.use('/api/admin', adminRouter);

// Promote any configured ADMIN_USERNAMES that already have accounts (idempotent;
// new accounts are promoted at registration). Set ADMIN_USERNAMES on Railway and
// redeploy to claim your account.
{
  const admins = adminUsernamesFromEnv();
  const n = syncAdminsFromEnv(admins);
  if (admins.length) console.log(`[admin] ADMIN_USERNAMES=[${admins.join(', ')}] — ${n} synced`);
}

// Static client + SPA fallback only in production: with a dist/ build the Node
// server owns the client. In dev the client is Vite's job — serving the built
// shell here would shadow Vite's transform paths (/@vite/client, /@fs, HMR)
// whenever a stale dist/ exists, starving the dev server of its own assets.
// (`npm run dev` embeds this app in Vite; `npm run dev:server` is API/socket
// only, so neither mode should serve dist in dev.)
if (hasBuild && !dev) {
  // Long-cache fingerprinted assets; never cache the HTML shell.
  app.use(
    express.static(distDir, {
      index: false,
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html') || filePath.endsWith('sw.js')) {
          // sw.js too: the browser polls it for updates on navigations (and we
          // stamp a fresh build id into it every deploy). A long max-age here
          // would delay new workers by days.
          res.setHeader('Cache-Control', 'no-cache');
        } else if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          // Vite fingerprints these (content-hashed filenames) → safe forever.
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        } else {
          // Stable-named public files: models/*.glb, sounds/**/*.{ogg,mp3},
          // og-image.png, fonts. Previously sent with NO Cache-Control, so every
          // visit revalidated (304 round-trips) or cold-downloaded multi-MB files
          // through the Node origin — which shares its egress with the realtime
          // game socket. A player surge cold-loading these (soldier.glb is 2.1MB)
          // is what starved the WS traffic and spiked everyone's ping. Cache them:
          // a day fresh + a week serving stale while revalidating. Names don't
          // change, so NOT immutable — bust by renaming or a ?v= query if needed.
          res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
        }
      },
    }),
  );
  // SPA fallback: every non-API GET serves index.html so client routes
  // (e.g. /play) deep-link and reload correctly.
  //
  // Per-route canonical: the shell hardcodes `canonical: https://xyz-elyxion.onrender.com/`,
  // but a page that self-canonicalizes to a DIFFERENT url gets folded into it
  // by Google ("Alternate page with proper canonical tag") — which conflicts
  // with the sitemap listing /play as indexable. For the small allowlist of
  // indexable routes, rewrite the canonical + og:url to the route itself.
  // Variants are built once per process (the shell only changes on deploy).
  const CANONICAL_ROUTES = ['/play'];
  const shellHtml = fs.readFileSync(indexHtml, 'utf8');
  const shellByRoute = new Map<string, string>();
  for (const route of CANONICAL_ROUTES) {
    shellByRoute.set(
      route,
      shellHtml
        .replaceAll('href="https://xyz-elyxion.onrender.com/"', `href="https://xyz-elyxion.onrender.com${route}"`)
        .replaceAll('content="https://xyz-elyxion.onrender.com/"', `content="https://xyz-elyxion.onrender.com${route}"`),
    );
  }
  app.get(/.*/, (req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api')) return next();
    res.setHeader('Cache-Control', 'no-cache');
    res.type('html').send(shellByRoute.get(req.path) ?? shellHtml);
  });
} else if (!dev) {
  console.warn(
    '[server] No dist/ build found. Run `npm run build` before `npm start`.',
  );
}

// Terminal error handler — a malformed/oversized JSON body (express.json throws)
// returns a clean 4xx instead of Express's default 500 + stack-trace leak.
app.use((err: Error & { type?: string; status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err?.type === 'entity.too.large') {
    res.status(413).json({ error: 'payload_too_large' });
    return;
  }
  if (err?.type === 'entity.parse.failed' || err?.status === 400) {
    res.status(400).json({ error: 'bad_request' });
    return;
  }
  console.error('[http] unhandled route error', err);
  res.status(500).json({ error: 'server_error' });
});

// ── Game WebSocket ────────────────────────────────────────────────────────────
// `maxPayload` caps a single inbound frame (legit game messages are a few
// hundred bytes) so a modified client can't OOM the process with one giant
// frame; perMessageDeflate off avoids decompression amplification.
const elyxionWss = new WebSocketServer({
  noServer: true,
  maxPayload: 16 * 1024,
  perMessageDeflate: false,
});
const elyxion = attachElyxionWs(elyxionWss);
setLiveCountsSource(elyxion.liveCounts);
// Live kick/ban handles for the admin moderation routes (session-only, see
// server/admin.ts).
setModerationActions(elyxion.moderation);
// Live concurrency for the REST /api/live readout (set at attach).
liveCounts = elyxion.liveCounts;
elyxionWss.on('error', (err) => console.error('[ws] server error', err));

// Connection caps so a flood can't exhaust slots/memory on a public alpha.
// Env-overridable so load/stress tests can raise them from a single host (and so
// ops can retune without a code change); the defaults are the production values.
const MAX_WS_TOTAL = parseInt(process.env.MAX_WS_TOTAL || '600', 10);
const MAX_WS_PER_IP = parseInt(process.env.MAX_WS_PER_IP || '12', 10);
let wsTotal = 0;
const wsPerIp = new Map<string, number>();
function clientIp(req: http.IncomingMessage): string {
  // Prefer Cloudflare's authoritative client IP when proxied. The WS upgrade path
  // bypasses the express middleware that normalizes this for HTTP routes, so the
  // per-IP connection cap below must read CF-Connecting-IP itself — otherwise all
  // players behind one CF edge share an IP and trip MAX_WS_PER_IP during a surge.
  const cf = req.headers['cf-connecting-ip'];
  const cfIp = Array.isArray(cf) ? cf[0] : cf;
  if (cfIp && cfIp.trim()) return cfIp.trim();
  const xff = req.headers['x-forwarded-for'];
  const fwd = Array.isArray(xff) ? xff[0] : xff;
  return (fwd ? fwd.split(',')[0] : req.socket.remoteAddress || '').trim() || 'unknown';
}

// Shared upgrade handler for the game socket. Returns without touching sockets
// for other paths so Vite's HMR websocket keeps working when this is embedded
// in the dev server (nothing else listens in the standalone server, so the early
// return is equally safe there).
export function elyxionUpgrade(req: http.IncomingMessage, socket: import('node:stream').Duplex, head: Buffer) {
  const { url } = req;
  const pathname = url ? url.split('?')[0] : '';
  if (pathname !== ELYXION_WS_PATH) return;
  if (!isAllowedWsOrigin(req.headers.origin, req.headers.host || '')) {
    socket.destroy();
    return;
  }
  const ip = clientIp(req);
  if (wsTotal >= MAX_WS_TOTAL || (wsPerIp.get(ip) ?? 0) >= MAX_WS_PER_IP) {
    socket.destroy(); // over capacity — drop before allocating a game slot
    return;
  }
  // Disable Nagle's algorithm on the game socket. Our hot path is many small
  // frames (64Hz position upload + 64Hz snapshots, ~100 bytes each); with Nagle
  // on, the kernel can hold a small write waiting to coalesce it with the next
  // one (interacting badly with delayed-ACK), adding up to ~40ms of latency and
  // jitter to every update. A realtime game wants frames out immediately. (The
  // upgrade event types the stream as a bare Duplex; the runtime object is a
  // net/TLS Socket that has setNoDelay — guard so it's a no-op if it ever isn't.)
  (socket as { setNoDelay?: (on: boolean) => void }).setNoDelay?.(true);
  elyxionWss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
    wsTotal++;
    wsPerIp.set(ip, (wsPerIp.get(ip) ?? 0) + 1);
    (ws as WebSocket & { isAlive?: boolean }).isAlive = true;
    ws.on('pong', () => {
      (ws as WebSocket & { isAlive?: boolean }).isAlive = true;
    });
    ws.on('error', (err) => console.error('[ws] socket error', err));
    ws.on('close', () => {
      wsTotal = Math.max(0, wsTotal - 1);
      const n = (wsPerIp.get(ip) ?? 1) - 1;
      if (n <= 0) wsPerIp.delete(ip);
      else wsPerIp.set(ip, n);
    });
    // Pass the resolved client IP (CF-Connecting-IP → X-Forwarded-For →
    // remoteAddress) into the game: IP bans are enforced at connect there.
    elyxionWss.emit('connection', ws, req, ip);
  });
}

// Heartbeat: terminate sockets that stop answering pings (half-open TCP, yanked
// network) so dead peers don't hold game slots until the app-level stale sweep.
const wsHeartbeat = setInterval(() => {
  for (const ws of elyxionWss.clients) {
    const w = ws as WebSocket & { isAlive?: boolean };
    if (w.isAlive === false) {
      ws.terminate();
      continue;
    }
    w.isAlive = false;
    try {
      ws.ping();
    } catch {
      /* socket already closing */
    }
  }
}, 15_000);
wsHeartbeat.unref();

// The dev server takes over this role; standalone builds read it from here so
// the startup banner matches what's actually listening.
export { adminApiTokenEnabled, hasBuild };