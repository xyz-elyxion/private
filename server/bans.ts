// Ban + anticheat-violation data layer.
//
// Bans are permanent rows with an optional expires_at; a ban is "active" while
// now < expires_at (or no expiry). Checked on the WS upgrade path and login —
// the two doors into the game. Every issue/lift is audit-logged by callers.
// Anticheat violations are append-only evidence records so admins can review
// WHAT a player did before banning (which guard fired, how often).
import { sqliteHandle as sqlite, logEvent } from './db';

sqlite.exec(`
CREATE TABLE IF NOT EXISTS elyxion_bans (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id   TEXT NOT NULL,
  player_name TEXT NOT NULL DEFAULT '',
  reason      TEXT NOT NULL DEFAULT '',
  source      TEXT NOT NULL DEFAULT 'admin',   -- 'admin' | 'anticheat'
  issued_by   TEXT NOT NULL DEFAULT '',        -- admin account id (or 'anticheat')
  issued_at   INTEGER NOT NULL,
  expires_at  INTEGER,                          -- NULL = permanent
  lifted_at   INTEGER,
  lifted_by   TEXT
);
CREATE INDEX IF NOT EXISTS idx_bans_player ON elyxion_bans(player_id);
CREATE INDEX IF NOT EXISTS idx_bans_active ON elyxion_bans(expires_at);

CREATE TABLE IF NOT EXISTS elyxion_ban_evidence (
  ban_id      INTEGER NOT NULL,
  replay_key  TEXT NOT NULL,   -- 'weekly:<playerId>' or similar locator
  note        TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS elyxion_anticheat (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL,
  player_id   TEXT NOT NULL,
  player_name TEXT NOT NULL DEFAULT '',
  guard       TEXT NOT NULL,        -- which server-side guard fired
  detail      TEXT NOT NULL DEFAULT '',
  room_id     TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_ac_player ON elyxion_anticheat(player_id, ts);
CREATE INDEX IF NOT EXISTS idx_ac_ts ON elyxion_anticheat(ts);
`);

type BanRow = {
  id: number;
  player_id: string;
  player_name: string;
  reason: string;
  source: string;
  issued_by: string;
  issued_at: number;
  expires_at: number | null;
  lifted_at: number | null;
};

const banInsertStmt = sqlite.prepare(`
  INSERT INTO elyxion_bans (player_id, player_name, reason, source, issued_by, issued_at, expires_at)
  VALUES (@playerId, @playerName, @reason, @source, @issuedBy, @now, @expiresAt)`);

const activeBanStmt = sqlite.prepare(`
  SELECT * FROM elyxion_bans
   WHERE player_id = ? AND lifted_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
   ORDER BY issued_at DESC LIMIT 1`);

const recentBanStmt = sqlite.prepare(`
  SELECT * FROM elyxion_bans WHERE player_id = ? ORDER BY issued_at DESC LIMIT 1`);

const banLiftStmt = sqlite.prepare(`
  UPDATE elyxion_bans SET lifted_at = @now, lifted_by = @liftedBy
   WHERE id = @id AND lifted_at IS NULL`);

const bansListStmt = sqlite.prepare(`
  SELECT * FROM elyxion_bans
   WHERE lifted_at IS NULL AND (expires_at IS NULL OR expires_at > @now)
   ORDER BY issued_at DESC LIMIT ?`);

const bansHistoryStmt = sqlite.prepare(`
  SELECT * FROM elyxion_bans ORDER BY issued_at DESC LIMIT ?`);

const banByIdStmt = sqlite.prepare(`SELECT * FROM elyxion_bans WHERE id = ?`);

const acInsertStmt = sqlite.prepare(`
  INSERT INTO elyxion_anticheat (ts, player_id, player_name, guard, detail, room_id)
  VALUES (@ts, @playerId, @playerName, @guard, @detail, @roomId)`);

const acCountStmt = sqlite.prepare(`
  SELECT COUNT(*) AS n FROM elyxion_anticheat WHERE player_id = ? AND ts > ?`);

const acRecentStmt = sqlite.prepare(`
  SELECT * FROM elyxion_anticheat ORDER BY ts DESC LIMIT ?`);

const acForPlayerStmt = sqlite.prepare(`
  SELECT * FROM elyxion_anticheat WHERE player_id = ? ORDER BY ts DESC LIMIT 50`);

export type BanInfo = {
  id: number;
  playerId: string;
  playerName: string;
  reason: string;
  source: string;
  issuedBy: string;
  issuedAt: number;
  expiresAt: number | null;
  lifted: boolean;
};

const toBanInfo = (r: BanRow): BanInfo => ({
  id: r.id,
  playerId: r.player_id,
  playerName: r.player_name,
  reason: r.reason,
  source: r.source,
  issuedBy: r.issued_by,
  issuedAt: r.issued_at,
  expiresAt: r.expires_at,
  lifted: r.lifted_at != null,
});

/**
 * The player's active ban, or null. Enforced by the WS upgrade + login paths.
 * @param includeExpired return the most recent ban even if expired/lifted (for messaging).
 */
export function getActiveBan(playerId: string, includeExpired = false): BanInfo | null {
  if (!playerId) return null;
  const now = Date.now();
  const row = includeExpired
    ? (recentBanStmt.get(playerId) as BanRow | undefined)
    : (activeBanStmt.get(playerId, now) as BanRow | undefined);
  return row ? toBanInfo(row) : null;
}

/**
 * Issue a ban. Duration: null = permanent, otherwise milliseconds. Re-banning
 * an already-banned player inserts a second row (superseding) — the newest
 * active row wins in getActiveBan. Callers audit-log this action.
 */
export function issueBan(b: {
  playerId: string;
  playerName: string;
  reason: string;
  durationMs: number | null;
  source: 'admin' | 'anticheat' | 'moderation';
  issuedBy: string;
}): BanInfo {
  const now = Date.now();
  const expiresAt = b.durationMs != null && b.durationMs > 0 ? now + Math.floor(b.durationMs) : null;
  const info = banInsertStmt.run({
    playerId: b.playerId,
    playerName: (b.playerName || '').slice(0, 32),
    reason: (b.reason || '').slice(0, 500),
    source: b.source,
    issuedBy: b.issuedBy || '',
    now,
    expiresAt,
  });
  const row = banByIdStmt.get(Number(info.lastInsertRowid)) as BanRow;
  return toBanInfo(row);
}

/** Lift a ban (unban). Returns true when a row was actually lifted. */
export function liftBan(banId: number, liftedBy: string): boolean {
  const r = banLiftStmt.run({ id: banId, liftedBy: liftedBy || '', now: Date.now() });
  return r.changes > 0;
}

/** Currently-active bans for the admin dashboard. */
export function listActiveBans(limit = 100): BanInfo[] {
  return (bansListStmt.all({ now: Date.now(), limit: Math.max(1, Math.min(500, limit)) }) as BanRow[]).map(toBanInfo);
}

/** Full ban history (including lifted/expired) for the admin dashboard. */
export function listBanHistory(limit = 100): BanInfo[] {
  return (bansHistoryStmt.all(Math.max(1, Math.min(500, limit))) as BanRow[]).map(toBanInfo);
}

/** Log an anticheat violation (append-only evidence). */
export function logAnticheatViolation(v: {
  playerId: string;
  playerName: string;
  guard: string;
  detail?: string;
  roomId?: string;
}): void {
  if (!v.playerId) return;
  acInsertStmt.run({
    ts: Date.now(),
    playerId: v.playerId,
    playerName: (v.playerName || '').slice(0, 32),
    guard: (v.guard || 'unknown').slice(0, 64),
    detail: (v.detail || '').slice(0, 500),
    roomId: (v.roomId || '').slice(0, 64),
  });
}

/** How many violations has this player committed since `sinceMs`? */
export function countViolations(playerId: string, sinceMs: number): number {
  if (!playerId) return 0;
  return (acCountStmt.get(playerId, sinceMs) as { n: number } | undefined)?.n ?? 0;
}

/** Violation feed for the admin dashboard (all players, newest first). */
export function listRecentViolations(limit = 100): {
  id: number;
  ts: number;
  playerId: string;
  playerName: string;
  guard: string;
  detail: string;
  roomId: string;
}[] {
  return (
    acRecentStmt.all(Math.max(1, Math.min(500, limit))) as {
      id: number;
      ts: number;
      player_id: string;
      player_name: string;
      guard: string;
      detail: string;
      room_id: string;
    }[]
  ).map((r) => ({
    id: r.id,
    ts: r.ts,
    playerId: r.player_id,
    playerName: r.player_name,
    guard: r.guard,
    detail: r.detail,
    roomId: r.room_id,
  }));
}

/** A player's violation history (for the admin detail view). */
export function listPlayerViolations(playerId: string): ReturnType<typeof listRecentViolations> {
  return (
    acForPlayerStmt.all(playerId) as {
      id: number;
      ts: number;
      player_id: string;
      player_name: string;
      guard: string;
      detail: string;
      room_id: string;
    }[]
  ).map((r) => ({
    id: r.id,
    ts: r.ts,
    playerId: r.player_id,
    playerName: r.player_name,
    guard: r.guard,
    detail: r.detail,
    roomId: r.room_id,
  }));
}

/**
 * Auto-ban helper for the anticheat: bans a player for `durationMs` when their
 * violation count in the window crosses `threshold`. Returns the ban when one
 * was issued, else null. Audited as an anticheat action.
 */
export function autoBanIfWarranted(p: {
  playerId: string;
  playerName: string;
  guard: string;
  windowMs: number;
  threshold: number;
  durationMs: number;
}): BanInfo | null {
  const existing = getActiveBan(p.playerId);
  if (existing) return null; // already banned — don't stack rows
  const n = countViolations(p.playerId, Date.now() - p.windowMs);
  if (n < p.threshold) return null;
  const reason = `Anticheat: repeated ${p.guard} violations (${n} in ${Math.round(p.windowMs / 60000)} min)`;
  const ban = issueBan({
    playerId: p.playerId,
    playerName: p.playerName,
    reason,
    durationMs: p.durationMs,
    source: 'anticheat',
    issuedBy: 'anticheat',
  });
  logEvent({
    event: 'anticheat.autoban',
    actorId: 'anticheat',
    actorName: 'anticheat',
    targetId: p.playerId,
    detail: { target: p.playerName, guard: p.guard, violations: n, durationMs: p.durationMs, banId: ban.id },
  });
  return ban;
}

// ── Ban evidence (replay clips) ─────────────────────────────────────────────
// Link a ban to the rewatchable replay of the run it came from. The dashboard
// can then open the replay viewer straight from the ban row: the "hacking
// clip" travels with the ban.

const evidenceInsertStmt = sqlite.prepare(`
  INSERT INTO elyxion_ban_evidence (ban_id, replay_key, note, created_at)
  VALUES (@banId, @replayKey, @note, @now)`);
const evidenceForBanStmt = sqlite.prepare(`
  SELECT replay_key, note, created_at FROM elyxion_ban_evidence WHERE ban_id = ? ORDER BY created_at DESC`);

export function attachBanEvidence(banId: number, replayKey: string, note: string): void {
  evidenceInsertStmt.run({ banId, replayKey, note: note.slice(0, 300), now: Date.now() });
}

export function getBanEvidence(banId: number): { replayKey: string; note: string; createdAt: number }[] {
  return (
    evidenceForBanStmt.all(banId) as { replay_key: string; note: string; created_at: number }[]
  ).map((r) => ({ replayKey: r.replay_key, note: r.note, createdAt: r.created_at }));
}
