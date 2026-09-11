// One-shot smoke test for the admin portal-zip endpoint (not part of the app).
// Boots the real server in production mode against a throwaway DATA_DIR,
// registers an account pre-designated as admin via ADMIN_USERNAMES, downloads
// /api/admin/portal-zip, and validates the archive (signature, entries,
// PORTAL-README.txt presence, central-directory consistency) with unzip -t.
// Also checks that a non-admin and a bearer token are refused.
// Run: node scripts/smoke-portal-zip.mjs
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 8971;
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = mkdtempSync(path.join(os.tmpdir(), 'elyxion-zip-smoke-'));

process.env.DATA_DIR = dataDir;
process.env.PORT = String(PORT);
process.env.ADMIN_USERNAMES = 'zipadmin';
process.env.NODE_ENV = 'production';
delete process.env.ADMIN_API_TOKEN;

const server = spawn('npx', ['tsx', 'server/index.ts'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: process.env,
  detached: true, // own process group so we can kill npx AND its tsx child
});
let log = '';
server.stdout.on('data', (d) => (log += d));
server.stderr.on('data', (d) => (log += d));

// Hard watchdog: never let the harness hang the calling shell.
const watchdog = setTimeout(() => {
  console.error('WATCHDOG: smoke test exceeded 120s — aborting');
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
const cookiesOf = (res) => res.headers.getSetCookie?.().map((c) => c.split(';')[0]).join('; ') ?? '';

let failed = 0;
const assert = (cond, label) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failed++;
};

try {
  if (!(await up())) throw new Error(`server never came up.\n${log.slice(-3000)}`);

  // 1) Register the pre-designated admin account.
  const reg = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'zipadmin', password: 'correct-horse-battery' }),
  });
  assert(reg.ok, `register admin account (${reg.status})`);
  const cookie = cookiesOf(reg);
  assert(!!cookie, 'session cookie issued');

  // 2) Non-admin must be refused.
  const anon = await fetch(`${BASE}/api/admin/portal-zip`);
  assert(anon.status === 403, `anonymous refused (${anon.status})`);

  // 3) Bearer-token path must be refused (denyToken).
  const tok = await fetch(`${BASE}/api/admin/portal-zip`, {
    headers: { Authorization: 'Bearer whatever' },
  });
  assert(tok.status === 403, `bearer token refused (${tok.status})`);

  // 4) Admin session downloads the zip.
  const zip = await fetch(`${BASE}/api/admin/portal-zip`, { headers: { cookie } });
  assert(zip.ok, `admin download ok (${zip.status})`);
  assert(
    (zip.headers.get('content-type') ?? '').includes('application/zip'),
    `content-type zip (${zip.headers.get('content-type')})`,
  );
  assert(
    /attachment;\s*filename="elyxion-portal-\d{4}-\d{2}-\d{2}\.zip"/.test(zip.headers.get('content-disposition') ?? ''),
    `content-disposition (${zip.headers.get('content-disposition')})`,
  );
  const buf = Buffer.from(await zip.arrayBuffer());
  assert(buf.length > 1000, `zip has size (${(buf.length / 1e6).toFixed(1)} MB)`);
  assert(buf.readUInt32LE(0) === 0x04034b50, 'local header signature');
  // EOCD is the last 22+ bytes; comment is empty.
  const eocdOff = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert(eocdOff > 0, 'EOCD present');
  const count = eocdOff >= 0 ? buf.readUInt16LE(eocdOff + 10) : 0;
  assert(count > 10, `entry count sane (${count})`);
  assert(eocdOff + 22 === buf.length, `no trailing bytes (eocd at ${eocdOff}, len ${buf.length})`);

  // 5) The archive must pass a real unzip integrity test + contain the README.
  const zipPath = path.join(dataDir, 'portal.zip');
  writeFileSync(zipPath, buf);
  const listing = execFileSync('unzip', ['-l', zipPath]).toString();
  assert(listing.includes('PORTAL-README.txt'), 'PORTAL-README.txt present');
  assert(listing.includes('index.html'), 'index.html present');
  assert(/assets\/.*(js|css|glb|png|mp3|ogg|webm|json)/i.test(listing), 'assets included');
  execFileSync('unzip', ['-t', zipPath], { stdio: 'pipe' });
  assert(true, 'unzip -t integrity passes');

  // 6) README content sanity.
  const readme = execFileSync('unzip', ['-p', zipPath, 'PORTAL-README.txt']).toString();
  assert(readme.includes('CrazyGames'), 'README mentions CrazyGames');
  assert(readme.includes('?api='), 'README documents the cross-origin override');

  console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILURES`);
  process.exitCode = failed === 0 ? 0 : 1;
} catch (err) {
  console.error('SMOKE ERROR:', err?.message ?? err);
  console.error(log.slice(-3000));
  process.exitCode = 1;
} finally {
  clearTimeout(watchdog);
  try {
    if (server.pid) process.kill(-server.pid, 'SIGKILL');
  } catch {}
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {}
  void existsSync;
  void writeFileSync;
}
