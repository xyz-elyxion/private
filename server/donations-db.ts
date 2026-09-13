// Donations data layer, separated from db.ts so each feature module owns its
// tables without growing db.ts further. Uses the same backend (sqlite file or
// PostgreSQL via server/pg.ts) through sqliteHandle.
//
// CREDITS-ONLY: a donation is a player giving credits from their own balance
// into the pot, split EQUALLY among every player whose presence heartbeat is
// fresher than 60s (including the donor — they're on the page too). No real
// money is involved anywhere.
import { sqliteHandle as sqlite, logEvent } from './db';

sqlite.exec(`
CREATE TABLE IF NOT EXISTS elyxion_donations (
  session_id  TEXT PRIMARY KEY,
  donor_id    TEXT NOT NULL DEFAULT '',
  donor_name  TEXT NOT NULL DEFAULT '',
  cents       INTEGER NOT NULL DEFAULT 0,
  credits     INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'committed',
  created_at  INTEGER NOT NULL,
  committed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_donations_committed ON elyxion_donations(committed_at DESC);
CREATE TABLE IF NOT EXISTS elyxion_donate_presence (
  player_id  TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  last_seen  INTEGER NOT NULL
);
`);

// History insert (session_id doubles as a random gift id).
const donationInsertStmt = sqlite.prepare(`
  INSERT INTO elyxion_donations (session_id, donor_id, donor_name, credits, status, created_at, committed_at)
  VALUES (@sessionId, @donorId, @donorName, @credits, 'committed', @now, @now)`);
const donationRecentStmt = sqlite.prepare(`
  SELECT donor_name, credits, committed_at
    FROM elyxion_donations
   WHERE status = 'committed' AND committed_at IS NOT NULL
   ORDER BY committed_at DESC LIMIT 25`);

const presenceUpsertStmt = sqlite.prepare(`
  INSERT INTO elyxion_donate_presence (player_id, name, last_seen) VALUES (@playerId, @name, @now)
  ON CONFLICT(player_id) DO UPDATE SET name = @name, last_seen = @now`);
const presenceSweepStmt = sqlite.prepare(`DELETE FROM elyxion_donate_presence WHERE last_seen < ?`);
const presenceListStmt = sqlite.prepare(`
  SELECT player_id, name, last_seen FROM elyxion_donate_presence ORDER BY name`);
const presenceCountStmt = sqlite.prepare(`SELECT COUNT(*) AS n FROM elyxion_donate_presence WHERE last_seen >= ?`);
const presenceClearStmt = sqlite.prepare(`DELETE FROM elyxion_donate_presence WHERE player_id = ?`);

// Balance read for a player (0 when they never played — donations require a
// progression row, which ensureRow creates on first interaction).
const creditsOfStmt = sqlite.prepare(`SELECT credits FROM elyxion_stats WHERE player_id = ?`);

// Atomic debit: succeeds only if the balance covers the amount.
const debitStmt = sqlite.prepare(`
  UPDATE elyxion_stats
     SET credits = credits - @amt, updated_at = @now
   WHERE player_id = @playerId AND credits >= @amt`);

// Equal credit bump for everyone present.
const payoutStmt = sqlite.prepare(`
  UPDATE elyxion_stats
     SET credits = credits + @each, updated_at = @now
   WHERE player_id IN (SELECT player_id FROM elyxion_donate_presence WHERE last_seen >= @cutoff)`);

export const DONATE_MIN = 100; // minimum gift: 100 credits
export const DONATE_MAX = 1_000_000;

export function presenceHeartbeat(p: { playerId: string; name: string }): void {
  presenceUpsertStmt.run({ ...p, name: p.name.slice(0, 32) || 'Player', now: Date.now() });
}

export function presenceList(): { playerId: string; name: string; lastSeen: number }[] {
  const now = Date.now();
  presenceSweepStmt.run(now - 60_000);
  return (presenceListStmt.all() as { player_id: string; name: string; last_seen: number }[]).map(
    (r) => ({ playerId: r.player_id, name: r.name, lastSeen: r.last_seen }),
  );
}

/** Remove a player from the Donate page presence list (called on leave/unmount). */
export function presenceRemove(playerId: string): void {
  presenceClearStmt.run(playerId);
}

export function creditsBalance(playerId: string): number {
  if (!playerId) return 0;
  const r = creditsOfStmt.get(playerId) as { credits: number | string } | undefined;
  const v = typeof r?.credits === 'string' ? Number(r.credits) : (r?.credits ?? 0);
  return Number.isFinite(v) ? v : 0;
}

/**
 * Donate `amount` credits from the caller's own balance, split EQUALLY among
 * every player present on the Donate page (including the donor). The debit is
 * atomic (credits >= amount) so a balance can never go negative through a
 * race. The donor is also a recipient, so a solo donation costs (amount -
 * floor(amount/1)) = 0 — that's intentional: gifting to an empty room is a
 * no-op for the economy. With N present, each receives floor(amount/N).
 */
export function donateCredits(p: {
  playerId: string; donorName: string; amount: number; sessionId: string;
}): { ok: boolean; reason?: 'insufficient' | 'bad_amount'; each: number; recipients: number; balance: number } {
  const PRESENCE_TTL_MS = 60_000;
  const amount = Math.floor(p.amount);
  if (!Number.isFinite(amount) || amount < DONATE_MIN || amount > DONATE_MAX) {
    return { ok: false, reason: 'bad_amount', each: 0, recipients: 0, balance: creditsBalance(p.playerId) };
  }

  const now = Date.now();
  presenceSweepStmt.run(now - PRESENCE_TTL_MS);
  const recipients = (presenceCountStmt.get(now - PRESENCE_TTL_MS) as { n: number } | undefined)?.n ?? 0;

  // Debit first (atomic); refuse if the balance can't cover it.
  const changed = debitStmt.run({ playerId: p.playerId, amt: amount, now }).changes;
  if (changed === 0) {
    return { ok: false, reason: 'insufficient', each: 0, recipients, balance: creditsBalance(p.playerId) };
  }

  // Split among the present (donor included — they're on the page).
  const each = recipients > 0 ? Math.floor(amount / recipients) : 0;
  if (each > 0) {
    payoutStmt.run({ each, now, cutoff: now - PRESENCE_TTL_MS });
  }

  donationInsertStmt.run({
    sessionId: p.sessionId,
    donorId: p.playerId,
    donorName: (p.donorName || 'Player').slice(0, 32),
    credits: amount,
    now,
  });

  logEvent({
    event: 'donation_committed',
    actorId: p.playerId,
    actorName: p.donorName,
    detail: { credits: amount, creditsEach: each, recipients },
  });

  return { ok: true, each, recipients, balance: creditsBalance(p.playerId) };
}

export function donationState(): {
  recent: { name: string; credits: number; at: number }[];
} {
  const recent = (donationRecentStmt.all() as { donor_name: string; credits: number; committed_at: number }[]).map(
    (r) => ({ name: r.donor_name, credits: r.credits, at: r.committed_at }),
  );
  return { recent };
}
