// Elyxion IDE — coder/code-server (vendored in .code-server-src/, .git stripped).
//
// Spawns code-server listening on a UNIX SOCKET (no TCP port at all — it can
// never collide with the main server or anything else) and exposes it to
// users at /ide on the main Elyxion origin: HTTP requests and WebSocket
// upgrades are proxied 1:1 over the socket, so people can open a full VS Code
// environment (file tree, editor, integrated terminal) and actually code on
// this repo's workspace from the browser.
//
// Access control: only logged-in Elyxion users may use the IDE (session
// cookie checked in the proxy before anything reaches code-server). The
// upstream listener is a filesystem socket inside the container, so the IDE
// is never reachable from outside at all.
//
// NOTE on env leakage: code-server honors $PORT for its bind address, which
// bit us before (it grabbed the main server's port and crashed with
// EADDRINUSE). We pass PORT= explicitly in the child env AND bind to a unix
// socket, so there is no port to collide on either way.

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import type { Express, NextFunction, Request, Response } from 'express';
// Reuse the real auth contract: the `igsession` cookie + session lookup.
import { accountIdFromCookieHeader } from './auth';

export const IDE_PATH = '/ide';

// Resolve the real code-server entry (the .bin symlink can be lost when a
// git-tracked tree is deployed; fall back to the direct out/node/entry.js path).
function resolveCodeServerBin(): string | null {
  const root = path.join(
    process.cwd(),
    '.code-server-src',
    'runtime',
    'node_modules',
    'code-server',
  );
  const candidates = [
    path.join(root, 'out', 'node', 'entry.js'),
    path.join(process.cwd(), '.code-server-src', 'runtime', 'node_modules', '.bin', 'code-server'),
  ];
  for (const p of candidates) if (fs.existsSync(p)) return p;
  return null;
}

const IDE_WORKSPACE_DIR = process.cwd();
// Unix socket path — must be short enough for sockaddr_un (108 bytes) and live
// somewhere writable in every environment (including read-only-ish /app dirs
// that only allow their own subpaths). /tmp is always writable.
const IDE_SOCKET = process.env.IDE_SOCKET || '/tmp/elyxion-ide.sock';
// The IDE is always on — no opt-in flag needed. Set ELYXION_IDE_DISABLED=1 to
// turn it off explicitly (e.g. on a host where the runtime isn't installed).
const IDE_ENABLED = process.env.ELYXION_IDE_DISABLED !== '1';

interface IdeSession {
  userId: string;
}

// Validate the request against the REAL Elyxion session store: the `igsession`
// httpOnly cookie is looked up through the same auth module every other
// server route uses (accountIdFromCookieHeader resolves the token to an
// account id, '' = guest/not signed in).
function ideUser(req: Request): IdeSession | null {
  const userId = accountIdFromCookieHeader(req.headers.cookie);
  if (!userId) return null;
  return { userId };
}

let csProc: ChildProcess | null = null;
// Set once we've confirmed the binary can't be spawned — prevents an infinite
// spawn/crash loop (and the fatal uncaughtException) on hosts without the
// runtime installed. The IDE then returns a clear 503 instead.
let csUnavailable = false;

// HTTP request over the unix socket. Used for both the health probe and the
// /ide proxy — socketPath replaces host/port entirely.
function socketRequest(
  opts: Omit<http.RequestOptions, 'socketPath'>,
  cb?: (res: http.IncomingMessage) => void,
): http.ClientRequest {
  return http.request({ ...opts, socketPath: IDE_SOCKET }, cb);
}

function spawnCodeServer(): void {
  if (csProc || csUnavailable) return;
  const bin = resolveCodeServerBin();
  if (!bin) {
    console.error('[ide] code-server runtime not found in .code-server-src/runtime — install it (see .code-server-src/README.md) or set ELYXION_IDE_DISABLED=1. IDE requests will return 503.');
    csUnavailable = true;
    return;
  }
  // Prefer a bundled Node 22 (Docker image ships one at
  // .code-server-src/node22/bin/node) — code-server 4.104 is built for it.
  // Fall back to the current process's node for local dev.
  const bundledNode = path.join(process.cwd(), '.code-server-src', 'node22', 'bin', 'node');
  const nodeBin = fs.existsSync(bundledNode) ? bundledNode : process.execPath;
  // Clean any stale socket left by a previous container generation.
  try { fs.unlinkSync(IDE_SOCKET); } catch { /* didn't exist */ }
  console.log(`[ide] spawning code-server on unix socket ${IDE_SOCKET}`);
  const args = [
    '--socket', IDE_SOCKET, // unix socket — bind-addr/PORT are ignored entirely
    '--auth', 'none', // we gate /ide ourselves at the proxy
    '--disable-telemetry',
    '--disable-update-check',
    '--user-data-dir', path.join(process.cwd(), '.code-server-src', 'data'),
    '--extensions-dir', path.join(process.cwd(), '.code-server-src', 'data', 'extensions'),
    IDE_WORKSPACE_DIR,
  ];
  // Run via node explicitly — entry.js is a JS file, not a shebang executable
  // on hosts where the executable bit was lost (git-tracked trees). PORT is
  // blanked in the child env so code-server can't leak-bind the main port even
  // if it ignored --bind-addr (belt and braces).
  csProc = spawn(nodeBin, [bin, ...args], {
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, PORT: '', SHELL: process.env.SHELL || '/bin/bash' },
  });
  csProc.on('exit', (code) => {
    console.log(`[ide] code-server exited (${code}); restarting in 2s…`);
    csProc = null;
    if (!process.env.ELYXION_IDE_DISABLED && !csUnavailable) setTimeout(spawnCodeServer, 2000);
  });
  // Spawn-level failures (ENOENT, OOM kill → EAGAIN, EMFILE) arrive as an
  // 'error' event, NOT 'exit' — leaving it unhandled crashes the process.
  csProc.on('error', (err) => {
    console.error('[ide] failed to start code-server:', err.message);
    csProc = null;
  });
}

function pingUpstream(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = socketRequest({ path: '/healthz', timeout: 1500 }, (res) => {
      res.resume();
      resolve(res.statusCode !== undefined && res.statusCode < 500);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

async function ensureUpstream(): Promise<boolean> {
  if (csUnavailable) return false;
  if (await pingUpstream()) return true;
  spawnCodeServer();
  // Wait up to ~75 s for readiness. code-server's cold start (extension host
  // init on a small container) can take well over 15 s; aborting early just
  // surfaces a 503 to a user who would have seen the editor a moment later.
  for (let i = 0; i < 150; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await pingUpstream()) {
      console.log(`[ide] code-server ready after ${(i + 1) * 0.5}s`);
      return true;
    }
  }
  console.error('[ide] code-server did not become ready within 75s (check container memory — it may be OOM-killed)');
  return false;
}

export function mountIde(app: Express): void {
  if (!IDE_ENABLED) {
    console.log('[ide] disabled (ELYXION_IDE_DISABLED=1)');
    return;
  }
  console.log(`[ide] mounting code-server at ${IDE_PATH} (upstream unix:${IDE_SOCKET})`);

  // code-server serves everything at ROOT (/) and does not support subpath
  // hosting — its workbench HTML references absolute asset paths like
  // /static/... and /webview/.... So we do a two-part proxy:
  //
  //   1. /ide/*        → code-server with the /ide prefix stripped (the
  //                      entry point + anything the workbench loads relative
  //                      to it), and
  //   2. known absolute asset prefixes → code-server verbatim (the workbench
  //                      fetches these from site root because it thinks it IS
  //                      the root).
  //
  // Both legs pass the same auth gate.
  const IDE_ASSET_PREFIXES = [
    '/static/',
    '/webview/',
    '/vscode-',
    '/locales/',
    '/manifest.json',
    '/favicon.ico',
    '/_static/',
  ];

  const gate = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!ideUser(req)) {
      res.status(401).json({ error: 'ide_auth_required', reason: 'Sign in to Elyxion to use the IDE.' });
      return;
    }
    if (!(await ensureUpstream())) {
      res.status(503).json({ error: 'ide_unavailable', reason: 'The code-server upstream is not responding.' });
      return;
    }
    next();
  };

  const proxy = (upstreamPath: string) => (req: Request, res: Response) => {
    const target = socketRequest(
      {
        path: upstreamPath + (req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : ''),
        method: req.method,
        headers: { ...req.headers, host: 'elyxion-ide' },
      },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    target.on('error', () => {
      if (!res.headersSent) res.status(502).json({ error: 'ide_proxy_error' });
    });
    req.pipe(target);
    target.on('error', () => req.destroy());
  };

  // Leg 2 FIRST: absolute asset fetches from the workbench (path = /static/…). Must
  // be registered before the /ide leg since Express matches in order and these
  // don't overlap anyway.
  for (const prefix of IDE_ASSET_PREFIXES) {
    app.use(prefix, gate, (req: Request, res: Response) => proxy(req.originalUrl)(req, res));
  }

  // Leg 1: the IDE itself, prefix stripped (code-server serves at /).
  app.use(IDE_PATH, gate, (req: Request, res: Response) => {
    const suffix = req.originalUrl.slice(IDE_PATH.length) || '/';
    proxy(suffix.startsWith('/') ? suffix : '/' + suffix)(req, res);
  });
}

// WebSocket upgrade passthrough for code-server (VS Code's remote agent, the
// integrated terminal, and extension host all speak over websockets). Wire
// this into server/index.ts's `upgrade` handler.
export function handleIdeUpgrade(
  req: http.IncomingMessage,
  socket: net.Socket,
  head: Buffer,
): boolean {
  const url = req.url ?? '';
  if (!url.startsWith(IDE_PATH)) return false;
  // Strip the /ide prefix — code-server speaks at root on its socket.
  const upstreamUrl = url.slice(IDE_PATH.length) || '/';
  const upstream = socketRequest({
    path: upstreamUrl.startsWith('/') ? upstreamUrl : '/' + upstreamUrl,
    headers: { ...req.headers, host: 'elyxion-ide' },
  });
  upstream.end(head);
  upstream.on('upgrade', (uRes, upSocket, upHead) => {
    const lines = ['HTTP/1.1 101 Switching Protocols'];
    for (const [k, v] of Object.entries(uRes.headers)) {
      if (v) lines.push(`${k}: ${Array.isArray(v) ? v.join(', ') : v}`);
    }
    socket.write(lines.join('\r\n') + '\r\n\r\n');
    if (upHead?.length) socket.write(upHead);
    upSocket.pipe(socket);
    socket.pipe(upSocket);
  });
  upstream.on('error', () => socket.destroy());
  return true;
}
