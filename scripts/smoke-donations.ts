// Smoke test for the credits-only donations data layer (not part of the app).
// Run with a throwaway database:  DATA_DIR=$(mktemp -d) npx tsx scripts/smoke-donations.ts
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR ??= mkdtempSync(path.join(os.tmpdir(), 'elyxion-donate-smoke-'));

const {
  presenceHeartbeat,
  presenceList,
  donateCredits,
  donationState,
  creditsBalance,
} = await import('../server/donations-db');
const db = await import('../server/db');

let failed = 0;
const assert = (cond: boolean, label: string) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failed++;
};

// Seed progression rows + balances directly (donations require elyxion_stats rows).
const setCredits = (playerId: string, credits: number) => {
  db.sqliteHandle.prepare(
    `INSERT INTO elyxion_stats (player_id, user_name, created_at, updated_at, credits)
     VALUES (?, 'Player', ?, ?, ?)
     ON CONFLICT(player_id) DO UPDATE SET credits = excluded.credits, updated_at = excluded.updated_at`,
  ).run(playerId, Date.now(), Date.now(), credits);
};

setCredits('p1', 1000);
setCredits('p2', 0);
presenceHeartbeat({ playerId: 'p1', name: 'Alice' });
presenceHeartbeat({ playerId: 'p2', name: 'Bob' });

// Exact split: 500 / 2 present = 250 each. Donor p1 ends at 1000 - 500 + 250 = 750.
const r = donateCredits({ playerId: 'p1', donorName: 'Alice', amount: 500, sessionId: 'g1' });
assert(r.ok, 'donate ok');
assert(r.recipients === 2, `2 recipients (got ${r.recipients})`);
assert(r.each === 250, `250 each (got ${r.each})`);
assert(creditsBalance('p1') === 750, `donor balance 750 (got ${creditsBalance('p1')})`);
assert(creditsBalance('p2') === 250, `recipient balance 250 (got ${creditsBalance('p2')})`);

// Insufficient: p2 has 250, tries 1000.
const poor = donateCredits({ playerId: 'p2', donorName: 'Bob', amount: 1000, sessionId: 'g2' });
assert(!poor.ok && poor.reason === 'insufficient', 'insufficient rejected');
assert(creditsBalance('p2') === 250, 'balance untouched after refusal');

// Bad amount.
const bad = donateCredits({ playerId: 'p1', donorName: 'Alice', amount: 50, sessionId: 'g3' });
assert(!bad.ok && bad.reason === 'bad_amount', 'below-minimum rejected');

const s = donationState();
assert(s.recent.length === 1 && s.recent[0].credits === 500, 'history records the donation');
assert(presenceList().length === 2, 'presence intact after payout');

process.exit(failed ? 1 : 0);
