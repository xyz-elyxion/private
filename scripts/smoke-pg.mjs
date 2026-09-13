// One-shot E2E verification of the PostgreSQL backend (not part of the app).
// Boots a throwaway PostgreSQL using the binaries shipped with the
// `embedded-postgres` npm package (dev-only), managed via `su postgres` — the
// standard root→postgres transition, which works in restricted sandboxes where
// Node's uid/gid spawn options are blocked by AppArmor. Then points
// DATABASE_URL at it and exercises the real data layer end-to-end: schema
// bootstrap, account creation, lookups, feedback (lastInsertRowid), flag
// updates, and a full recordMatch → stats readback through the translated
// upserts.
// Run: node scripts/smoke-pg.mjs   (as root; silently falls back to sqlite
// checks if no postgres user/binaries are available)
import { spawn, execSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PG_PORT = 55432;
const PG_BIN = 'node_modules/@embedded-postgres/linux-x64/native/bin';
const PG_LIB = process.cwd() + '/node_modules/@embedded-postgres/linux-x64/native/lib';
const PG_SHARE = process.cwd() + '/node_modules/@embedded-postgres/linux-x64/native/share';
const dataDir = mkdtempSync(path.join(os.tmpdir(), 'elyxion-pg-data-'));
const pgData = path.join(os.tmpdir(), 'elyxion-pg-db-' + Date.now());

let pgProc = null;
let pgAvailable = true;
// The postgres user usually cannot traverse the project dir (mode 750), so
// copy the bundled binaries to a chowned staging dir in /tmp and run there.
const stage = path.join(os.tmpdir(), 'elyxion-pg-bin-' + Date.now());

const su = (cmd) =>
  // LD_LIBRARY_PATH is required: the bundled binaries link against the
  // bundled libpq/libcrypto, not any system copies.
  execSync(`su -s /bin/sh postgres -c "export LD_LIBRARY_PATH=${stage}/lib && ${cmd.replace(/"/g, '\\"')}"`, { stdio: 'pipe' }).toString();

try {
  if (!existsSync(PG_BIN) || execSync('id -u postgres 2>/dev/null || true').toString().trim() === '') {
    throw new Error('postgres binaries or user unavailable');
  }
  fs_chownDir(stage);
  execSync(`cp -r ${PG_BIN} ${PG_LIB} ${PG_SHARE} ${stage}/ && chown -R postgres:postgres ${stage} && chmod -R u+rwX ${stage}`);
  const bin = path.join(stage, 'bin');
  const lib = path.join(stage, 'lib');

  // Fresh (empty) data dir, owned by postgres — the pwfile is created inside
  // it before initdb, and initdb requires an empty target.
  fs_chownDir(pgData);
  su(`echo pw > ${stage}/pwfile && chmod 600 ${stage}/pwfile`);
  // -L points at the staged share/ dir (initdb locates postgres.bki relative
  // to its own path by default, which breaks when staged outside the install
  // layout).
  su(`${bin}/initdb -L ${stage}/share/postgresql --pgdata=${pgData} --auth=password --username=postgres --pwfile=${stage}/pwfile --lc-messages=C`);
  su(`rm ${stage}/pwfile`);  pgProc = spawn(
    'su',
    ['-s', '/bin/sh', 'postgres', '-c', `${bin}/postgres -D ${pgData} -p ${PG_PORT} -c listen_addresses=127.0.0.1 -c fsync=off`],
    { stdio: ['ignore', 'pipe', 'pipe'], detached: false },
  );
  let pgLog = '';
  pgProc.stderr?.on('data', (d) => (pgLog += d));
  pgProc.on('error', (e) => (pgLog += 'SPAWN ERROR: ' + e.message));
  // The bundled package ships only initdb/pg_ctl/postgres (no pg_isready),
  // so readiness is probed with a raw TCP connect.
  const up = await waitFor(async () => {
    try {
      const net = await import('node:net');
      await new Promise((resolve, reject) => {
        const s = net.createConnection({ host: '127.0.0.1', port: PG_PORT }, () => {
          s.end();
          resolve(undefined);
        });
        s.on('error', reject);
        s.setTimeout(2000, () => {
          s.destroy();
          reject(new Error('timeout'));
        });
      });
      return true;
    } catch {
      return false;
    }
  }, 20_000);
  // Keep the process referenced so the child isn't reaped while checks run.
  pgProc.unref?.();
  if (!up) throw new Error('embedded postgres did not become ready\n' + pgLog.slice(-1500));
  // No createdb/psql in the bundled package — create the database through
  // the pg client (a runtime dependency).
  const { Client } = await import('pg');
  const admin = new Client({ host: '127.0.0.1', port: PG_PORT, user: 'postgres', password: 'pw', database: 'postgres' });
  await admin.connect();
  await admin.query('CREATE DATABASE elyxion');
  await admin.end();

  process.env.DATA_DIR = dataDir;
  process.env.DATABASE_URL = `postgres://postgres:pw@127.0.0.1:${PG_PORT}/elyxion`;
  delete process.env.POSTGRES_URL;
  delete process.env.POSTGRESQL_URL;

  await runDbChecks(true);
} catch (err) {
  if (!pgAvailable) {
    console.log(`SKIP  postgres unavailable (${err.message}) — sqlite-only run`);
    process.env.DATA_DIR = dataDir;
    await runDbChecks(false);
  } else {
    console.error('PG SMOKE ERROR:', err?.message ?? err);
    console.error(err?.stack?.split('\n').slice(0, 6).join('\n'));
    process.exitCode = 1;
  }
} finally {
  try {
    if (pgProc?.pid) {
      try {
        su(`${bin}/pg_ctl -D ${pgData} -m immediate stop`);
      } catch {}
      pgProc.kill('SIGKILL');
    }
  } catch {}
  try {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(pgData, { recursive: true, force: true });
    rmSync(stage, { recursive: true, force: true });
  } catch {}
}

function fs_chownDir(dir) {
  execSync(`mkdir -p ${dir} && chown postgres:postgres ${dir} && chmod 700 ${dir}`);
}

async function waitFor(fn, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    // await: fn is async — a bare Promise is always truthy.
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

async function runDbChecks(postgres) {
  const db = await import('../server/db.ts');
  let failed = 0;
  const assert = (cond, label) => {
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
    if (!cond) failed++;
  };

  db.createUser({
    id: 'u1',
    username: 'Tester',
    usernameLower: 'tester',
    pwHash: 'h',
    pwSalt: 's',
    email: null,
    createdAt: Date.now(),
  });
  const acc = db.findAccountByName('tester');
  assert(acc?.username === 'Tester', `account lookup (${acc?.username} / ${acc?.id})`);
  assert(acc?.isAdmin === false, 'isAdmin false by default');

  const fid = db.submitFeedback({ playerName: 'Tester', type: 'bug', title: 't', body: 'b' });
  assert(fid > 0, `feedback lastInsertRowid (${fid})`);

  db.setAdmin('u1', true);
  db.setVerified('u1', true);
  const acc2 = db.findAccountByName('tester');
  assert(acc2?.isAdmin === true && acc2?.isVerified === true, 'admin/verified flags persist');

  const r = db.recordMatch({
    playerId: 'u1',
    userName: 'Tester',
    mode: 'ffa',
    kills: 5,
    deaths: 2,
    headshots: 1,
    shotsFired: 10,
    shotsHit: 7,
    won: true,
    durationMs: 60_000,
    offline: false,
  });
  assert(typeof r.xpGained === 'number' && r.xpGained > 0, `recordMatch xp (${r.xpGained})`);

  const s = db.getStats('u1');
  assert(s.kills === 5 && s.deaths === 2, `stats readback (k${s.kills}/d${s.deaths})`);
  assert(s.bestKillStreak === 5, `scalar max→GREATEST upsert (streak ${s.bestKillStreak})`);

  db.addFriend('u1', 'u1'); // self-friend is rejected by code, but the path must not throw
  console.log('PASS  friend insert path executes');

  console.log(failed === 0 ? `\n${postgres ? 'PG' : 'SQLITE'} SMOKE OK` : `\n${failed} FAILURES`);
  if (failed > 0) process.exitCode = 1;
}
