// Smoke test: anticheat violations → auto-ban → enforcement → admin lift.
// Run: DATA_DIR=$(mktemp -d) npx tsx scripts/smoke-anticheat.ts
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR ??= mkdtempSync(path.join(os.tmpdir(), 'elyxion-ac-smoke-'));
process.env.ADMIN_USERNAMES ??= 'boss';

const bans = await import('../server/bans');
const db = await import('../server/db');

let failed = 0;
const assert = (cond: boolean, label: string) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failed++;
};

// Seed a cheater account.
db.createUser({
  id: 'cheater', username: 'Cheater', usernameLower: 'cheater',
  pwHash: 'x', pwSalt: 'x', email: null, createdAt: Date.now(),
});

// Log 12 violations (as the game's reportViolation does), auto-ban fires on the 12th.
let lastBan = null;
for (let i = 0; i < 12; i++) {
  bans.logAnticheatViolation({ playerId: 'cheater', playerName: 'Cheater', guard: 'move_speed', detail: `v${i}` });
  lastBan = bans.autoBanIfWarranted({
    playerId: 'cheater', playerName: 'Cheater', guard: 'move_speed',
    windowMs: 10 * 60_000, threshold: 12, durationMs: 24 * 60 * 60_000,
  });
}
assert(lastBan !== null, `auto-ban at threshold (got ${lastBan ? 'ban' : 'null'})`);
assert(bans.getActiveBan('cheater') !== null, 'active ban readable');

// Further auto-bans don't stack while banned.
const noStack = bans.autoBanIfWarranted({
  playerId: 'cheater', playerName: 'Cheater', guard: 'move_speed',
  windowMs: 10 * 60_000, threshold: 1, durationMs: 24 * 60 * 60_000,
});
assert(noStack === null, 'no ban stacking while active');

// Violations recorded and queryable.
assert(bans.countViolations('cheater', Date.now() - 10 * 60_000) === 12, 'violation count = 12');
assert(bans.listRecentViolations(10).length === 10, 'recent feed respects limit');
assert(bans.listRecentViolations(50).length === 12, 'recent feed has all 12');
assert(bans.listPlayerViolations('cheater').length === 12, 'per-player history works');

// Lift the ban.
const active = bans.getActiveBan('cheater')!;
assert(bans.liftBan(active.id, 'admin1'), 'lift succeeds');
assert(bans.getActiveBan('cheater') === null, 'ban cleared after lift');
assert(bans.listBanHistory(10)[0].lifted, 'history shows lifted');

// Fresh manual ban + evidence attachment.
const ban2 = bans.issueBan({
  playerId: 'cheater', playerName: 'Cheater', reason: 'wallhack',
  durationMs: null, source: 'admin', issuedBy: 'admin1',
});
bans.attachBanEvidence(ban2.id, 'weekly:cheater', 'clip of the run');
assert(bans.getBanEvidence(ban2.id).length === 1, 'evidence attached');
assert(bans.getActiveBan('cheater') !== null, 're-ban active');

// Admin user can't be confused: unknown player has no ban.
assert(bans.getActiveBan('nobody') === null, 'unknown player clean');

process.exit(failed ? 1 : 0);
