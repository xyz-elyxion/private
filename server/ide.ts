// Elyxion IDE — coder/code-server (vendored in .code-server-src/, .git stripped).
//
// Spawns the code-server binary bound to a loopback port and exposes it to
// users at /ide on the main Elyxion origin: HTTP requests and WebSocket
// upgrades are proxied 1:1, so people can open a full VS Code environment
// (file tree, editor, integrated terminal) and actually code on this repo's
// workspace from the browser.
//
// Access control: only logged-in Elyxion users may use the IDE (session
// cookie checked in the proxy before anything reaches code-server). The
// upstream listener is loopback-only, so the IDE is never directly reachable.

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import type { Express, NextFunction, Request, Response } from 'express';
// Reuse the real auth contract: the `igsession` cookie + session lookup.
import { accountIdFromCookieHeader } from './auth';

export const IDE_PATH = '/ide';

const CODE_SERVER_BIN = path.join(
  process.cwd(),
  '.code-server-src',
  'runtime',
  'node_modules',
  '.bin',
  'code-server',
);
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
const IDE_UPSTREAM_PORT = parseInt(process.env.IDE_PORT || '8890', 10);
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
let csReady = false;
// Set once we've confirmed the binary can't be spawned — prevents an infinite
// spawn/crash loop (and the fatal uncaughtException) on hosts without the
// runtime installed. The IDE then returns a clear 503 instead.
let csUnavailable = false;

function spawnCodeServer(): void {
  if (csProc || csUnavailable) return;
  const bin = resolveCodeServerBin();
  if (!bin) {
    console.error('[ide] code-server runtime not found in .code-server-src/runtime — install it (see .code-server-src/README.md) or set ELYXION_IDE_DISABLED=1. IDE requests will return 503.');
    csUnavailable = true;
    return;
  }
  const args = [
    '--bind-addr', `127.0.0.1:${IDE_UPSTREAM_PORT}`,
    '--auth', 'none', // we gate /ide ourselves at the proxy
    '--disable-telemetry',
    '--disable-update-check',
    '--user-data-dir', path.join(process.cwd(), '.code-server-src', 'data'),
    '--extensions-dir', path.join(process.cwd(), '.code-server-src', 'data', 'extensions'),
    IDE_WORKSPACE_DIR,
  ];
  // Run via node explicitly — entry.js is a JS file, not a shebang executable
  // on hosts where the executable bit was lost (git-tracked trees).
  csProc = spawn(process.execPath, [bin, ...args], {
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, SHELL: process.env.SHELL || '/bin/bash' },
  });
  csProc.on('exit', (code) => {
    console.log(`[ide] code-server exited (${code}); restarting in 2s…`);
    csProc = null;
    csReady = false;
    if (!process.env.ELYXION_IDE_DISABLED && !csUnavailable) setTimeout(spawnCodeServer, 2000);
  });
  csReady = true;
}

function pingUpstream(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: IDE_UPSTREAM_PORT, path: '/healthz', timeout: 1500 }, (res) => {
      res.resume();
      resolve(res.statusCode !== undefined && res.statusCode < 500);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function ensureUpstream(): Promise<boolean> {
  if (csUnavailable) return false;
  if (csReady && (await pingUpstream())) return true;
  spawnCodeServer();
  // wait up to ~15 s for readiness
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await pingUpstream()) return true;
  }
  return false;
}

// Proxy a raw HTTP request (or an upgraded WebSocket) to the code-server port.
function pipeRequest(
  req: http.IncomingMessage,
  out: http.ClientRequest,
): void {
  req.pipe(out);
  out.on('error', () => req.destroy());
}

export function mountIde(app: Express): void {
  if (!IDE_ENABLED) {
    console.log('[ide] disabled (ELYXION_IDE_DISABLED=1)');
    return;
  }
  console.log(`[ide] mounting code-server at ${IDE_PATH} (upstream 127.0.0.1:${IDE_UPSTREAM_PORT})`);

  // Auth gate + readiness probe for every /ide request.
  app.use(IDE_PATH, async (req: Request, res: Response, next: NextFunction) => {
    if (!ideUser(req)) {
      res.status(401).json({ error: 'ide_auth_required', reason: 'Sign in to Elyxion to use the IDE.' });
      return;
    }
    if (!(await ensureUpstream())) {
      res.status(503).json({ error: 'ide_unavailable', reason: 'The code-server upstream is not responding.' });
      return;
    }
    next();
  });

  // HTTP proxy — raw, no body rewrites, so streaming uploads/downloads work.
  app.use(IDE_PATH, (req: Request, res: Response) => {
    const target = http.request(
      {
        host: '127.0.0.1',
        port: IDE_UPSTREAM_PORT,
        path: req.originalUrl,
        method: req.method,
        headers: { ...req.headers, host: `127.0.0.1:${IDE_UPSTREAM_PORT}` },
      },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    target.on('error', () => {
      if (!res.headersSent) res.status(502).json({ error: 'ide_proxy_error' });
    });
    pipeRequest(req, target);
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
  const headers = { ...req.headers, host: `127.0.0.1:${IDE_UPSTREAM_PORT}` };
  const upstream = http.request(
    {
      host: '127.0.0.1',
      port: IDE_UPSTREAM_PORT,
      path: url,
      headers,
    },
  );
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
