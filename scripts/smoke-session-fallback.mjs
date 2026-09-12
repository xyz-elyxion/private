// One-shot smoke test: portal session-token fallback.
// Verifies that:
//   1. /api/auth/me echoes `token` and honors X-Session-Token cross-origin.
//   2. register/login return a token usable via the header path.
//   3. The game WebSocket binds the account when ?sess=<token> is supplied
//      cross-origin (presence shows the account name).
//   4. Same-origin requests with a stolen header token are refused (cookie-only
//      same-origin policy) — the header path requires a cross-origin signal.
// Run: node scripts/smoke-session-fallback.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

const PORT = 8978;
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = mkdtempSync(path.join(os.tmpdir(), 'elyxion-sess-'));

process.env.DATA_DIR = dataDir;
process.env.PORT = String(PORT);
process.env.NODE_ENV = 'production';
process.env.CG_API_ORIGINS = 'https://portal.example.com';
delete process.env.ADMIN_API_TOKEN;

const server = spawn('npx', ['tsx', 'server/index.ts'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: process.env,
  detached: true,
});
let log = '';
server.stdout.on('data', (d) => (log += d));
server.stderr.on('data', (d) => (log += d));

const watchdog = setTimeout(() => {
  console.error('WATCHDOG fired');
  console.error(log.slice(-2000));
  process.exit(1);
}, 120_000);
watchdog.unref?.();

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function up() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/api/live`);
      if (r.ok) return true;
    } catch {}
    await wait(500);
  }
  return false;
}

let failed = 0;
const assert = (cond, label) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failed++;
};

try {
  if (!(await up())) throw new Error(`server never came up.\n${log.slice(-2000)}`);

  // 1) Register → token in body.
  const reg = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://portal.example.com' },
    body: JSON.stringify({ username: 'sessuser', password: 'correct-horse-battery' }),
  });
  const regBody = await reg.json();
  assert(reg.ok && typeof regBody.token === 'string' && regBody.token.length > 20, `register returns token (${reg.status})`);
  const TOKEN = regBody.token;

  // 2) Cross-origin /me via header only (no cookies at all).
  const me = await fetch(`${BASE}/api/auth/me`, {
    headers: { Origin: 'https://portal.example.com', 'X-Session-Token': TOKEN },
  });
  const meBody = await me.json();
  assert(me.ok && meBody.user?.username === 'sessuser', `cross-origin header /me authenticates (${me.status} ${JSON.stringify(meBody)})`);
  assert(!!meBody.token, 'me echoes token for the client to store');

  // 3) Header token without a cross-origin signal must NOT authenticate —
  //    same-origin traffic is cookie-only. No Origin header + a same-site
  //    Sec-Fetch-Site (what a browser sends for a same-origin fetch) is the
  //    same-origin shape, so the header is ignored there.
  const meNoOrigin = await fetch(`${BASE}/api/auth/me`, {
    headers: { 'X-Session-Token': TOKEN, 'sec-fetch-site': 'same-origin' },
  });
  const meNoOriginBody = await meNoOrigin.json();
  assert(
    meNoOrigin.ok && meNoOriginBody.user === null,
    `header without cross-origin signal refused (${meNoOrigin.status} user=${JSON.stringify(meNoOriginBody.user)})`,
  );

  // 4) Presence via game socket with ?sess= binds the account cross-origin.
  const wsUrl = `${BASE.replace('http', 'ws')}/ws/elyxion?sess=${encodeURIComponent(TOKEN)}`;
  const ws = new WebSocket(wsUrl, { headers: { Origin: 'https://portal.example.com' } });
  const presence = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('presence timeout')), 10_000);
    ws.on('open', () => {
      // Mirror the real client: ask for the menu list; the server marks the
      // connection present and (coalesced) pushes the presence roster.
      ws.send(JSON.stringify({ type: 'list' }));
    });
    ws.on('message', (raw, isBinary) => {
      if (isBinary) return;
      const m = JSON.parse(raw.toString());
      if (m.type === 'presence') {
        clearTimeout(t);
        resolve(m);
      }
    });
    ws.on('error', (e) => {
      clearTimeout(t);
      reject(e);
    });
  });
  const meOnline = Array.isArray(presence.players) && presence.players.some((p) => p.name === 'sessuser');
  assert(meOnline, `WS ?sess= binds account (presence players: ${JSON.stringify(presence.players)})`);
  ws.close();

  // 5) Profile endpoint via header path (progression identity works cross-origin).
  const prof = await fetch(`${BASE}/api/profile`, {
    headers: { Origin: 'https://portal.example.com', 'X-Session-Token': TOKEN },
  });
  assert(prof.ok, `profile via header ok (${prof.status})`);

  console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILURES`);
  process.exitCode = failed === 0 ? 0 : 1;
} catch (err) {
  console.error('SMOKE ERROR:', err?.message ?? err);
  console.error(log.slice(-2500));
  process.exitCode = 1;
} finally {
  try {
    if (server.pid) process.kill(-server.pid, 'SIGKILL');
  } catch {}
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {}
}
