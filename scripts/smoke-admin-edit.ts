// Smoke test for the admin progression management layer (not part of the app).
// Run: DATA_DIR=$(mktemp -d) npx tsx scripts/smoke-admin-edit.ts
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR ??= mkdtempSync(path.join(os.tmpdir(), 'elyxion-admin-edit-smoke-'));
process.env.ADMIN_USERNAMES ??= 'boss';

const db = await import('../server/db');

let failed = 0;
const assert = (cond: boolean, label: string) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failed++;
};

db.createUser({
  id: 'a1', username: 'boss', usernameLower: 'boss',
  pwHash: 'x', pwSalt: 'x', email: null, createdAt: Date.now(),
});
db.sqliteHandle
  .prepare(
    `INSERT INTO elyxion_stats (player_id, user_name, created_at, updated_at, total_xp, credits, total_kills, total_deaths, total_games, headshots, best_kill_streak)
     VALUES ('a1','boss',?,?,?,?,10,5,3,2,1)`,
  )
  .run(Date.now(), Date.now(), 100, 50);

// Delta grant.
const d = db.applyAdminProgressionDelta('a1', { xp: 5000, credits: 250 });
assert(!!d, 'delta applied');
assert(d?.after.totalXp === 5100, `xp 100+5000=5100 (got ${d?.after.totalXp})`);
assert(d?.after.credits === 300, `credits 50+250=300 (got ${d?.after.credits})`);
assert((d?.after.level ?? 0) > 1, 'level recomputed from new XP');

// Absolute patch, including a kill-count correction.
const p = db.applyAdminProgressionPatch('a1', { totalXp: 120000, credits: 0, totalKills: 999 });
assert(!!p, 'patch applied');
assert(p?.after.totalXp === 120000 && p?.after.credits === 0 && p?.after.totalKills === 999, 'patch fields set');
assert((p?.after.level ?? 0) >= 2 && p!.after.level === (await import('../src/game/progression')).levelForXp(120000), 'level matches curve for set XP');
assert(p?.before.totalXp === 5100, 'before-values recorded for the audit trail');

// Floor at zero.
const neg = db.applyAdminProgressionDelta('a1', { xp: -999999, credits: -999999 });
assert(neg?.after.totalXp === 0 && neg?.after.credits === 0, 'deltas floor at zero');

// Unknown player.
assert(db.getAdminPlayerProgression('nobody') === null, 'unknown player returns null');

process.exit(failed ? 1 : 0);
