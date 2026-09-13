// Smoke test for searchAccounts (not part of the app).
// Run: DATA_DIR=$(mktemp -d) npx tsx scripts/smoke-search.ts
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR ??= mkdtempSync(path.join(os.tmpdir(), 'elyxion-search-smoke-'));

const { searchAccounts } = await import('../server/db');
const db = await import('../server/db');

let failed = 0;
const assert = (cond: boolean, label: string) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failed++;
};

// Seed accounts with differing activity.
const mkUser = (name: string, games: number) => {
  db.createUser({
    id: `u_${name}`,
    username: name,
    usernameLower: name.toLowerCase(),
    pwHash: 'x',
    pwSalt: 'x',
    email: null,
    createdAt: Date.now(),
  });
  db.sqliteHandle.prepare(
    `INSERT INTO elyxion_stats (player_id, user_name, created_at, updated_at, total_games, total_xp, level)
     VALUES (?, 'Player', ?, ?, ?, ?, 3)`,
  ).run(`u_${name}`, Date.now(), Date.now(), games, games * 100);
};

mkUser('Alice', 50);
mkUser('Alicia', 10);
mkUser('Bob', 99);
mkUser('Saliceratops', 5);

const exact = searchAccounts('alice');
assert(exact[0]?.username === 'Alice', `exact match first (got ${exact[0]?.username})`);

const prefix = searchAccounts('al');
assert(prefix.length === 3, `prefix+substring finds 3 (got ${prefix.length})`);
assert(prefix[0]?.username === 'Alice' && prefix[1]?.username === 'Alicia', 'prefix ranked above substring');
assert(prefix[2]?.username === 'Saliceratops', 'substring last');

assert(searchAccounts('a').length === 0, 'min length 2 enforced');
assert(searchAccounts('zzz').length === 0, 'no phantom results');
assert(searchAccounts('al', 1).length === 1, 'limit respected');

process.exit(failed ? 1 : 0);
