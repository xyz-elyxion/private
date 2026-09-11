// Elyxion — standalone server.
//
// One Node process hosts everything on a single port:
//   • the built web client (dist/, in production)
//   • the stats API           ->  /api/stats
//   • the authoritative game   ->  /ws/elyxion  (WebSocket)
//
// In development, Vite runs in Express middleware mode on this same listener,
// so the client, API, game socket, and HMR all share one origin and one port.

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
import { seasonRouter } from './season';
import { feedbackRouter } from './feedback';
import { authRouter, adminUsernamesFromEnv } from './auth';
import { crazyGamesRouter } from './crazygames';
import { adminApiTokenEnabled, adminRouter, setLiveCountsSource } from './admin';
import { syncAdminsFromEnv } from './db';
import { attachElyxionWs } from './elyxion-game';

const ELYXION_WS_PATH = '/ws/elyxion';
// Pre-rename clients (cached HTML) may still dial the old path — accept it.
const ELYXION_WS_LEGACY_PATH = '/ws/instagib';

// Process-level safety net: a single uncaught throw (a `ws` internal error, a
// timer callback, an unexpected exception) must NOT take the whole server — and
// every connected player — down. Log and keep serving; the alpha favors uptime.
process.on('uncaughtException', (err) => console.error('[fatal] uncaughtException', err));
process.on('unhandledRejection', (reason) => console.error('[fatal] unhandledRejection', reason));

const dev = process.env.NODE_ENV !== 'production';
const host = process.env.HOST || (dev ? 'localhost' : '0.0.0.0');
const port = parseInt(process.env.PORT || '8787', 10);

const distDir = path.join(process.cwd(), 'dist');
const indexHtml = path.join(distDir, 'index.html');
const hasBuild = fs.existsSync(indexHtml);

// A private / loopback / mDNS hostname — i.e. something only reachable from the
// same machine or LAN. In dev we trust these so `npm run dev:lan` works when a
// phone or second laptop loads the app from this machine's WiFi IP.
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
    // CRAZYGAMES cross-origin hosting: the embed origins allowed to call the
    // API (CG_API_ORIGINS) may also open the game socket.
    if (API_EMBED_ORIGINS.includes(originUrl.origin)) return true;
    // In dev, trust loopback AND private-LAN origins so LAN testing works
    // regardless of how the dev proxy rewrites the Host header.
    if (dev && isPrivateHost(originUrl.hostname)) return true;
    // Fallback: same-origin (handles dynamic domains / no APP_BASE_URL set).
    return originUrl.host === hostHeader;
  } catch {
    return false;
  }
};

const app = express();
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
// images allow data:/blob: for three.js canvas textures. The public game entry
// routes are the only pages that can be framed by approved game portals;
// /admin, /docs, auth, API, and every other route remain frame-blocked.
// HSTS is prod-only (TLS lives at the platform edge); sending it in local http
// dev would poison the browser. Vite's React plugin injects a small inline
// preamble in development, so allow inline scripts only for the dev middleware.
const EMBEDDABLE_PATHS = new Set(['/','/play']);
const DEFAULT_EMBED_ORIGINS = [
  'https://crazygames.com',
  'https://*.crazygames.com',
  'https://poki.com',
  'https://*.poki.com',
];
const configuredEmbedOrigins = (process.env.EMBED_ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((origin) => origin.trim())
  .filter((origin) => /^https:\/\/(\*\.)?[a-z0-9.-]+(?::\\d+)?$/i.test(origin));
const embedOrigins = [...new Set([...DEFAULT_EMBED_ORIGINS, ...configuredEmbedOrigins])];
const CSP_BASE = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "img-src 'self' data: blob: https://avatars.crazygames.com https://*.crazygames.com",
  "media-src 'self'",
  // CrazyGames SDK script (index.html) + its ad/banners: required when the game
  // runs on our origin with the SDK enabled (QA runs, embeds); harmless when off.
  "script-src 'self' https://sdk.crazygames.com" + (dev ? " 'unsafe-inline'" : ''),
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  // blob:/data: are needed by three.js: GLTFLoader decodes GLB-embedded textures
  // (e.g. the character model) by creating a blob: URL and fetch()-ing it, which
  // connect-src governs — without blob: those textures silently fail to load.
  // CrazyGames SDK endpoints (ads, user, data) when the SDK is enabled here.
  "connect-src 'self' blob: data: https://sdk.crazygames.com https://*.crazygames.com",
  "frame-src https://sdk.crazygames.com https://*.crazygames.com",
  "worker-src 'self' blob:",
  "form-action 'self'",
].join('; ');
app.use((req, res, next) => {
  const embeddable = EMBEDDABLE_PATHS.has(req.path);
  res.setHeader(
    'Content-Security-Policy',
    `${CSP_BASE}; frame-ancestors ${embeddable ? `'self' ${embedOrigins.join(' ')}` : "'none'"}`,
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (!embeddable) res.setHeader('X-Frame-Options', 'DENY');
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

// ── Cross-origin API hosting (CrazyGames) ────────────────────────────────
// When the bundle runs on CrazyGames' domain it still needs accounts,
// progression, and stats — served from THIS origin (VITE_API_BASE at build
// time). Those are credentialed cross-origin calls, so echo the requester's
// origin and allow the session cookie (SameSite=Lax would otherwise be dropped
// on the cross-site POST). The CG_API_ORIGINS env var lists the embed origins
// that may call the API (comma-separated, e.g. https://www.crazygames.com); the
// server's own origin is always allowed implicitly. No cors dependency needed.
const API_EMBED_ORIGINS = (process.env.CG_API_ORIGINS ?? '')
  .split(',')
  .map((o) => o.trim())
  .filter((o) => /^https:\/\/[a-z0-9.-]+(?::\d+)?$/i.test(o));
const hasApiEmbeds = API_EMBED_ORIGINS.length > 0;
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (
    hasApiEmbeds &&
    typeof origin === 'string' &&
    origin !== '' &&
    API_EMBED_ORIGINS.includes(origin)
  ) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization',
    );
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  }
  // Preflight for credentialed POSTs from the embed origins.
  if (req.method === 'OPTIONS' && res.getHeader('Access-Control-Allow-Origin')) {
    res.sendStatus(204);
    return;
  }
  next();
});

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
app.use('/api', seasonRouter);
app.use('/api', feedbackRouter);
app.use('/api', crazyGamesRouter); // CrazyGames account linking (POST /api/auth/crazygames)
app.use('/api/admin', adminRouter);

// Promote any configured ADMIN_USERNAMES that already have accounts (idempotent;
// new accounts are promoted at registration). Set ADMIN_USERNAMES on Railway and
// redeploy to claim your account.
{
  const admins = adminUsernamesFromEnv();
  const n = syncAdminsFromEnv(admins);
  if (admins.length) console.log(`[admin] ADMIN_USERNAMES=[${admins.join(', ')}] — ${n} synced`);
}

const server = http.createServer(app);
server.on('error', (err) => console.error('[server] error', err));

if (!dev && hasBuild) {
  // Long-cache fingerprinted assets; never cache the HTML shell.
  app.use(
    express.static(distDir, {
      index: false,
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html')) {
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
  // Per-route canonical: the shell hardcodes `canonical: https://instagib.win/`,
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
        .replaceAll('href="https://instagib.win/"', `href="https://instagib.win${route}"`)
        .replaceAll('content="https://instagib.win/"', `content="https://instagib.win${route}"`),
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

// Vite shares the Node listener in development. Passing `server` lets its HMR
// WebSocket upgrade on this port instead of opening a second dev-server port.
if (dev) {
  const { createServer: createViteServer } = await import('vite');
  const vite = await createViteServer({
    server: { middlewareMode: true, hmr: { server } },
    appType: 'spa',
  });
  app.use(vite.middlewares);
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

// Game socket runs on the same HTTP server so it shares the port (and any TLS
// terminator / tunnel in front of it). `maxPayload` caps a single inbound frame
// (legit game messages are a few hundred bytes) so a modified client can't OOM
// the process with one giant frame; perMessageDeflate off avoids decompression
// amplification.
const instagibWss = new WebSocketServer({
  noServer: true,
  maxPayload: 16 * 1024,
  perMessageDeflate: false,
});
({ liveCounts } = attachElyxionWs(instagibWss));
// Let the token-gated metrics API report live concurrency too (one-call /report).
setLiveCountsSource(liveCounts);
instagibWss.on('error', (err) => console.error('[ws] server error', err));

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

server.on('upgrade', (req, socket, head) => {
  const { url } = req;
  const pathname = url ? url.split('?')[0] : '';
  if (pathname !== ELYXION_WS_PATH && pathname !== ELYXION_WS_LEGACY_PATH) {
    // Vite owns its `vite-hmr` upgrade in development. All other unknown
    // upgrades are rejected so they cannot leave an idle socket behind.
    const protocol = req.headers['sec-websocket-protocol'];
    const isViteHmr = typeof protocol === 'string' && protocol.includes('vite-hmr');
    if (!dev || !isViteHmr) socket.destroy();
    return;
  }
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
  instagibWss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
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
    instagibWss.emit('connection', ws, req);
  });
});

// Heartbeat: terminate sockets that stop answering pings (half-open TCP, yanked
// network) so dead peers don't hold game slots until the app-level stale sweep.
const wsHeartbeat = setInterval(() => {
  for (const ws of instagibWss.clients) {
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

server.listen(port, host, () => {
  console.log(`> Elyxion server ready on http://${host}:${port}`);
  console.log(`>   game socket:  ws://${host}:${port}${ELYXION_WS_PATH}`);
  console.log(`>   stats api:    http://${host}:${port}/api/stats`);
  console.log(
    `>   metrics api:  http://${host}:${port}/api/admin/metrics/report ` +
      `(token auth ${adminApiTokenEnabled ? 'ENABLED' : 'disabled — set ADMIN_API_TOKEN'})`,
  );
  if (dev) console.log('>   dev mode: Vite client and HMR share this port.');
});
