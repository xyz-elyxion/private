// SQLite-backed stats store. Self-contained: no ORM, just better-sqlite3 with
// prepared statements. The table is created on first import (CREATE TABLE IF
// NOT EXISTS), so there are no migrations to run.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import Database from 'better-sqlite3';
import {
  baseMatchXp,
  creditsForXp,
  levelForXp,
  levelProgress,
  OFFLINE_XP_SCALE,
  PER_MATCH_XP_CAP,
  XP_FIRST_WIN_BONUS,
} from '../src/game/progression';
import {
  ALL_COSMETICS,
  caseHats,
  cosmeticById,
  defaultUnlockedIds,
  DUPE_REFUND_FRAC,
  HAT_CASE_COST,
  levelGrantsAt,
  RARITY_WEIGHT,
  slotOf,
  titleGrantsFrom,
} from '../src/game/cosmetics';
import {
  activeChallenges,
  challengeById,
  DAILY_CHALLENGES,
  DAILY_COUNT,
  dailyPeriod,
  WEEKLY_CHALLENGES,
  WEEKLY_COUNT,
  weeklyPeriod,
  type ChallengeDef,
  type ChallengeMetric,
} from '../src/game/challenges';

const dataDir = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(process.cwd(), 'data');
fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });

const databasePath = process.env.DATABASE_PATH
  ? path.resolve(process.env.DATABASE_PATH)
  : path.join(dataDir, 'elyxion.sqlite');

const sqlite = new Database(databasePath);
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('busy_timeout = 5000');
// WAL + NORMAL: fsync only at checkpoint instead of on every commit. Still crash-
// safe (only an OS/power loss in the small WAL window can lose the last few
// transactions — acceptable for game stats), and it removes a synchronous fsync
// from the shared event loop on every write. Match-end stat writes and logins no
// longer risk stalling the 64Hz game tick on a slow (e.g. network-backed) disk.
sqlite.pragma('synchronous = NORMAL');

sqlite.exec(`
CREATE TABLE IF NOT EXISTS elyxion_stats (
  player_id TEXT PRIMARY KEY,
  user_name TEXT NOT NULL,
  total_kills INTEGER NOT NULL DEFAULT 0,
  total_deaths INTEGER NOT NULL DEFAULT 0,
  total_games INTEGER NOT NULL DEFAULT 0,
  total_wins INTEGER NOT NULL DEFAULT 0,
  best_kill_streak INTEGER NOT NULL DEFAULT 0,
  headshots INTEGER NOT NULL DEFAULT 0,
  shots_fired INTEGER NOT NULL DEFAULT 0,
  shots_hit INTEGER NOT NULL DEFAULT 0,
  best_accuracy REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_elyxion_stats_kills ON elyxion_stats(total_kills);

-- Per-window (daily/weekly) leaderboard buckets. Same shape as elyxion_stats but
-- keyed by a period string ("d:YYYYMMDD" / "w:YYYYMMDD" of the week's Monday, UTC),
-- upserted alongside the all-time row on every recorded match.
CREATE TABLE IF NOT EXISTS elyxion_period_stats (
  player_id        TEXT NOT NULL,
  period_key       TEXT NOT NULL,
  user_name        TEXT NOT NULL,
  total_kills      INTEGER NOT NULL DEFAULT 0,
  total_deaths     INTEGER NOT NULL DEFAULT 0,
  total_games      INTEGER NOT NULL DEFAULT 0,
  total_wins       INTEGER NOT NULL DEFAULT 0,
  best_kill_streak INTEGER NOT NULL DEFAULT 0,
  headshots        INTEGER NOT NULL DEFAULT 0,
  best_accuracy    REAL NOT NULL DEFAULT 0,
  updated_at       INTEGER NOT NULL,
  PRIMARY KEY (player_id, period_key)
);
CREATE INDEX IF NOT EXISTS idx_period_kills ON elyxion_period_stats(period_key, total_kills);

-- Registered accounts. Progression keys off the account id (= elyxion_stats
-- player_id), so guests (no account) accrue nothing. Passwords are scrypt-hashed
-- with a per-user salt (see server/auth.ts). Email is optional, recovery-only.
CREATE TABLE IF NOT EXISTS elyxion_users (
  id             TEXT PRIMARY KEY,
  username       TEXT NOT NULL,
  username_lower TEXT NOT NULL UNIQUE,
  pw_hash        TEXT NOT NULL,
  pw_salt        TEXT NOT NULL,
  email          TEXT,
  created_at     INTEGER NOT NULL
);
-- Opaque session tokens (httpOnly cookie) → account id. Revocable; reaped on logout.
CREATE TABLE IF NOT EXISTS elyxion_sessions (
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON elyxion_sessions(user_id);

-- Moderation: banned display names (case-insensitive). The display name is the
-- server-authoritative identity for accounts (the moderated username) as well
-- as guests ("Guest N", per-room) — the only handle a moderator ever sees.
CREATE TABLE IF NOT EXISTS elyxion_bans (
  name_lower  TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  reason      TEXT NOT NULL DEFAULT '',
  banned_by   TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  -- epoch ms the ban lifts; 0 = permanent. Expired rows are inert (reads treat
  -- them as not banned) and swept periodically.
  banned_until INTEGER NOT NULL DEFAULT 0
);
-- Moderation: banned IP addresses. Guests renumber ("Guest 3" → "Guest 4") on
-- every reconnect, so a name ban alone can't stop a guest from slipping back in
-- — the source IP is the stable part. Banning an ONLINE player auto-captures
-- their IP here (banned_name ties it to the name ban so /unban <name> lifts it
-- too); addresses can also be banned directly. Enforcement is at connect.
CREATE TABLE IF NOT EXISTS elyxion_ip_bans (
  ip           TEXT PRIMARY KEY,
  reason       TEXT NOT NULL DEFAULT '',
  banned_by    TEXT NOT NULL DEFAULT '',
  banned_name  TEXT NOT NULL DEFAULT '', -- name_lower that captured this IP ('' = manual /banip)
  created_at   INTEGER NOT NULL,
  -- epoch ms the ban lifts; 0 = permanent (mirrors elyxion_bans.banned_until)
  banned_until INTEGER NOT NULL DEFAULT 0
);
-- Moderation: banned guest identities (the anonymous igpid UUID cookie). A
-- guest's per-room "Guest N" name renumbers every session, so since guests now
-- have a stable browser identity, THAT is their moderation handle: a guest ban
-- refuses the uuid at connect regardless of name or IP. Banning an ONLINE guest
-- auto-captures their IP here too (captured_name ties it to the name ban that
-- captured it, mirroring elyxion_ip_bans) so clearing cookies (fresh uuid) on
-- the same address can't dodge it. Enforcement is at connect.
CREATE TABLE IF NOT EXISTS elyxion_guest_bans (
  guest_id      TEXT PRIMARY KEY,
  reason        TEXT NOT NULL DEFAULT '',
  banned_by     TEXT NOT NULL DEFAULT '',
  captured_name TEXT NOT NULL DEFAULT '', -- name_lower that captured this guest ('' = direct ban by uuid)
  created_at    INTEGER NOT NULL,
  -- epoch ms the ban lifts; 0 = permanent (mirrors the other ban tables)
  banned_until  INTEGER NOT NULL DEFAULT 0
);
`);

// Additive progression columns. SQLite has no `ADD COLUMN IF NOT EXISTS`, and we
// run no migration framework, so guard each add against the live schema
// (docs/progression.md §2). Safe to run on every boot.
function ensureColumns() {
  const cols = new Set(
    (sqlite.prepare(`PRAGMA table_info(elyxion_stats)`).all() as { name: string }[]).map(
      (r) => r.name,
    ),
  );
  const add = (name: string, ddl: string) => {
    if (!cols.has(name)) sqlite.exec(`ALTER TABLE elyxion_stats ADD COLUMN ${ddl}`);
  };
  add('total_xp', 'total_xp INTEGER NOT NULL DEFAULT 0');
  add('level', 'level INTEGER NOT NULL DEFAULT 1');
  add('credits', 'credits INTEGER NOT NULL DEFAULT 0');
  add('unlocked', `unlocked TEXT NOT NULL DEFAULT '[]'`); // JSON array of cosmetic IDs
  add('equipped', `equipped TEXT NOT NULL DEFAULT '{}'`); // JSON map slot -> cosmetic ID
  add('first_win_day', 'first_win_day INTEGER NOT NULL DEFAULT 0'); // YYYYMMDD (UTC)
}
ensureColumns();

// Additive account-moderation columns on elyxion_users (same no-migration
// pattern): is_admin gates the /api/admin actions + grants all cosmetics;
// is_verified drives the blue "verified player" check. Both default off.
function ensureUserColumns() {
  const cols = new Set(
    (sqlite.prepare(`PRAGMA table_info(elyxion_users)`).all() as { name: string }[]).map(
      (r) => r.name,
    ),
  );
  if (!cols.has('is_admin'))
    sqlite.exec(`ALTER TABLE elyxion_users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0`);
  if (!cols.has('is_verified'))
    sqlite.exec(`ALTER TABLE elyxion_users ADD COLUMN is_verified INTEGER NOT NULL DEFAULT 0`);
}
ensureUserColumns();

// Additive ban columns (same no-migration pattern): banned_until on both ban
// tables — epoch ms the ban lifts, 0 = permanent. Live databases created before
// timed bans existed get the column added on boot.
function ensureBanColumns() {
  for (const table of ['elyxion_bans', 'elyxion_ip_bans']) {
    const cols = new Set(
      (sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((r) => r.name),
    );
    if (!cols.has('banned_until'))
      sqlite.exec(`ALTER TABLE ${table} ADD COLUMN banned_until INTEGER NOT NULL DEFAULT 0`);
  }
}
ensureBanColumns();

// Append-only audit log: account registrations, logins, recorded matches, and
// admin actions. Powers auditing now and a metrics dashboard later. `detail` is
// a small JSON blob; `ip` is best-effort (proxy-forwarded) for abuse triage.
sqlite.exec(`
CREATE TABLE IF NOT EXISTS elyxion_audit (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         INTEGER NOT NULL,
  event      TEXT NOT NULL,
  actor_id   TEXT NOT NULL DEFAULT '',
  actor_name TEXT NOT NULL DEFAULT '',
  target_id  TEXT NOT NULL DEFAULT '',
  detail     TEXT NOT NULL DEFAULT '',
  ip         TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON elyxion_audit(ts);
CREATE INDEX IF NOT EXISTS idx_audit_event ON elyxion_audit(event, ts);
`);

const insertAuditStmt = sqlite.prepare(`
  INSERT INTO elyxion_audit (ts, event, actor_id, actor_name, target_id, detail, ip)
  VALUES (@ts, @event, @actorId, @actorName, @targetId, @detail, @ip)`);

export type AuditInput = {
  event: string;
  actorId?: string;
  actorName?: string;
  targetId?: string;
  detail?: unknown;
  ip?: string;
  now?: number;
};

// Record an audit event. Never throws into the request path — a logging failure
// must not break a match submission or a login.
export function logEvent(e: AuditInput): void {
  try {
    insertAuditStmt.run({
      ts: e.now ?? Date.now(),
      event: e.event,
      actorId: e.actorId ?? '',
      actorName: e.actorName ?? '',
      targetId: e.targetId ?? '',
      detail:
        e.detail == null
          ? ''
          : typeof e.detail === 'string'
            ? e.detail.slice(0, 2000)
            : JSON.stringify(e.detail).slice(0, 2000),
      ip: (e.ip ?? '').slice(0, 64),
    });
  } catch (err) {
    console.error('[audit] log failed', err);
  }
}

export type AuditRow = {
  id: number;
  ts: number;
  event: string;
  actor_id: string;
  actor_name: string;
  target_id: string;
  detail: string;
  ip: string;
};
const auditAllStmt = sqlite.prepare(
  `SELECT * FROM elyxion_audit ORDER BY ts DESC, id DESC LIMIT ?`,
);
const auditByEventStmt = sqlite.prepare(
  `SELECT * FROM elyxion_audit WHERE event = ? ORDER BY ts DESC, id DESC LIMIT ?`,
);
export function getAuditLog(limit: number, event?: string): AuditRow[] {
  const n = Math.max(1, Math.min(500, Math.floor(limit)));
  return (event ? auditByEventStmt.all(event, n) : auditAllStmt.all(n)) as AuditRow[];
}

// ── Feedback / bug reports ───────────────────────────────────────────────────
// Player-submitted feedback (the in-game form → POST /api/feedback). Its own
// table — not the audit log — because it has a moderation status workflow. `ip`
// and `user_agent` are best-effort, for spam triage only. Surfaced in the /admin
// "Feedback" tab; never shown to other players.
sqlite.exec(`
CREATE TABLE IF NOT EXISTS elyxion_feedback (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL,
  player_id   TEXT NOT NULL DEFAULT '',
  player_name TEXT NOT NULL DEFAULT '',
  type        TEXT NOT NULL DEFAULT 'general',
  title       TEXT NOT NULL DEFAULT '',
  body        TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'open',
  ip          TEXT NOT NULL DEFAULT '',
  user_agent  TEXT NOT NULL DEFAULT '',
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_feedback_ts ON elyxion_feedback(ts);
CREATE INDEX IF NOT EXISTS idx_feedback_status ON elyxion_feedback(status, id);
`);

export type FeedbackType = 'bug' | 'feature' | 'general';
export type FeedbackStatus = 'open' | 'ack' | 'resolved' | 'spam';
export const FEEDBACK_TYPES: readonly FeedbackType[] = ['bug', 'feature', 'general'];
export const FEEDBACK_STATUSES: readonly FeedbackStatus[] = ['open', 'ack', 'resolved', 'spam'];

export type FeedbackRow = {
  id: number;
  ts: number;
  playerId: string;
  playerName: string;
  type: FeedbackType;
  title: string;
  body: string;
  status: FeedbackStatus;
  ip: string;
  userAgent: string;
  updatedAt: number;
};

type FeedbackDbRow = {
  id: number;
  ts: number;
  player_id: string;
  player_name: string;
  type: string;
  title: string;
  body: string;
  status: string;
  ip: string;
  user_agent: string;
  updated_at: number;
};

const insertFeedbackStmt = sqlite.prepare(`
  INSERT INTO elyxion_feedback (ts, player_id, player_name, type, title, body, status, ip, user_agent, updated_at)
  VALUES (@ts, @playerId, @playerName, @type, @title, @body, 'open', @ip, @userAgent, @ts)`);

export type FeedbackInput = {
  playerId?: string;
  playerName?: string;
  type: FeedbackType;
  title: string;
  body: string;
  ip?: string;
  userAgent?: string;
  now?: number;
};

// Global table-growth backstop. The per-identity rate limit (6/10min) bounds
// honest traffic; this bounds a distributed/scripted flood so the table can't
// grow without limit. Oldest rows fall off first — at human feedback volumes
// 20k is years of headroom.
const FEEDBACK_MAX_ROWS = 20_000;
const trimFeedbackStmt = sqlite.prepare(
  `DELETE FROM elyxion_feedback
   WHERE id NOT IN (SELECT id FROM elyxion_feedback ORDER BY id DESC LIMIT ?)`,
);

// Store a player feedback/bug report. Returns the new row id (0 on failure —
// never throws into the request path).
export function submitFeedback(f: FeedbackInput): number {
  try {
    const now = f.now ?? Date.now();
    const r = insertFeedbackStmt.run({
      ts: now,
      playerId: (f.playerId ?? '').slice(0, 64),
      playerName: (f.playerName ?? '').slice(0, 32) || 'Guest',
      type: f.type,
      title: f.title.slice(0, 200),
      body: f.body.slice(0, 5000),
      ip: (f.ip ?? '').slice(0, 64),
      userAgent: (f.userAgent ?? '').slice(0, 256),
    });
    trimFeedbackStmt.run(FEEDBACK_MAX_ROWS);
    return Number(r.lastInsertRowid) || 0;
  } catch (err) {
    console.error('[feedback] submit failed', err);
    return 0;
  }
}

function mapFeedbackRow(r: FeedbackDbRow): FeedbackRow {
  return {
    id: r.id,
    ts: r.ts,
    playerId: r.player_id,
    playerName: r.player_name || 'Guest',
    type: r.type as FeedbackType,
    title: r.title,
    body: r.body,
    status: r.status as FeedbackStatus,
    ip: r.ip,
    userAgent: r.user_agent,
    updatedAt: r.updated_at,
  };
}

// The feedback list is a small filter matrix (status? × type? × before?), so
// statements are built on demand and cached by shape — every variant is still
// a prepared, fully parameterized statement (filters arrive as bind values).
const feedbackListStmts = new Map<string, ReturnType<typeof sqlite.prepare>>();
function feedbackListStmt(hasStatus: boolean, hasType: boolean, hasBefore: boolean) {
  const key = `${hasStatus}|${hasType}|${hasBefore}`;
  let stmt = feedbackListStmts.get(key);
  if (!stmt) {
    const where: string[] = [];
    if (hasStatus) where.push('status = @status');
    if (hasType) where.push('type = @type');
    if (hasBefore) where.push('id < @before');
    stmt = sqlite.prepare(
      `SELECT * FROM elyxion_feedback${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT @limit`,
    );
    feedbackListStmts.set(key, stmt);
  }
  return stmt;
}

// Recent feedback, newest first, keyset-paginated by id (pass the last id you saw
// as `beforeId`). Optional status / type filters ('all'/'' = unfiltered).
export function listFeedback(opts: {
  limit?: number;
  beforeId?: number;
  status?: string;
  type?: string;
}): FeedbackRow[] {
  const n = Math.max(1, Math.min(200, Math.floor(opts.limit ?? 50)));
  const before = opts.beforeId && opts.beforeId > 0 ? opts.beforeId : 0;
  const status = opts.status && opts.status !== 'all' ? opts.status : '';
  const type = opts.type && opts.type !== 'all' ? opts.type : '';
  const rows = feedbackListStmt(!!status, !!type, !!before).all({
    ...(status ? { status } : {}),
    ...(type ? { type } : {}),
    ...(before ? { before } : {}),
    limit: n,
  });
  return (rows as FeedbackDbRow[]).map(mapFeedbackRow);
}

const mSetFeedbackStatus = sqlite.prepare(
  `UPDATE elyxion_feedback SET status = @status, updated_at = @now WHERE id = @id`,
);
// Update a feedback row's moderation status. Returns true if a row changed.
export function setFeedbackStatus(id: number, status: FeedbackStatus, now?: number): boolean {
  return mSetFeedbackStatus.run({ id, status, now: now ?? Date.now() }).changes > 0;
}

// Feedback row counts by status — for the admin tab badge + filter chips.
const mFeedbackCounts = sqlite.prepare(
  `SELECT status, COUNT(*) AS n FROM elyxion_feedback GROUP BY status`,
);
export function feedbackCounts(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of mFeedbackCounts.all() as { status: string; n: number }[]) out[r.status] = r.n;
  return out;
}

// …and by type (bug / feature / general) — the admin tab's second chip row.
const mFeedbackTypeCounts = sqlite.prepare(
  `SELECT type, COUNT(*) AS n FROM elyxion_feedback GROUP BY type`,
);
export function feedbackTypeCounts(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of mFeedbackTypeCounts.all() as { type: string; n: number }[]) out[r.type] = r.n;
  return out;
}

// ── Support tickets ──────────────────────────────────────────────────────────
// Player-facing support requests (the /support page → POST /api/support/tickets).
// Same spirit as feedback but with a real conversation: an admin can reply, and
// the player (when logged in) sees the whole thread back on /support. Only
// admins and the ticket's own account ever read a ticket; `ip`/`user_agent` are
// spam-triage metadata.
sqlite.exec(`
CREATE TABLE IF NOT EXISTS elyxion_tickets (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL,
  player_id   TEXT NOT NULL DEFAULT '',
  player_name TEXT NOT NULL DEFAULT '',
  category    TEXT NOT NULL DEFAULT 'help',
  subject     TEXT NOT NULL DEFAULT '',
  body        TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'open',
  ip          TEXT NOT NULL DEFAULT '',
  user_agent  TEXT NOT NULL DEFAULT '',
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tickets_ts ON elyxion_tickets(ts);
CREATE INDEX IF NOT EXISTS idx_tickets_status ON elyxion_tickets(status, id);
CREATE INDEX IF NOT EXISTS idx_tickets_player ON elyxion_tickets(player_id, id);

CREATE TABLE IF NOT EXISTS elyxion_ticket_replies (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL,
  ts        INTEGER NOT NULL,
  author    TEXT NOT NULL DEFAULT '',
  body      TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_ticket_replies_ticket ON elyxion_ticket_replies(ticket_id, id);
`);

export type TicketCategory = 'help' | 'report' | 'billing' | 'other';
export type TicketStatus = 'open' | 'ack' | 'resolved' | 'closed';
export const TICKET_CATEGORIES: readonly TicketCategory[] = ['help', 'report', 'billing', 'other'];
export const TICKET_STATUSES: readonly TicketStatus[] = ['open', 'ack', 'resolved', 'closed'];

export type TicketRow = {
  id: number;
  ts: number;
  playerId: string;
  playerName: string;
  category: TicketCategory;
  subject: string;
  body: string;
  status: TicketStatus;
  ip: string;
  userAgent: string;
  updatedAt: number;
  replyCount: number; // filled for list queries (subquery count)
};

export type TicketReplyRow = {
  id: number;
  ticketId: number;
  ts: number;
  author: string;
  body: string;
};

type TicketDbRow = {
  id: number;
  ts: number;
  player_id: string;
  player_name: string;
  category: string;
  subject: string;
  body: string;
  status: string;
  ip: string;
  user_agent: string;
  updated_at: number;
  reply_count: number;
};

type TicketReplyDbRow = {
  id: number;
  ticket_id: number;
  ts: number;
  author: string;
  body: string;
};

const insertTicketStmt = sqlite.prepare(`
  INSERT INTO elyxion_tickets (ts, player_id, player_name, category, subject, body, status, ip, user_agent, updated_at)
  VALUES (@ts, @playerId, @playerName, @category, @subject, @body, 'open', @ip, @userAgent, @ts)`);

const insertTicketReplyStmt = sqlite.prepare(`
  INSERT INTO elyxion_ticket_replies (ticket_id, ts, author, body)
  VALUES (@ticketId, @ts, @author, @body)`);

export type TicketInput = {
  playerId?: string;
  playerName?: string;
  category: TicketCategory;
  subject: string;
  body: string;
  ip?: string;
  userAgent?: string;
  now?: number;
};

// Global table-growth backstop (same reasoning as feedback: bounds a scripted
// flood so the table can't grow without limit). At human ticket volumes 50k is
// years of headroom; oldest rows (and their replies) fall off first.
const TICKETS_MAX_ROWS = 50_000;
const trimTicketsStmt = sqlite.prepare(
  `DELETE FROM elyxion_tickets
   WHERE id NOT IN (SELECT id FROM elyxion_tickets ORDER BY id DESC LIMIT ?)`,
);

// Store a support ticket. Returns the new row id (0 on failure — never throws
// into the request path).
export function submitTicket(t: TicketInput): number {
  try {
    const now = t.now ?? Date.now();
    const r = insertTicketStmt.run({
      ts: now,
      playerId: (t.playerId ?? '').slice(0, 64),
      playerName: (t.playerName ?? '').slice(0, 32) || 'Guest',
      category: t.category,
      subject: t.subject.slice(0, 200),
      body: t.body.slice(0, 6000),
      ip: (t.ip ?? '').slice(0, 64),
      userAgent: (t.userAgent ?? '').slice(0, 256),
    });
    trimTicketsStmt.run(TICKETS_MAX_ROWS);
    return Number(r.lastInsertRowid) || 0;
  } catch (err) {
    console.error('[support] submit failed', err);
    return 0;
  }
}

function mapTicketRow(r: TicketDbRow): TicketRow {
  return {
    id: r.id,
    ts: r.ts,
    playerId: r.player_id,
    playerName: r.player_name || 'Guest',
    category: r.category as TicketCategory,
    subject: r.subject,
    body: r.body,
    status: r.status as TicketStatus,
    ip: r.ip,
    userAgent: r.user_agent,
    updatedAt: r.updated_at,
    replyCount: Number(r.reply_count) || 0,
  };
}

const ticketBaseSelect = `
  SELECT t.*, (SELECT COUNT(*) FROM elyxion_ticket_replies r WHERE r.ticket_id = t.id) AS reply_count
  FROM elyxion_tickets t`;

// The admin/own-ticket list is a small filter matrix (status? × before?), built
// and cached like the feedback list — every variant is still a prepared,
// fully parameterized statement.
const ticketListStmts = new Map<string, ReturnType<typeof sqlite.prepare>>();
function ticketListStmt(hasStatus: boolean, hasPlayer: boolean, hasBefore: boolean) {
  const key = `${hasStatus}|${hasPlayer}|${hasBefore}`;
  let stmt = ticketListStmts.get(key);
  if (!stmt) {
    const where: string[] = [];
    if (hasStatus) where.push('t.status = @status');
    if (hasPlayer) where.push('t.player_id = @playerId');
    if (hasBefore) where.push('t.id < @before');
    stmt = sqlite.prepare(
      `${ticketBaseSelect}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY t.id DESC LIMIT @limit`,
    );
    ticketListStmts.set(key, stmt);
  }
  return stmt;
}

// Recent tickets, newest first, keyset-paginated by id. `playerId` narrows to
// one account's own tickets (the /support "your tickets" list); omit for admin.
export function listTickets(opts: {
  limit?: number;
  beforeId?: number;
  status?: string;
  playerId?: string;
}): TicketRow[] {
  const n = Math.max(1, Math.min(200, Math.floor(opts.limit ?? 50)));
  const before = opts.beforeId && opts.beforeId > 0 ? opts.beforeId : 0;
  const status = opts.status && opts.status !== 'all' ? opts.status : '';
  const rows = ticketListStmt(!!status, !!opts.playerId, !!before).all({
    ...(status ? { status } : {}),
    ...(opts.playerId ? { playerId: opts.playerId } : {}),
    ...(before ? { before } : {}),
    limit: n,
  });
  return (rows as TicketDbRow[]).map(mapTicketRow);
}

export function getTicket(id: number): TicketRow | null {
  const row = sqlite
    .prepare(`${ticketBaseSelect} WHERE t.id = ?`)
    .get(id) as TicketDbRow | undefined;
  return row ? mapTicketRow(row) : null;
}

const mSetTicketStatus = sqlite.prepare(
  `UPDATE elyxion_tickets SET status = @status, updated_at = @now WHERE id = @id`,
);
// Update a ticket's status. Returns true if a row changed.
export function setTicketStatus(id: number, status: TicketStatus, now?: number): boolean {
  return mSetTicketStatus.run({ id, status, now: now ?? Date.now() }).changes > 0;
}

// Append an admin reply to a ticket (bumps updated_at so the thread sorts by
// latest activity). If the ticket is still 'open' a reply implicitly acks it.
// Returns the new reply id (0 on failure / missing ticket).
export function addTicketReply(ticketId: number, author: string, body: string, now?: number): number {
  try {
    const t = now ?? Date.now();
    const ticket = getTicket(ticketId);
    if (!ticket) return 0;
    const r = insertTicketReplyStmt.run({
      ticketId,
      ts: t,
      author: (author || 'Admin').slice(0, 32),
      body: body.slice(0, 4000),
    });
    const nextStatus = ticket.status === 'open' ? 'ack' : ticket.status;
    mSetTicketStatus.run({ id: ticketId, status: nextStatus, now: t });
    return Number(r.lastInsertRowid) || 0;
  } catch (err) {
    console.error('[support] reply failed', err);
    return 0;
  }
}

// The ticket AUTHOR replying (the /support page). Unlike an admin reply this
// must NOT auto-ack (the ticket still needs the admin). A reply to a
// resolved/closed ticket reopens it as 'open' (the issue clearly isn't done);
// open/ack keep their status. Bumps updated_at either way. Returns the new
// reply id (0 on failure / missing ticket).
export function addPlayerTicketReply(
  ticketId: number,
  author: string,
  body: string,
  now?: number,
): number {
  try {
    const t = now ?? Date.now();
    const ticket = getTicket(ticketId);
    if (!ticket) return 0;
    const r = insertTicketReplyStmt.run({
      ticketId,
      ts: t,
      author: (author || 'Guest').slice(0, 32),
      body: body.slice(0, 4000),
    });
    const nextStatus =
      ticket.status === 'resolved' || ticket.status === 'closed' ? 'open' : ticket.status;
    mSetTicketStatus.run({ id: ticketId, status: nextStatus, now: t });
    return Number(r.lastInsertRowid) || 0;
  } catch (err) {
    console.error('[support] player reply failed', err);
    return 0;
  }
}

const listRepliesStmt = sqlite.prepare(
  `SELECT * FROM elyxion_ticket_replies WHERE ticket_id = ? ORDER BY id ASC LIMIT 200`,
);
export function listReplies(ticketId: number): TicketReplyRow[] {
  const rows = listRepliesStmt.all(ticketId) as TicketReplyDbRow[];
  return rows.map((r) => ({
    id: r.id,
    ticketId: r.ticket_id,
    ts: r.ts,
    author: r.author || 'Admin',
    body: r.body,
  }));
}

// Ticket row counts by status — for the admin tab badge + filter chips.
const mTicketCounts = sqlite.prepare(
  `SELECT status, COUNT(*) AS n FROM elyxion_tickets GROUP BY status`,
);
export function ticketCounts(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of mTicketCounts.all() as { status: string; n: number }[]) out[r.status] = r.n;
  return out;
}

// ── Community chat (Discord-style social hub) ───────────────────────────────
// Persistent multi-channel chat for the /community page. Unlike match/lobby chat
// (transient, in-memory socket state) these rows survive restarts so players can
// scroll back. Content is length-capped + profanity-filtered at the route; a
// `deleted` flag hides a message after admin moderation (rows are kept so the
// audit trail + id sequence stay stable). Guests post as "Guest"; logged-in
// accounts post as their username with an admin/verified snapshot at post time.
sqlite.exec(`
CREATE TABLE IF NOT EXISTS elyxion_community_messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  channel     TEXT NOT NULL,
  ts          INTEGER NOT NULL,
  player_id   TEXT NOT NULL DEFAULT '',
  player_name TEXT NOT NULL DEFAULT '',
  text        TEXT NOT NULL DEFAULT '',
  deleted     INTEGER NOT NULL DEFAULT 0,
  admin       INTEGER NOT NULL DEFAULT 0,
  verified    INTEGER NOT NULL DEFAULT 0,
  ip          TEXT NOT NULL DEFAULT '',
  user_agent  TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_community_channel_id ON elyxion_community_messages(channel, id);
`);

export const COMMUNITY_CHANNELS = ['general', 'looking-for-match', 'off-topic'] as const;
export type CommunityChannel = (typeof COMMUNITY_CHANNELS)[number];

export type CommunityMessageRow = {
  id: number;
  channel: CommunityChannel;
  ts: number;
  playerId: string;
  playerName: string;
  text: string;
  deleted: boolean;
  admin: boolean;
  verified: boolean;
  ip: string;
  userAgent: string;
};

type CommunityMessageDbRow = {
  id: number;
  channel: string;
  ts: number;
  player_id: string;
  player_name: string;
  text: string;
  deleted: number;
  admin: number;
  verified: number;
  ip: string;
  user_agent: string;
};

const insertCommunityMessageStmt = sqlite.prepare(`
  INSERT INTO elyxion_community_messages (channel, ts, player_id, player_name, text, deleted, admin, verified, ip, user_agent)
  VALUES (@channel, @ts, @playerId, @playerName, @text, 0, @admin, @verified, @ip, @userAgent)`);

export type CommunityMessageInput = {
  channel: CommunityChannel;
  playerId?: string;
  playerName?: string;
  text: string;
  admin?: boolean;
  verified?: boolean;
  ip?: string;
  userAgent?: string;
  now?: number;
};

// Global table-growth backstop (same reasoning as feedback/tickets: bounds a
// scripted flood). Chat is higher volume than tickets, so the cap is larger but
// still finite; oldest rows fall off first.
const COMMUNITY_MAX_ROWS = 50_000;
const trimCommunityStmt = sqlite.prepare(
  `DELETE FROM elyxion_community_messages
   WHERE id NOT IN (SELECT id FROM elyxion_community_messages ORDER BY id DESC LIMIT ?)`,
);

// Store a community chat message. Returns the new row id (0 on failure — never
// throws into the request path).
export function postCommunityMessage(m: CommunityMessageInput): number {
  try {
    const now = m.now ?? Date.now();
    const r = insertCommunityMessageStmt.run({
      channel: m.channel,
      ts: now,
      playerId: (m.playerId ?? '').slice(0, 64),
      playerName: (m.playerName ?? '').slice(0, 32) || 'Guest',
      text: m.text.slice(0, 600),
      admin: m.admin ? 1 : 0,
      verified: m.verified ? 1 : 0,
      ip: (m.ip ?? '').slice(0, 64),
      userAgent: (m.userAgent ?? '').slice(0, 256),
    });
    trimCommunityStmt.run(COMMUNITY_MAX_ROWS);
    return Number(r.lastInsertRowid) || 0;
  } catch (err) {
    console.error('[community] post failed', err);
    return 0;
  }
}

function mapCommunityRow(r: CommunityMessageDbRow): CommunityMessageRow {
  return {
    id: r.id,
    channel: r.channel as CommunityChannel,
    ts: r.ts,
    playerId: r.player_id,
    playerName: r.player_name || 'Guest',
    text: r.text,
    deleted: r.deleted === 1,
    admin: r.admin === 1,
    verified: r.verified === 1,
    ip: r.ip,
    userAgent: r.user_agent,
  };
}

// Recent messages in one channel, newest first, keyset-paginated by id. Pass
// `beforeId` to page back; the client reverses to render oldest→newest.
export function listCommunityMessages(opts: {
  channel: CommunityChannel;
  limit?: number;
  beforeId?: number;
}): CommunityMessageRow[] {
  const n = Math.max(1, Math.min(200, Math.floor(opts.limit ?? 50)));
  const before = opts.beforeId && opts.beforeId > 0 ? opts.beforeId : 0;
  const stmt = before
    ? sqlite.prepare(
        `SELECT * FROM elyxion_community_messages
         WHERE channel = @channel AND id < @before ORDER BY id DESC LIMIT @limit`,
      )
    : sqlite.prepare(
        `SELECT * FROM elyxion_community_messages
         WHERE channel = @channel ORDER BY id DESC LIMIT @limit`,
      );
  const rows = stmt.all(before ? { channel: opts.channel, before, limit: n } : { channel: opts.channel, limit: n }) as CommunityMessageDbRow[];
  return rows.map(mapCommunityRow);
}

// Recent messages across ALL channels, newest first — the admin moderation view.
export function listAllCommunityMessages(opts: { limit?: number; beforeId?: number }): CommunityMessageRow[] {
  const n = Math.max(1, Math.min(200, Math.floor(opts.limit ?? 50)));
  const before = opts.beforeId && opts.beforeId > 0 ? opts.beforeId : 0;
  const stmt = before
    ? sqlite.prepare(
        `SELECT * FROM elyxion_community_messages WHERE id < @before ORDER BY id DESC LIMIT @limit`,
      )
    : sqlite.prepare(
        `SELECT * FROM elyxion_community_messages ORDER BY id DESC LIMIT @limit`,
      );
  const rows = stmt.all(before ? { before, limit: n } : { limit: n }) as CommunityMessageDbRow[];
  return rows.map(mapCommunityRow);
}

// Mark a message deleted (soft delete — kept for audit). Returns true if a row
// changed.
export function deleteCommunityMessage(id: number): boolean {
  return sqlite
    .prepare(`UPDATE elyxion_community_messages SET deleted = 1 WHERE id = ? AND deleted = 0`)
    .run(id).changes > 0;
}

// ── Per-player challenge progress (Phase 2). Definitions live in code
// (src/game/challenges.ts); this only stores progress + claim state, keyed by
// (player, challenge, period) so each daily/weekly instance is independent.
sqlite.exec(`
CREATE TABLE IF NOT EXISTS elyxion_challenges (
  player_id  TEXT NOT NULL,
  challenge  TEXT NOT NULL,
  period     TEXT NOT NULL,
  progress   INTEGER NOT NULL DEFAULT 0,
  goal       INTEGER NOT NULL,
  claimed    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (player_id, challenge, period)
);
`);

export type PublicStats = {
  totalKills: number;
  totalDeaths: number;
  totalGames: number;
  totalWins: number;
  bestKillStreak: number;
  headshots: number;
  bestAccuracy: number;
};

const ZERO_STATS: PublicStats = {
  totalKills: 0,
  totalDeaths: 0,
  totalGames: 0,
  totalWins: 0,
  bestKillStreak: 0,
  headshots: 0,
  bestAccuracy: 0,
};

type Row = {
  total_kills: number;
  total_deaths: number;
  total_games: number;
  total_wins: number;
  best_kill_streak: number;
  headshots: number;
  best_accuracy: number;
};

const toPublic = (row: Row | undefined): PublicStats =>
  row
    ? {
        totalKills: row.total_kills,
        totalDeaths: row.total_deaths,
        totalGames: row.total_games,
        totalWins: row.total_wins,
        bestKillStreak: row.best_kill_streak,
        headshots: row.headshots,
        bestAccuracy: row.best_accuracy,
      }
    : { ...ZERO_STATS };

const selectStmt = sqlite.prepare(
  `SELECT total_kills, total_deaths, total_games, total_wins,
          best_kill_streak, headshots, best_accuracy
     FROM elyxion_stats WHERE player_id = ?`,
);

// Atomic upsert: increments are applied in SQL (column + delta), not
// read-modify-write in JS, so two near-simultaneous POSTs for the same player
// can't clobber each other's deltas. RETURNING hands back the final row.
const upsertStmt = sqlite.prepare(`
INSERT INTO elyxion_stats (
  player_id, user_name, total_kills, total_deaths, total_games, total_wins,
  best_kill_streak, headshots, shots_fired, shots_hit, best_accuracy,
  created_at, updated_at
) VALUES (
  @playerId, @userName, @kills, @deaths, 1, @wins,
  @bestStreak, @headshots, @shotsFired, @shotsHit, @accuracy,
  @now, @now
)
ON CONFLICT(player_id) DO UPDATE SET
  user_name        = excluded.user_name,
  total_kills      = total_kills + excluded.total_kills,
  total_deaths     = total_deaths + excluded.total_deaths,
  total_games      = total_games + 1,
  total_wins       = total_wins + excluded.total_wins,
  best_kill_streak = max(best_kill_streak, excluded.best_kill_streak),
  headshots        = headshots + excluded.headshots,
  shots_fired      = shots_fired + excluded.shots_fired,
  shots_hit        = shots_hit + excluded.shots_hit,
  best_accuracy    = max(best_accuracy, excluded.best_accuracy),
  updated_at       = excluded.updated_at
RETURNING total_kills, total_deaths, total_games, total_wins,
          best_kill_streak, headshots, best_accuracy
`);

// Per-period bucket upsert — same accumulation as the all-time row, keyed by period.
const periodUpsertStmt = sqlite.prepare(`
INSERT INTO elyxion_period_stats (
  player_id, period_key, user_name, total_kills, total_deaths, total_games,
  total_wins, best_kill_streak, headshots, best_accuracy, updated_at
) VALUES (
  @playerId, @periodKey, @userName, @kills, @deaths, 1,
  @wins, @bestStreak, @headshots, @accuracy, @now
)
ON CONFLICT(player_id, period_key) DO UPDATE SET
  user_name        = excluded.user_name,
  total_kills      = total_kills + excluded.total_kills,
  total_deaths     = total_deaths + excluded.total_deaths,
  total_games      = total_games + 1,
  total_wins       = total_wins + excluded.total_wins,
  best_kill_streak = max(best_kill_streak, excluded.best_kill_streak),
  headshots        = headshots + excluded.headshots,
  best_accuracy    = max(best_accuracy, excluded.best_accuracy),
  updated_at       = excluded.updated_at
`);

// Period keys for a timestamp (UTC): "d:YYYYMMDD" (today) and "w:YYYYMMDD" of the
// current week's Monday. Both are the buckets a match contributes to.
function dayKey(now: number): string {
  return `d:${ymd(now)}`;
}
function weekKey(now: number): string {
  const d = new Date(now);
  // UTC Monday-of-week: getUTCDay() is 0=Sun..6=Sat; shift to Monday-based.
  const dow = (d.getUTCDay() + 6) % 7;
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow));
  return `w:${ymd(monday.getTime())}`;
}

// Week key for the WEEKLY CHALLENGE (board + replays). The challenge changed
// format (1v1-vs-hard-bot → 8p-FFA speedrun), so it gets its own key namespace:
// the new board starts clean instead of mixing with the old-format rows already
// stored for the current week (those `w:` rows are simply never queried again).
// Bump CHALLENGE_FORMAT whenever the challenge rules change enough to invalidate
// comparisons across the change.
const CHALLENGE_FORMAT = 's2';
function challengeWeekKey(now: number): string {
  return `${CHALLENGE_FORMAT}:${weekKey(now)}`;
}

export type MatchDelta = {
  playerId: string;
  userName: string;
  kills: number;
  deaths: number;
  wins: number;
  bestStreak: number;
  headshots: number;
  shotsFired: number;
  shotsHit: number;
  accuracy: number;
  offline: boolean; // bot/practice match — XP is scaled down, no first-win bonus
  now: number;
};

export function getStats(playerId: string): PublicStats {
  return toPublic(selectStmt.get(playerId) as Row | undefined);
}

// --- Progression (XP / level / credits / cosmetics) -------------------------

type ProgRow = {
  total_xp: number;
  level: number;
  credits: number;
  unlocked: string;
  equipped: string;
  first_win_day: number;
};

const progSelectStmt = sqlite.prepare(
  `SELECT total_xp, level, credits, unlocked, equipped, first_win_day
     FROM elyxion_stats WHERE player_id = ?`,
);

const progUpdateStmt = sqlite.prepare(`
  UPDATE elyxion_stats
     SET total_xp = @totalXp, level = @level, credits = @credits,
         unlocked = @unlocked, equipped = @equipped, first_win_day = @firstWinDay
   WHERE player_id = @playerId`);

const equipUpdateStmt = sqlite.prepare(
  `UPDATE elyxion_stats SET equipped = @equipped WHERE player_id = @playerId`,
);

const buyUpdateStmt = sqlite.prepare(
  `UPDATE elyxion_stats SET credits = @credits, unlocked = @unlocked WHERE player_id = @playerId`,
);

// Create a bare row for a player who is equipping/buying before ever recording a
// match, so the UPDATEs above have a row to touch.
const ensureRowStmt = sqlite.prepare(
  `INSERT OR IGNORE INTO elyxion_stats (player_id, user_name, created_at, updated_at)
   VALUES (?, 'Player', ?, ?)`,
);

function parseIdList(json: string | undefined): string[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function parseEquipped(json: string | undefined): Record<string, string> {
  if (!json) return {};
  try {
    const v = JSON.parse(json);
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(v)) if (typeof val === 'string') out[k] = val;
    return out;
  } catch {
    return {};
  }
}

// Every cosmetic id in the manifest — admins own all of them (incl. the
// admin-exclusive crown/aura), so this is their entitlement set.
const ALL_COSMETIC_IDS: readonly string[] = ALL_COSMETICS.map((c) => c.id);

// Is this account id an admin? Cheap point lookup; cached statement.
const adminCheckStmt = sqlite.prepare(`SELECT is_admin FROM elyxion_users WHERE id = ?`);
function isAdminId(playerId: string): boolean {
  if (!playerId) return false;
  const r = adminCheckStmt.get(playerId) as { is_admin: number } | undefined;
  return !!r?.is_admin;
}

// ── Bans (moderation) ──────────────────────────────────────────────────────
// Two identities: display NAME (case-insensitive; the stable handle for
// accounts) and IP ADDRESS (captured when an online player is banned, or set
// directly; the stable handle for guests). A banned player is refused at
// join/resume/spectate (name) / at connect (IP) and — if they're online at ban
// time — kicked immediately.
// bannedUntil: epoch ms the ban lifts; 0 = permanent.
export type BanRow = { name: string; reason: string; bannedBy: string; createdAt: number; bannedUntil: number };
export type IpBanRow = { ip: string; reason: string; bannedBy: string; createdAt: number; bannedUntil: number };
export type GuestBanRow = { guestId: string; reason: string; bannedBy: string; createdAt: number; bannedUntil: number };
export type BanListItem =
  | (BanRow & { kind: 'name'; ip?: undefined; guestId?: undefined })
  | {
      kind: 'ip';
      name: string;
      ip: string;
      reason: string;
      bannedBy: string;
      createdAt: number;
      bannedUntil: number;
      guestId?: undefined;
    }
  | {
      kind: 'guest';
      name: string;
      guestId: string;
      reason: string;
      bannedBy: string;
      createdAt: number;
      bannedUntil: number;
      ip?: undefined;
    };

// A ban is active while permanent (0) or not yet expired.
const banActive = (until: number, now: number): boolean => until === 0 || until > now;

const banCheckStmt = sqlite.prepare(
  `SELECT name, reason, banned_by, created_at, banned_until FROM elyxion_bans WHERE name_lower = ?`,
);
const banInsertStmt = sqlite.prepare(
  `INSERT OR REPLACE INTO elyxion_bans (name_lower, name, reason, banned_by, created_at, banned_until)
   VALUES (?, ?, ?, ?, ?, ?)`,
);
const banDeleteStmt = sqlite.prepare(`DELETE FROM elyxion_bans WHERE name_lower = ?`);
const banListStmt = sqlite.prepare(
  `SELECT name, reason, banned_by, created_at, banned_until FROM elyxion_bans
   WHERE banned_until = 0 OR banned_until > ? ORDER BY created_at DESC`,
);
// IP rows: an unnamed row (banned_name = '') is a manual /banip or API ban;
// a row tied to a name_lower was auto-captured from an online player and lifts
// with the name ban it came from.
const ipBanCheckStmt = sqlite.prepare(
  `SELECT ip, reason, banned_by, banned_name, created_at, banned_until FROM elyxion_ip_bans WHERE ip = ?`,
);
const ipBanInsertStmt = sqlite.prepare(
  `INSERT OR REPLACE INTO elyxion_ip_bans (ip, reason, banned_by, banned_name, created_at, banned_until)
   VALUES (?, ?, ?, ?, ?, ?)`,
);
const ipBanDeleteStmt = sqlite.prepare(`DELETE FROM elyxion_ip_bans WHERE ip = ?`);
const ipBanDeleteByNameStmt = sqlite.prepare(`DELETE FROM elyxion_ip_bans WHERE banned_name = ?`);
const ipBanListStmt = sqlite.prepare(
  `SELECT ip, reason, banned_by, created_at, banned_until FROM elyxion_ip_bans
   WHERE banned_until = 0 OR banned_until > ? ORDER BY created_at DESC`,
);
// Guest-uuid rows: a row with captured_name = '' is a direct ban by uuid; a row
// tied to a name_lower was auto-captured from an online guest during a name ban
// and lifts with that name ban (see removeBan).
const guestBanCheckStmt = sqlite.prepare(
  `SELECT guest_id, reason, banned_by, created_at, banned_until FROM elyxion_guest_bans WHERE guest_id = ?`,
);
const guestBanInsertStmt = sqlite.prepare(
  `INSERT OR REPLACE INTO elyxion_guest_bans (guest_id, reason, banned_by, captured_name, created_at, banned_until)
   VALUES (?, ?, ?, ?, ?, ?)`,
);
const guestBanDeleteStmt = sqlite.prepare(`DELETE FROM elyxion_guest_bans WHERE guest_id = ?`);
const guestBanDeleteByNameStmt = sqlite.prepare(
  `DELETE FROM elyxion_guest_bans WHERE captured_name = ?`,
);
const guestBanListStmt = sqlite.prepare(
  `SELECT guest_id, reason, banned_by, created_at, banned_until FROM elyxion_guest_bans
   WHERE banned_until = 0 OR banned_until > ? ORDER BY created_at DESC`,
);

const normGuest = (guestId: string): string => guestId.trim().toLowerCase();
// A usable guest id is a non-empty, UUID-ish token (the igpid cookie value).
const usableGuest = (guestId: string): boolean => {
  const g = normGuest(guestId);
  return g.length > 0;
};

const normIp = (ip: string): string => ip.trim();
// 'unknown' is the debounced fallback when no forwarding header exists — never
// meaningful as a ban target (it'd block every connection behind a missing
// header), so treat it as "no IP".
const usableIp = (ip: string): boolean => {
  const n = normIp(ip);
  return n.length > 0 && n !== 'unknown';
};

export function isBannedName(name: string): boolean {
  return !!getBanByName(name);
}

// Ban row for a name (undefined = not banned) — the reason rides along so the
// kicked message can say why.
// Reads are expiry-aware: a lapsed ban reads as "not banned" everywhere
// (join/connect enforcement, unban resolution, the admin list), so an expired
// row is inert until the sweeper deletes it.
export function getBanByName(name: string): BanRow | undefined {
  if (!name) return undefined;
  const r = banCheckStmt.get(name.trim().toLowerCase()) as
    | { name: string; reason: string; banned_by: string; created_at: number; banned_until: number }
    | undefined;
  if (!r || !banActive(r.banned_until, Date.now())) return undefined;
  return {
    name: r.name,
    reason: r.reason,
    bannedBy: r.banned_by,
    createdAt: r.created_at,
    bannedUntil: r.banned_until,
  };
}

export function getBanByIp(ip: string): IpBanRow | undefined {
  if (!usableIp(ip)) return undefined;
  const r = ipBanCheckStmt.get(normIp(ip)) as
    | { ip: string; reason: string; banned_by: string; created_at: number; banned_until: number }
    | undefined;
  if (!r || !banActive(r.banned_until, Date.now())) return undefined;
  return {
    ip: r.ip,
    reason: r.reason,
    bannedBy: r.banned_by,
    createdAt: r.created_at,
    bannedUntil: r.banned_until,
  };
}

// Ban row for a guest identity (undefined = not banned) — the reason rides along
// so the kicked/blocked message can say why. Reads are expiry-aware, like the
// name/IP lookups.
export function getBanByGuestId(guestId: string): GuestBanRow | undefined {
  if (!usableGuest(guestId)) return undefined;
  const r = guestBanCheckStmt.get(normGuest(guestId)) as
    | { guest_id: string; reason: string; banned_by: string; created_at: number; banned_until: number }
    | undefined;
  if (!r || !banActive(r.banned_until, Date.now())) return undefined;
  return {
    guestId: r.guest_id,
    reason: r.reason,
    bannedBy: r.banned_by,
    createdAt: r.created_at,
    bannedUntil: r.banned_until,
  };
}

// Name ban; when the target is online their IP is auto-captured too (see
// addIpBan), so a reconnecting guest can't dodge the ban by renumbering.
// `capturedFrom` is the banned player's name_lower, tying the IP row to this ban.
// bannedUntil: epoch ms the ban lifts (0 = permanent). Captured IPs inherit the
// same expiry, so a timed name ban can't be dodged by reconnecting as a guest
// for longer than the ban itself lasts.
export function addBan(
  name: string,
  reason: string,
  bannedBy: string,
  ip?: string,
  capturedFrom?: string,
  now: number = Date.now(),
  bannedUntil: number = 0,
): boolean {
  const n = name.trim();
  if (!n) return false;
  banInsertStmt.run(n.toLowerCase(), n, reason || '', bannedBy || '', now, bannedUntil);
  if (usableIp(ip ?? ''))
    addIpBan(ip!, reason, bannedBy, capturedFrom ?? n.toLowerCase(), now, bannedUntil);
  return true;
}

export function addIpBan(
  ip: string,
  reason: string,
  bannedBy: string,
  capturedFrom: string = '',
  now: number = Date.now(),
  bannedUntil: number = 0,
): boolean {
  if (!usableIp(ip)) return false;
  ipBanInsertStmt.run(normIp(ip), reason || '', bannedBy || '', capturedFrom, now, bannedUntil);
  return true;
}

// Direct guest-uuid ban (or the db half of a ban captured from a name ban).
// `capturedFrom` is the banned player's name_lower, tying the guest row to the
// name ban it came from ('' = direct). bannedUntil mirrors the other ban tables.
export function addGuestBan(
  guestId: string,
  reason: string,
  bannedBy: string,
  capturedFrom: string = '',
  now: number = Date.now(),
  bannedUntil: number = 0,
): boolean {
  if (!usableGuest(guestId)) return false;
  guestBanInsertStmt.run(
    normGuest(guestId),
    reason || '',
    bannedBy || '',
    capturedFrom,
    now,
    bannedUntil,
  );
  return true;
}

// Delete lapsed timed bans (permanent rows survive). Idempotent — safe to run on
// a timer; cheap enough that running it on the game sweep is fine.
export function sweepExpiredBans(now: number = Date.now()): {
  nameBans: number;
  ipBans: number;
  guestBans: number;
} {
  const nameBans = sqlite
    .prepare(`DELETE FROM elyxion_bans WHERE banned_until > 0 AND banned_until <= ?`)
    .run(now).changes;
  const ipBans = sqlite
    .prepare(`DELETE FROM elyxion_ip_bans WHERE banned_until > 0 AND banned_until <= ?`)
    .run(now).changes;
  const guestBans = sqlite
    .prepare(`DELETE FROM elyxion_guest_bans WHERE banned_until > 0 AND banned_until <= ?`)
    .run(now).changes;
  return { nameBans, ipBans, guestBans };
}

// Lifting a name ban also lifts the IPs AND guest uuids it auto-captured (an
// unban must mean "this player can come back"). Manual /banip rows
// (capturedFrom '') survive.
export function removeBan(name: string): boolean {
  const lower = name.trim().toLowerCase();
  if (!lower) return false;
  let removed = banDeleteStmt.run(lower).changes > 0;
  removed = ipBanDeleteByNameStmt.run(lower).changes > 0 || removed;
  removed = guestBanDeleteByNameStmt.run(lower).changes > 0 || removed;
  return removed;
}

export function removeIpBan(ip: string): boolean {
  if (!usableIp(ip)) return false;
  return ipBanDeleteStmt.run(normIp(ip)).changes > 0;
}

// Lifting a guest-uuid ban also lifts the IP that ban captured (the uuid was the
// target; the address was only collateral for the cookie-clearing dodge).
export function removeGuestBan(guestId: string): boolean {
  const g = normGuest(guestId);
  if (!g) return false;
  let removed = guestBanDeleteStmt.run(g).changes > 0;
  removed = ipBanDeleteByNameStmt.run(g).changes > 0 || removed;
  return removed;
}

export function listBans(): BanListItem[] {
  const now = Date.now();
  const nameRows = banListStmt.all(now) as {
    name: string;
    reason: string;
    banned_by: string;
    created_at: number;
    banned_until: number;
  }[];
  const ipRows = ipBanListStmt.all(now) as {
    ip: string;
    reason: string;
    banned_by: string;
    created_at: number;
    banned_until: number;
  }[];
  const guestRows = guestBanListStmt.all(now) as {
    guest_id: string;
    reason: string;
    banned_by: string;
    created_at: number;
    banned_until: number;
  }[];
  const all: BanListItem[] = [
    ...nameRows.map((r) => ({
      kind: 'name' as const,
      name: r.name,
      reason: r.reason,
      bannedBy: r.banned_by,
      createdAt: r.created_at,
      bannedUntil: r.banned_until,
    })),
    ...ipRows.map((r) => ({
      kind: 'ip' as const,
      name: '',
      ip: r.ip,
      reason: r.reason,
      bannedBy: r.banned_by,
      createdAt: r.created_at,
      bannedUntil: r.banned_until,
    })),
    ...guestRows.map((r) => ({
      kind: 'guest' as const,
      name: '',
      guestId: r.guest_id,
      reason: r.reason,
      bannedBy: r.banned_by,
      createdAt: r.created_at,
      bannedUntil: r.banned_until,
    })),
  ];
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

// Owned set = the default freebies ∪ whatever the row has stored. Admins own
// EVERYTHING (every manifest id), which is also the only way the admin-exclusive
// cosmetics become equippable — non-admins can never have them in their set.
function ownedSet(prog: ProgRow | undefined, playerId: string): Set<string> {
  if (isAdminId(playerId)) return new Set(ALL_COSMETIC_IDS);
  // Default freebies ∪ stored (bought/granted) ∪ everything their CURRENT level
  // entitles them to. Recomputing level grants from the level (vs only persisting
  // them on level-up) means a newly-added level cosmetic is owned immediately by
  // anyone already past its level — "level = unlocked by reaching that level".
  return new Set([
    ...defaultUnlockedIds(),
    ...levelGrantsAt(prog?.level ?? 1),
    ...parseIdList(prog?.unlocked),
  ]);
}

// The unlocked-cosmetic set for an account id (from the igsession cookie),
// used to ownership-check WS cosmetic equips. An empty/unknown id → defaults
// only (so guests still get the free cosmetics, nothing locked); admins → all.
export function unlockedSetFor(playerId: string): Set<string> {
  if (!playerId) return new Set(defaultUnlockedIds());
  const prog = progSelectStmt.get(playerId) as ProgRow | undefined;
  return ownedSet(prog, playerId);
}

// YYYYMMDD in UTC — a stable, timezone-independent "today" for the first-win bonus.
function ymd(now: number): number {
  const d = new Date(now);
  return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
}

type Progression = {
  totalXp: number;
  level: number;
  credits: number;
  unlocked: string[];
  equipped: Record<string, string>;
};

export type MatchRecordResult = {
  stats: PublicStats;
  xpGained: number;
  creditsGained: number;
  leveledUp: boolean;
  newUnlocks: string[];
  progression: Progression;
};

// Records a match: applies the atomic stat upsert, then derives XP/level/credits
// and milestone unlocks from the (already-clamped) delta. better-sqlite3 is
// synchronous and Node is single-threaded, so the read-compute-write below can't
// interleave with another request — no XP-clobbering race. The client never
// reports its own XP; everything here is server-derived.
export function recordMatch(delta: MatchDelta): MatchRecordResult {
  // Guests (no account) accrue nothing — no row, no XP, no leaderboard seeding.
  if (!delta.playerId) {
    return {
      stats: toPublic(undefined),
      xpGained: 0,
      creditsGained: 0,
      leveledUp: false,
      newUnlocks: [],
      progression: { totalXp: 0, level: 1, credits: 0, unlocked: [...defaultUnlockedIds()], equipped: {} },
    };
  }
  const stats = toPublic(upsertStmt.get(delta) as Row | undefined); // also creates the row

  // Daily/weekly leaderboard buckets — online matches only (these are the
  // competitive ladders; offline bot grinding shouldn't seed them).
  if (!delta.offline) {
    periodUpsertStmt.run({ ...delta, periodKey: dayKey(delta.now) });
    periodUpsertStmt.run({ ...delta, periodKey: weekKey(delta.now) });
  }

  const prog = progSelectStmt.get(delta.playerId) as ProgRow | undefined;
  const curXp = prog?.total_xp ?? 0;
  const curCredits = prog?.credits ?? 0;
  const owned = ownedSet(prog, delta.playerId);
  const equipped = parseEquipped(prog?.equipped);
  const firstWinDay = prog?.first_win_day ?? 0;

  const won = delta.wins > 0;
  const today = ymd(delta.now);
  const isFirstWinToday = won && !delta.offline && firstWinDay !== today;

  let xpGained = baseMatchXp({
    kills: delta.kills,
    headshots: delta.headshots,
    bestStreak: delta.bestStreak,
    won,
    accuracy: delta.accuracy,
  });
  if (delta.offline) xpGained = Math.floor(xpGained * OFFLINE_XP_SCALE);
  if (isFirstWinToday) xpGained += XP_FIRST_WIN_BONUS;
  xpGained = Math.max(0, Math.min(PER_MATCH_XP_CAP, xpGained));
  const creditsGained = creditsForXp(xpGained);

  const prevLevel = levelForXp(curXp);
  const newXp = curXp + xpGained;
  const newLevel = levelForXp(newXp);
  const leveledUp = newLevel > prevLevel;

  // Grant milestone (level-gated) unlocks + achievement titles the player has
  // now earned. `stats` is the post-match clamped aggregate, so titles unlock the
  // moment a career threshold is crossed and surface in newUnlocks (end-of-match
  // "UNLOCKED" moment). Both grant sets are server-derived — never client-claimed.
  const before = new Set(owned);
  for (const id of levelGrantsAt(newLevel)) owned.add(id);
  for (const id of titleGrantsFrom({
    kills: stats.totalKills,
    headshots: stats.headshots,
    wins: stats.totalWins,
    bestStreak: stats.bestKillStreak,
    games: stats.totalGames,
    accuracy: stats.bestAccuracy,
  })) {
    owned.add(id);
  }
  const newUnlocks = [...owned].filter((id) => !before.has(id));

  const newCredits = curCredits + creditsGained;
  const newFirstWinDay = isFirstWinToday ? today : firstWinDay;

  progUpdateStmt.run({
    playerId: delta.playerId,
    totalXp: newXp,
    level: newLevel,
    credits: newCredits,
    unlocked: JSON.stringify([...owned]),
    equipped: JSON.stringify(equipped),
    firstWinDay: newFirstWinDay,
  });

  // Advance daily/weekly challenges from this match (online matches only).
  trackChallenges(delta.playerId, delta);

  return {
    stats,
    xpGained,
    creditsGained,
    leveledUp,
    newUnlocks,
    progression: { totalXp: newXp, level: newLevel, credits: newCredits, unlocked: [...owned], equipped },
  };
}

export type Profile = {
  level: number;
  totalXp: number;
  xpIntoLevel: number;
  xpForNext: number;
  credits: number;
  unlocked: string[];
  equipped: Record<string, string>;
  stats: PublicStats;
  // Ranked Duel standing (null = never played ranked) — drives the rating card
  // stat + the live rank title. `getRankedProfile` is declared below (hoisted).
  ranked: { rating: number; rank: number; provisional: boolean } | null;
};

export function getProfile(playerId: string): Profile {
  const prog = progSelectStmt.get(playerId) as ProgRow | undefined;
  const totalXp = prog?.total_xp ?? 0;
  const lp = levelProgress(totalXp);
  const rp = getRankedProfile(playerId);
  return {
    level: lp.level,
    totalXp,
    xpIntoLevel: lp.xpIntoLevel,
    xpForNext: lp.xpForNext,
    credits: prog?.credits ?? 0,
    unlocked: [...ownedSet(prog, playerId)],
    equipped: parseEquipped(prog?.equipped),
    stats: getStats(playerId),
    ranked: rp ? { rating: rp.rating, rank: rp.rank, provisional: rp.provisional } : null,
  };
}

export type EquipResult =
  | { ok: true; equipped: Record<string, string> }
  | { ok: false; reason: 'unknown' | 'slot_mismatch' | 'locked'; equipped: Record<string, string> };

// Equip a cosmetic the player owns. Server-validated against the manifest and
// the owned set, so a forged equip can't grant or apply a locked item.
export function setEquipped(playerId: string, slot: string, id: string): EquipResult {
  if (!playerId) return { ok: false, reason: 'locked', equipped: {} }; // guest: no persistence
  const prog = progSelectStmt.get(playerId) as ProgRow | undefined;
  const equipped = parseEquipped(prog?.equipped);
  if (!cosmeticById(id)) return { ok: false, reason: 'unknown', equipped };
  if (slotOf(id) !== slot) return { ok: false, reason: 'slot_mismatch', equipped };
  if (!ownedSet(prog, playerId).has(id)) return { ok: false, reason: 'locked', equipped };
  equipped[slot] = id;
  const now = Date.now();
  ensureRowStmt.run(playerId, now, now);
  equipUpdateStmt.run({ playerId, equipped: JSON.stringify(equipped) });
  return { ok: true, equipped };
}

export type BuyResult =
  | { ok: true; credits: number; unlocked: string[] }
  | {
      ok: false;
      reason: 'unknown' | 'not_for_sale' | 'owned' | 'insufficient';
      credits: number;
      unlocked: string[];
    };

// Spend credits to unlock a buyable cosmetic. Validated server-side.
export function buyCosmetic(playerId: string, id: string): BuyResult {
  if (!playerId) return { ok: false, reason: 'insufficient', credits: 0, unlocked: [...defaultUnlockedIds()] };
  const c = cosmeticById(id);
  const prog = progSelectStmt.get(playerId) as ProgRow | undefined;
  const credits = prog?.credits ?? 0;
  const owned = ownedSet(prog, playerId);
  if (!c) return { ok: false, reason: 'unknown', credits, unlocked: [...owned] };
  if (c.source.type !== 'credits')
    return { ok: false, reason: 'not_for_sale', credits, unlocked: [...owned] };
  if (owned.has(id)) return { ok: false, reason: 'owned', credits, unlocked: [...owned] };
  if (credits < c.source.price)
    return { ok: false, reason: 'insufficient', credits, unlocked: [...owned] };
  const newCredits = credits - c.source.price;
  owned.add(id);
  const now = Date.now();
  ensureRowStmt.run(playerId, now, now);
  buyUpdateStmt.run({ playerId, credits: newCredits, unlocked: JSON.stringify([...owned]) });
  return { ok: true, credits: newCredits, unlocked: [...owned] };
}

export type CaseResult =
  | { ok: true; won: string; dupe: boolean; refund: number; credits: number; unlocked: string[] }
  | { ok: false; reason: 'insufficient'; credits: number };

// Open a hat case: spend credits, roll a hat weighted by rarity (server-
// authoritative), unlock it — or, if already owned, refund part of the cost.
export function openCase(playerId: string): CaseResult {
  if (!playerId) return { ok: false, reason: 'insufficient', credits: 0 };
  const now = Date.now();
  ensureRowStmt.run(playerId, now, now);
  const prog = progSelectStmt.get(playerId) as ProgRow | undefined;
  const credits = prog?.credits ?? 0;
  if (credits < HAT_CASE_COST) return { ok: false, reason: 'insufficient', credits };

  const pool = caseHats();
  const total = pool.reduce((s, h) => s + (RARITY_WEIGHT[h.rarity] ?? 1), 0);
  let r = Math.random() * total;
  let won = pool[pool.length - 1];
  for (const h of pool) {
    r -= RARITY_WEIGHT[h.rarity] ?? 1;
    if (r <= 0) {
      won = h;
      break;
    }
  }

  const owned = ownedSet(prog, playerId);
  const dupe = owned.has(won.id);
  let newCredits = credits - HAT_CASE_COST;
  let refund = 0;
  if (dupe) {
    refund = Math.floor(HAT_CASE_COST * DUPE_REFUND_FRAC);
    newCredits += refund;
  } else {
    owned.add(won.id);
  }
  buyUpdateStmt.run({ playerId, credits: newCredits, unlocked: JSON.stringify([...owned]) });
  return { ok: true, won: won.id, dupe, refund, credits: newCredits, unlocked: [...owned] };
}

// --- Challenges (Phase 2) ---------------------------------------------------

// Focused XP/credits/unlock update (leaves equipped + first_win_day untouched) —
// used to pay out challenge rewards on top of match XP.
const progXpUpdateStmt = sqlite.prepare(
  `UPDATE elyxion_stats
      SET total_xp = @totalXp, level = @level, credits = @credits, unlocked = @unlocked
    WHERE player_id = @playerId`,
);

// Progress upserts. 'add' accumulates, 'max' keeps the best single match; both
// clamp at the goal. SQLite's 2-arg MIN/MAX are scalar.
const chAddStmt = sqlite.prepare(`
  INSERT INTO elyxion_challenges (player_id, challenge, period, progress, goal, claimed)
  VALUES (@playerId, @challenge, @period, MIN(@goal, @value), @goal, 0)
  ON CONFLICT(player_id, challenge, period) DO UPDATE SET progress = MIN(goal, progress + @value)`);
const chMaxStmt = sqlite.prepare(`
  INSERT INTO elyxion_challenges (player_id, challenge, period, progress, goal, claimed)
  VALUES (@playerId, @challenge, @period, MIN(@goal, @value), @goal, 0)
  ON CONFLICT(player_id, challenge, period) DO UPDATE SET progress = MIN(goal, MAX(progress, @value))`);
const chRowStmt = sqlite.prepare(
  `SELECT progress, claimed FROM elyxion_challenges
    WHERE player_id = ? AND challenge = ? AND period = ?`,
);
const chClaimStmt = sqlite.prepare(
  `UPDATE elyxion_challenges SET claimed = 1
    WHERE player_id = @playerId AND challenge = @challenge AND period = @period AND claimed = 0`,
);

function metricValue(metric: ChallengeMetric, d: MatchDelta): number {
  switch (metric) {
    case 'kills': return d.kills;
    case 'headshots': return d.headshots;
    case 'wins': return d.wins; // 0 or 1
    case 'streak': return d.bestStreak;
    case 'games': return 1;
  }
}

function periodFor(def: ChallengeDef, now: number): string {
  return def.period === 'daily' ? dailyPeriod(now) : weeklyPeriod(now);
}

function activeFor(playerId: string, def: ChallengeDef, now: number): boolean {
  const pool = def.period === 'daily' ? DAILY_CHALLENGES : WEEKLY_CHALLENGES;
  const count = def.period === 'daily' ? DAILY_COUNT : WEEKLY_COUNT;
  return activeChallenges(playerId, pool, periodFor(def, now), count).some((c) => c.id === def.id);
}

// Advance the player's active challenges from a match. Online-only: offline /
// practice matches earn no challenge credit (docs/progression.md §3, §9).
function trackChallenges(playerId: string, delta: MatchDelta): void {
  if (delta.offline) return;
  const now = delta.now;
  const daily = activeChallenges(playerId, DAILY_CHALLENGES, dailyPeriod(now), DAILY_COUNT);
  const weekly = activeChallenges(playerId, WEEKLY_CHALLENGES, weeklyPeriod(now), WEEKLY_COUNT);
  for (const c of [...daily, ...weekly]) {
    const value = metricValue(c.metric, delta);
    if (value <= 0) continue; // nothing to record this match
    const stmt = c.track === 'max' ? chMaxStmt : chAddStmt;
    stmt.run({ playerId, challenge: c.id, period: periodFor(c, now), goal: c.goal, value });
  }
}

// Pay out a reward (challenge claim): add XP + credits, recompute level + any
// milestone unlocks. Returns the post-reward progression for the client.
function grantXpCredits(
  playerId: string,
  xp: number,
  credits: number,
): { progression: Progression; newUnlocks: string[] } {
  const now = Date.now();
  ensureRowStmt.run(playerId, now, now);
  const prog = progSelectStmt.get(playerId) as ProgRow | undefined;
  const owned = ownedSet(prog, playerId);
  const equipped = parseEquipped(prog?.equipped);
  const newXp = (prog?.total_xp ?? 0) + Math.max(0, Math.floor(xp));
  const newLevel = levelForXp(newXp);
  const before = new Set(owned);
  for (const id of levelGrantsAt(newLevel)) owned.add(id);
  const newUnlocks = [...owned].filter((id) => !before.has(id));
  const newCredits = (prog?.credits ?? 0) + Math.max(0, Math.floor(credits));
  progXpUpdateStmt.run({
    playerId,
    totalXp: newXp,
    level: newLevel,
    credits: newCredits,
    unlocked: JSON.stringify([...owned]),
  });
  return {
    progression: { totalXp: newXp, level: newLevel, credits: newCredits, unlocked: [...owned], equipped },
    newUnlocks,
  };
}

export type ChallengeView = {
  id: string;
  title: string;
  metric: ChallengeMetric;
  period: 'daily' | 'weekly';
  goal: number;
  progress: number;
  claimed: boolean;
  complete: boolean;
  rewardXp: number;
  rewardCredits: number;
};

export function getChallenges(
  playerId: string,
  now: number,
): { daily: ChallengeView[]; weekly: ChallengeView[] } {
  const view = (def: ChallengeDef): ChallengeView => {
    const row = chRowStmt.get(playerId, def.id, periodFor(def, now)) as
      | { progress: number; claimed: number }
      | undefined;
    const progress = row?.progress ?? 0;
    return {
      id: def.id,
      title: def.title,
      metric: def.metric,
      period: def.period,
      goal: def.goal,
      progress,
      claimed: !!row?.claimed,
      complete: progress >= def.goal,
      rewardXp: def.rewardXp,
      rewardCredits: def.rewardCredits,
    };
  };
  return {
    daily: activeChallenges(playerId, DAILY_CHALLENGES, dailyPeriod(now), DAILY_COUNT).map(view),
    weekly: activeChallenges(playerId, WEEKLY_CHALLENGES, weeklyPeriod(now), WEEKLY_COUNT).map(view),
  };
}

export type ClaimResult =
  | { ok: true; xpGained: number; creditsGained: number; progression: Progression; newUnlocks: string[] }
  | { ok: false; reason: 'unknown' | 'not_active' | 'incomplete' | 'claimed' };

export function claimChallenge(playerId: string, id: string, now: number): ClaimResult {
  if (!playerId) return { ok: false, reason: 'not_active' }; // guest: no challenges
  const def = challengeById(id);
  if (!def) return { ok: false, reason: 'unknown' };
  if (!activeFor(playerId, def, now)) return { ok: false, reason: 'not_active' };
  const period = periodFor(def, now);
  const row = chRowStmt.get(playerId, id, period) as
    | { progress: number; claimed: number }
    | undefined;
  const progress = row?.progress ?? 0;
  if (progress < def.goal) return { ok: false, reason: 'incomplete' };
  if (row?.claimed) return { ok: false, reason: 'claimed' };
  // Atomic claim: the `AND claimed = 0` guard means a second (even concurrent)
  // claim flips no rows → no double payout, independent of JS ordering.
  const info = chClaimStmt.run({ playerId, challenge: id, period });
  if (info.changes === 0) return { ok: false, reason: 'claimed' };
  const { progression, newUnlocks } = grantXpCredits(playerId, def.rewardXp, def.rewardCredits);
  return { ok: true, xpGained: def.rewardXp, creditsGained: def.rewardCredits, progression, newUnlocks };
}

// --- Global leaderboard -----------------------------------------------------

export type LeaderboardEntry = {
  id: string; // player_id — lets the client highlight the local player's row
  userName: string;
  totalKills: number;
  totalDeaths: number;
  totalGames: number;
  totalWins: number;
  bestKillStreak: number;
  headshots: number;
  bestAccuracy: number;
  kd: number; // totalDeaths > 0 ? kills/deaths : kills, rounded to 2dp
  admin: boolean; // staff badge on the standings
  verified: boolean; // blue verified check on the standings
};

// One prepared statement per sort column so we never interpolate user input
// into SQL — the router whitelists `sort`, and we pick a stmt from this map.
// kills uses the existing idx_elyxion_stats_kills index; all tiebreak on
// total_kills DESC. We only surface players who have actually played a match
// (total_games > 0). `limit` is bound as a parameter (and clamped by callers).
// Minimum games before a player appears on / is ranked by the accuracy board —
// stops a single lucky 1-shot 100% match from topping the standings.
const MIN_ACC_GAMES = 5;

const LEADERBOARD_COLS = `player_id, user_name, total_kills, total_deaths, total_games,
          total_wins, best_kill_streak, headshots, best_accuracy`;

const leaderboardStmts = {
  kills: sqlite.prepare(`
    SELECT ${LEADERBOARD_COLS}
      FROM elyxion_stats
     WHERE total_games > 0
     ORDER BY total_kills DESC
     LIMIT ?`),
  wins: sqlite.prepare(`
    SELECT ${LEADERBOARD_COLS}
      FROM elyxion_stats
     WHERE total_games > 0
     ORDER BY total_wins DESC, total_kills DESC
     LIMIT ?`),
  accuracy: sqlite.prepare(`
    SELECT ${LEADERBOARD_COLS}
      FROM elyxion_stats
     WHERE total_games >= ${MIN_ACC_GAMES}
     ORDER BY best_accuracy DESC, total_kills DESC
     LIMIT ?`),
} as const;

// Rank = 1 + (players strictly ahead on the primary metric). Ties share a rank.
const rankStmts = {
  kills: sqlite.prepare(`SELECT COUNT(*) AS n FROM elyxion_stats WHERE total_games > 0 AND total_kills > ?`),
  wins: sqlite.prepare(`SELECT COUNT(*) AS n FROM elyxion_stats WHERE total_games > 0 AND total_wins > ?`),
  accuracy: sqlite.prepare(`SELECT COUNT(*) AS n FROM elyxion_stats WHERE total_games >= ${MIN_ACC_GAMES} AND best_accuracy > ?`),
} as const;

const playerStatsRowStmt = sqlite.prepare(
  `SELECT ${LEADERBOARD_COLS} FROM elyxion_stats WHERE player_id = ?`,
);

// Same queries against the period table, parameterised by period_key (bound, not
// interpolated). Window 'daily'/'weekly' use these; 'all' uses the statements above.
const periodLeaderboardStmts = {
  kills: sqlite.prepare(`
    SELECT ${LEADERBOARD_COLS} FROM elyxion_period_stats
     WHERE period_key = ? AND total_games > 0
     ORDER BY total_kills DESC LIMIT ?`),
  wins: sqlite.prepare(`
    SELECT ${LEADERBOARD_COLS} FROM elyxion_period_stats
     WHERE period_key = ? AND total_games > 0
     ORDER BY total_wins DESC, total_kills DESC LIMIT ?`),
  accuracy: sqlite.prepare(`
    SELECT ${LEADERBOARD_COLS} FROM elyxion_period_stats
     WHERE period_key = ? AND total_games >= ${MIN_ACC_GAMES}
     ORDER BY best_accuracy DESC, total_kills DESC LIMIT ?`),
} as const;

const periodRankStmts = {
  kills: sqlite.prepare(`SELECT COUNT(*) AS n FROM elyxion_period_stats WHERE period_key = ? AND total_games > 0 AND total_kills > ?`),
  wins: sqlite.prepare(`SELECT COUNT(*) AS n FROM elyxion_period_stats WHERE period_key = ? AND total_games > 0 AND total_wins > ?`),
  accuracy: sqlite.prepare(`SELECT COUNT(*) AS n FROM elyxion_period_stats WHERE period_key = ? AND total_games >= ${MIN_ACC_GAMES} AND best_accuracy > ?`),
} as const;

const periodRowStmt = sqlite.prepare(
  `SELECT ${LEADERBOARD_COLS} FROM elyxion_period_stats WHERE player_id = ? AND period_key = ?`,
);

export type LeaderWindow = 'all' | 'daily' | 'weekly';
// The period_key a window resolves to right now (null for all-time).
function windowKey(win: LeaderWindow, now: number): string | null {
  return win === 'daily' ? dayKey(now) : win === 'weekly' ? weekKey(now) : null;
}

type LeaderboardRow = Row & { user_name: string; player_id: string };

const round2 = (n: number): number => Math.round(n * 100) / 100;

const toLeaderboardEntry = (row: LeaderboardRow): LeaderboardEntry => ({
  id: row.player_id,
  userName: row.user_name,
  totalKills: row.total_kills,
  totalDeaths: row.total_deaths,
  totalGames: row.total_games,
  totalWins: row.total_wins,
  bestKillStreak: row.best_kill_streak,
  headshots: row.headshots,
  bestAccuracy: row.best_accuracy,
  kd: round2(
    row.total_deaths > 0 ? row.total_kills / row.total_deaths : row.total_kills,
  ),
  admin: false,
  verified: false,
});

// Fill in admin/verified for a batch of entries with one parameterized query
// (player ids are the account ids, which is the users table PK). Mutates + returns.
function attachUserFlags(entries: LeaderboardEntry[]): LeaderboardEntry[] {
  if (entries.length === 0) return entries;
  const ids = entries.map((e) => e.id);
  const ph = ids.map(() => '?').join(',');
  const rows = sqlite
    .prepare(`SELECT id, is_admin, is_verified FROM elyxion_users WHERE id IN (${ph})`)
    .all(...ids) as { id: string; is_admin: number; is_verified: number }[];
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const e of entries) {
    const f = byId.get(e.id);
    if (f) {
      e.admin = !!f.is_admin;
      e.verified = !!f.is_verified;
    }
  }
  return entries;
}

export function getLeaderboard(opts: {
  sort: 'kills' | 'wins' | 'accuracy';
  limit: number;
  window?: LeaderWindow;
}): LeaderboardEntry[] {
  const limit = Math.max(1, Math.min(100, Math.floor(opts.limit)));
  const win = opts.window ?? 'all';
  const key = windowKey(win, Date.now());
  const stmt = key
    ? (periodLeaderboardStmts[opts.sort] ?? periodLeaderboardStmts.kills)
    : (leaderboardStmts[opts.sort] ?? leaderboardStmts.kills);
  const rows = (key ? stmt.all(key, limit) : stmt.all(limit)) as LeaderboardRow[];
  return attachUserFlags(rows.map(toLeaderboardEntry));
}

// The requesting player's rank + their own entry within the window, for the "you
// are #N" pin. `rank: 0` = unranked (no games this window, or below the accuracy
// floor). Returns null if the player has no row in the window at all.
export function getPlayerRank(
  playerId: string,
  sort: 'kills' | 'wins' | 'accuracy',
  window: LeaderWindow = 'all',
): { rank: number; entry: LeaderboardEntry } | null {
  if (!playerId) return null;
  const key = windowKey(window, Date.now());
  const row = (
    key ? periodRowStmt.get(playerId, key) : playerStatsRowStmt.get(playerId)
  ) as LeaderboardRow | undefined;
  if (!row || row.total_games <= 0) return null;
  const [entry] = attachUserFlags([toLeaderboardEntry(row)]);
  if (sort === 'accuracy' && row.total_games < MIN_ACC_GAMES) return { rank: 0, entry };
  const metric =
    sort === 'kills' ? row.total_kills : sort === 'wins' ? row.total_wins : row.best_accuracy;
  const above = (
    key
      ? (periodRankStmts[sort].get(key, metric) as { n: number })
      : (rankStmts[sort].get(metric) as { n: number })
  ).n;
  return { rank: above + 1, entry };
}

// ── Accounts (auth) ──────────────────────────────────────────────────────────
// Registered users + opaque session tokens. Passwords are hashed in
// server/auth.ts (scrypt); this layer only stores/reads. The account id is the
// progression player_id, so logging in carries your XP/cosmetics across devices.
const insertUserStmt = sqlite.prepare(
  `INSERT INTO elyxion_users (id, username, username_lower, pw_hash, pw_salt, email, created_at)
   VALUES (@id, @username, @usernameLower, @pwHash, @pwSalt, @email, @createdAt)`,
);
const userByLowerStmt = sqlite.prepare(
  `SELECT id, username, pw_hash, pw_salt FROM elyxion_users WHERE username_lower = ?`,
);
const userByIdStmt = sqlite.prepare(
  `SELECT id, username, is_admin, is_verified FROM elyxion_users WHERE id = ?`,
);
const accountByLowerStmt = sqlite.prepare(
  `SELECT id, username, is_admin, is_verified FROM elyxion_users WHERE username_lower = ?`,
);
const insertSessionStmt = sqlite.prepare(
  `INSERT INTO elyxion_sessions (token, user_id, created_at) VALUES (?, ?, ?)`,
);
const sessionStmt = sqlite.prepare(`SELECT user_id FROM elyxion_sessions WHERE token = ?`);
const deleteSessionStmt = sqlite.prepare(`DELETE FROM elyxion_sessions WHERE token = ?`);
const deleteUserSessionsStmt = sqlite.prepare(`DELETE FROM elyxion_sessions WHERE user_id = ?`);
const setPasswordStmt = sqlite.prepare(
  `UPDATE elyxion_users SET pw_hash = @pwHash, pw_salt = @pwSalt WHERE id = @id`,
);
const setVerifiedStmt = sqlite.prepare(`UPDATE elyxion_users SET is_verified = @v WHERE id = @id`);
const setAdminStmt = sqlite.prepare(`UPDATE elyxion_users SET is_admin = @v WHERE id = @id`);

export type UserRow = { id: string; username: string; pw_hash: string; pw_salt: string };
// Public account info (no secrets) — id, name, and moderation flags.
export type AccountInfo = { id: string; username: string; isAdmin: boolean; isVerified: boolean };
type FlagsRow = { id: string; username: string; is_admin: number; is_verified: number };
const toAccountInfo = (r: FlagsRow | undefined): AccountInfo | undefined =>
  r ? { id: r.id, username: r.username, isAdmin: !!r.is_admin, isVerified: !!r.is_verified } : undefined;

export function createUser(u: {
  id: string;
  username: string;
  usernameLower: string;
  pwHash: string;
  pwSalt: string;
  email: string | null;
  createdAt: number;
}): void {
  insertUserStmt.run(u);
}
export function findUserByName(usernameLower: string): UserRow | undefined {
  return userByLowerStmt.get(usernameLower) as UserRow | undefined;
}
export function findUserById(id: string): AccountInfo | undefined {
  return toAccountInfo(userByIdStmt.get(id) as FlagsRow | undefined);
}
// Resolve a username (lowercased) to its public account info — used by the admin
// API to verify/promote a player by name without touching password fields.
export function findAccountByName(usernameLower: string): AccountInfo | undefined {
  return toAccountInfo(accountByLowerStmt.get(usernameLower) as FlagsRow | undefined);
}
export function setVerified(id: string, value: boolean): boolean {
  return setVerifiedStmt.run({ id, v: value ? 1 : 0 }).changes > 0;
}
export function setAdmin(id: string, value: boolean): boolean {
  return setAdminStmt.run({ id, v: value ? 1 : 0 }).changes > 0;
}

// Add an administrative credit grant to an account, creating its progression
// row when the account has not played a match yet. Returns the new balance.
const grantCreditsStmt = sqlite.prepare(
  `UPDATE elyxion_stats SET credits = credits + @amount, updated_at = @now WHERE player_id = @playerId`,
);
export function grantCredits(playerId: string, amount: number, now: number = Date.now()): number | null {
  if (!playerId || !Number.isSafeInteger(amount) || amount <= 0) return null;
  ensureRowStmt.run(playerId, now, now);
  grantCreditsStmt.run({ playerId, amount, now });
  const row = progSelectStmt.get(playerId) as ProgRow | undefined;
  return row?.credits ?? null;
}
// Promote the configured ADMIN_USERNAMES to admin on boot (idempotent). Lets you
// designate your account on Railway via an env var — register first, set the var,
// redeploy. Returns the number of rows flipped.
export function syncAdminsFromEnv(usernamesLower: string[]): number {
  if (usernamesLower.length === 0) return 0;
  const ph = usernamesLower.map(() => '?').join(',');
  return sqlite
    .prepare(`UPDATE elyxion_users SET is_admin = 1 WHERE username_lower IN (${ph})`)
    .run(...usernamesLower).changes;
}
export function createSession(token: string, userId: string, now: number): void {
  insertSessionStmt.run(token, userId, now);
}
// Resolve a session token to its account id ('' if missing/unknown). This is the
// progression identity used by the stats API and the game WS.
export function userIdFromSession(token: string): string {
  if (!token) return '';
  const row = sessionStmt.get(token) as { user_id: string } | undefined;
  return row?.user_id ?? '';
}
export function deleteSession(token: string): void {
  deleteSessionStmt.run(token);
}
// Replace a password hash and revoke every active session for the account. The
// caller is responsible for generating the scrypt hash and salt.
export function setPasswordHash(id: string, pwHash: string, pwSalt: string): boolean {
  const changed = setPasswordStmt.run({ id, pwHash, pwSalt }).changes > 0;
  if (changed) deleteUserSessionsStmt.run(id);
  return changed;
}

// ── Admin metrics (dashboard) ────────────────────────────────────────────────
// Read-only aggregates for the /admin dashboard. Everything here derives from
// data we already keep: elyxion_stats (career totals + created_at/updated_at),
// elyxion_users (registrations), and elyxion_audit (the per-event timeline —
// every 'match', 'login', 'register' with a ts). All callers go through the
// requireAdmin gate. Statements are prepared once; the queries run infrequently.

const DAY_MS = 86_400_000;

// Floor a timestamp to its UTC day index (days since epoch). Used to bucket the
// audit/registration timelines without pulling strftime into hot SQL.
function dayIndex(ts: number): number {
  return Math.floor(ts / DAY_MS);
}
function dayIndexToISO(d: number): string {
  return new Date(d * DAY_MS).toISOString().slice(0, 10);
}

const mAccountsTotal = sqlite.prepare(`SELECT COUNT(*) AS n FROM elyxion_users`);
const mPlayersWithGames = sqlite.prepare(`SELECT COUNT(*) AS n FROM elyxion_stats WHERE total_games > 0`);
const mMatchesTotal = sqlite.prepare(`SELECT COUNT(*) AS n FROM elyxion_audit WHERE event = 'match'`);
// Offline/practice matches serialize "offline":true into the detail JSON; the
// online count is everything that isn't that. A coarse but reliable LIKE — our
// detail serialization is stable (see server/stats.ts).
const mOnlineMatchesTotal = sqlite.prepare(
  `SELECT COUNT(*) AS n FROM elyxion_audit WHERE event = 'match' AND detail NOT LIKE '%"offline":true%'`,
);
const mAgg = sqlite.prepare(`
  SELECT COALESCE(SUM(total_kills),0)  AS kills,
         COALESCE(SUM(total_deaths),0) AS deaths,
         COALESCE(SUM(shots_fired),0)  AS fired,
         COALESCE(SUM(shots_hit),0)    AS hit,
         COALESCE(SUM(total_xp),0)     AS xp
    FROM elyxion_stats`);
const mLifetime = sqlite.prepare(
  `SELECT AVG(updated_at - created_at) AS ms FROM elyxion_stats WHERE total_games > 0`,
);
const mWinMatches = sqlite.prepare(
  `SELECT COUNT(*) AS n FROM elyxion_audit WHERE event = 'match' AND ts >= ?`,
);
const mWinActive = sqlite.prepare(
  `SELECT COUNT(DISTINCT actor_id) AS n FROM elyxion_audit
     WHERE event IN ('match','login') AND actor_id <> '' AND ts >= ?`,
);
const mWinNewAccounts = sqlite.prepare(`SELECT COUNT(*) AS n FROM elyxion_users WHERE created_at >= ?`);
const mWinLogins = sqlite.prepare(`SELECT COUNT(*) AS n FROM elyxion_audit WHERE event = 'login' AND ts >= ?`);

type MetricsWindow = {
  matches: number;
  activePlayers: number;
  newAccounts: number;
  logins: number;
};
export type MetricsOverview = {
  totalAccounts: number;
  playersWithGames: number;
  totalMatches: number; // recorded match submissions (incl. offline/practice)
  onlineMatches: number; // excludes offline/practice
  totalKills: number;
  totalDeaths: number;
  globalAccuracy: number; // SUM(hit)/SUM(fired) × 100, 0 if no shots
  totalXp: number;
  avgLifetimeDays: number; // mean (updated_at − created_at) over players with games
  stickiness: number; // DAU / MAU, 0..1
  windows: { day: MetricsWindow; week: MetricsWindow; month: MetricsWindow };
};

const num = (r: unknown): number => (r as { n: number }).n;
function windowMetrics(sinceTs: number): MetricsWindow {
  return {
    matches: num(mWinMatches.get(sinceTs)),
    activePlayers: num(mWinActive.get(sinceTs)),
    newAccounts: num(mWinNewAccounts.get(sinceTs)),
    logins: num(mWinLogins.get(sinceTs)),
  };
}

export function getMetricsOverview(now: number = Date.now()): MetricsOverview {
  const agg = mAgg.get() as { kills: number; deaths: number; fired: number; hit: number; xp: number };
  const day = windowMetrics(now - DAY_MS);
  const week = windowMetrics(now - 7 * DAY_MS);
  const month = windowMetrics(now - 30 * DAY_MS);
  const lifeMs = (mLifetime.get() as { ms: number | null }).ms ?? 0;
  return {
    totalAccounts: num(mAccountsTotal.get()),
    playersWithGames: num(mPlayersWithGames.get()),
    totalMatches: num(mMatchesTotal.get()),
    onlineMatches: num(mOnlineMatchesTotal.get()),
    totalKills: agg.kills,
    totalDeaths: agg.deaths,
    globalAccuracy: agg.fired > 0 ? round2((agg.hit / agg.fired) * 100) : 0,
    totalXp: agg.xp,
    avgLifetimeDays: round2(lifeMs / DAY_MS),
    stickiness: month.activePlayers > 0 ? round2(day.activePlayers / month.activePlayers) : 0,
    windows: { day, week, month },
  };
}

const mTsMatches = sqlite.prepare(
  `SELECT CAST(ts/${DAY_MS} AS INTEGER) AS d, COUNT(*) AS n
     FROM elyxion_audit WHERE event = 'match' AND ts >= ? GROUP BY d`,
);
const mTsLogins = sqlite.prepare(
  `SELECT CAST(ts/${DAY_MS} AS INTEGER) AS d, COUNT(*) AS n
     FROM elyxion_audit WHERE event = 'login' AND ts >= ? GROUP BY d`,
);
const mTsActive = sqlite.prepare(
  `SELECT CAST(ts/${DAY_MS} AS INTEGER) AS d, COUNT(DISTINCT actor_id) AS n
     FROM elyxion_audit WHERE event IN ('match','login') AND actor_id <> '' AND ts >= ? GROUP BY d`,
);
const mTsRegs = sqlite.prepare(
  `SELECT CAST(created_at/${DAY_MS} AS INTEGER) AS d, COUNT(*) AS n
     FROM elyxion_users WHERE created_at >= ? GROUP BY d`,
);

export type DayPoint = {
  date: string; // YYYY-MM-DD (UTC)
  matches: number;
  logins: number;
  registrations: number;
  activePlayers: number;
};

// A continuous daily series (gaps filled with zeros) for the last `days` days —
// charts need a dense series, so we materialize every day in the range.
export function getMetricsTimeseries(days: number, now: number = Date.now()): DayPoint[] {
  const span = Math.max(1, Math.min(180, Math.floor(days)));
  const today = dayIndex(now);
  const start = today - (span - 1);
  const cutoff = start * DAY_MS;
  const toMap = (rows: unknown[]): Map<number, number> =>
    new Map((rows as { d: number; n: number }[]).map((r) => [r.d, r.n]));
  const matches = toMap(mTsMatches.all(cutoff));
  const logins = toMap(mTsLogins.all(cutoff));
  const active = toMap(mTsActive.all(cutoff));
  const regs = toMap(mTsRegs.all(cutoff));
  const out: DayPoint[] = [];
  for (let d = start; d <= today; d++) {
    out.push({
      date: dayIndexToISO(d),
      matches: matches.get(d) ?? 0,
      logins: logins.get(d) ?? 0,
      registrations: regs.get(d) ?? 0,
      activePlayers: active.get(d) ?? 0,
    });
  }
  return out;
}

// Cohort retention: of the accounts that registered on day D, how many came back
// (a 'match' or 'login') within the next 1 day (D1) and the next 7 days (D7).
// Both windows exclude the registration day itself. A single correlated-subquery
// pass — fine at alpha volume, all indexed on (event, ts) / (actor_id implicit).
const mRetention = sqlite.prepare(`
  SELECT CAST(u.created_at/${DAY_MS} AS INTEGER) AS d,
         COUNT(*) AS size,
         SUM(CASE WHEN EXISTS (
           SELECT 1 FROM elyxion_audit a
            WHERE a.actor_id = u.id AND a.event IN ('match','login')
              AND a.ts >= u.created_at + ${DAY_MS} AND a.ts < u.created_at + 2*${DAY_MS}
         ) THEN 1 ELSE 0 END) AS d1,
         SUM(CASE WHEN EXISTS (
           SELECT 1 FROM elyxion_audit a
            WHERE a.actor_id = u.id AND a.event IN ('match','login')
              AND a.ts >= u.created_at + ${DAY_MS} AND a.ts < u.created_at + 8*${DAY_MS}
         ) THEN 1 ELSE 0 END) AS d7
    FROM elyxion_users u
   WHERE u.created_at >= ?
   GROUP BY d ORDER BY d`);

export type RetentionCohort = { date: string; size: number; d1: number; d7: number };
export function getRetention(days: number, now: number = Date.now()): RetentionCohort[] {
  const span = Math.max(1, Math.min(120, Math.floor(days)));
  const cutoff = (dayIndex(now) - (span - 1)) * DAY_MS;
  return (mRetention.all(cutoff) as { d: number; size: number; d1: number; d7: number }[]).map(
    (r) => ({ date: dayIndexToISO(r.d), size: r.size, d1: r.d1, d7: r.d7 }),
  );
}

const mRecentMatches = sqlite.prepare(
  `SELECT id, ts, actor_id, actor_name, detail FROM elyxion_audit
     WHERE event = 'match' ORDER BY id DESC LIMIT ?`,
);
const mRecentMatchesBefore = sqlite.prepare(
  `SELECT id, ts, actor_id, actor_name, detail FROM elyxion_audit
     WHERE event = 'match' AND id < ? ORDER BY id DESC LIMIT ?`,
);

export type MatchRow = {
  id: number;
  ts: number;
  playerId: string;
  playerName: string;
  kills: number;
  deaths: number;
  won: boolean;
  headshots: number;
  accuracy: number;
  offline: boolean;
  xp: number;
  mode: string | null;
};

// Recent recorded matches, newest first, keyset-paginated by audit id (pass the
// last id you saw as `beforeId`). The per-match detail blob is parsed here.
export function getRecentMatches(limit: number, beforeId?: number): MatchRow[] {
  const n = Math.max(1, Math.min(200, Math.floor(limit)));
  const rows = (
    beforeId && beforeId > 0 ? mRecentMatchesBefore.all(beforeId, n) : mRecentMatches.all(n)
  ) as { id: number; ts: number; actor_id: string; actor_name: string; detail: string }[];
  return rows.map((r) => {
    let d: Record<string, unknown> = {};
    try {
      d = JSON.parse(r.detail) as Record<string, unknown>;
    } catch {
      /* malformed/empty detail → zeros */
    }
    const intOf = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    return {
      id: r.id,
      ts: r.ts,
      playerId: r.actor_id,
      playerName: r.actor_name || 'Guest',
      kills: intOf(d.kills),
      deaths: intOf(d.deaths),
      won: d.won === true,
      headshots: intOf(d.headshots),
      accuracy: intOf(d.accuracy),
      offline: d.offline === true,
      xp: intOf(d.xp),
      mode: typeof d.mode === 'string' ? d.mode : null,
    };
  });
}

export type PlayerRow = {
  id: string;
  userName: string;
  level: number;
  totalGames: number;
  totalKills: number;
  totalDeaths: number;
  headshots: number;
  bestAccuracy: number;
  totalXp: number;
  credits: number;
  kd: number;
  lastSeen: number; // updated_at
  createdAt: number; // registration (users) or first stat row
  admin: boolean;
  verified: boolean;
};

type PlayerTableRow = {
  player_id: string;
  user_name: string;
  level: number;
  total_games: number;
  total_kills: number;
  total_deaths: number;
  headshots: number;
  best_accuracy: number;
  total_xp: number;
  credits: number;
  updated_at: number;
  created_at: number;
  is_admin: number;
  is_verified: number;
};

// Whitelisted sort → ORDER BY clause. The key is validated against this map's
// own keys, so nothing user-supplied is ever interpolated into the SQL string.
const PLAYER_SORTS: Record<string, string> = {
  kills: 'COALESCE(s.total_kills, 0) DESC',
  games: 'COALESCE(s.total_games, 0) DESC',
  level: 'COALESCE(s.level, 1) DESC, COALESCE(s.total_xp, 0) DESC',
  accuracy: 'COALESCE(s.best_accuracy, 0) DESC, COALESCE(s.total_games, 0) DESC',
  xp: 'COALESCE(s.total_xp, 0) DESC',
  recent: 'COALESCE(s.updated_at, u.created_at) DESC',
};
const PLAYER_COLS = `u.id AS player_id, COALESCE(u.username, s.user_name) AS user_name,
  COALESCE(s.level, 1) AS level, COALESCE(s.total_games, 0) AS total_games,
  COALESCE(s.total_kills, 0) AS total_kills, COALESCE(s.total_deaths, 0) AS total_deaths,
  COALESCE(s.headshots, 0) AS headshots, COALESCE(s.best_accuracy, 0) AS best_accuracy,
  COALESCE(s.total_xp, 0) AS total_xp, COALESCE(s.credits, 0) AS credits,
  COALESCE(s.updated_at, u.created_at) AS updated_at, u.created_at AS created_at,
  COALESCE(u.is_admin, 0) AS is_admin, COALESCE(u.is_verified, 0) AS is_verified`;

export function getPlayersTable(opts: {
  sort?: string;
  q?: string;
  limit?: number;
}): PlayerRow[] {
  const orderBy = PLAYER_SORTS[opts.sort ?? 'recent'] ?? PLAYER_SORTS.recent;
  const limit = Math.max(1, Math.min(500, Math.floor(opts.limit ?? 100)));
  const like = `%${(opts.q ?? '').slice(0, 40)}%`;
  const rows = sqlite
    .prepare(
      `SELECT ${PLAYER_COLS}
         FROM elyxion_users u LEFT JOIN elyxion_stats s ON s.player_id = u.id
        WHERE u.username LIKE ?
        ORDER BY ${orderBy} LIMIT ?`,
    )
    .all(like, limit) as PlayerTableRow[];
  return rows.map((r) => ({
    id: r.player_id,
    userName: r.user_name,
    level: r.level,
    totalGames: r.total_games,
    totalKills: r.total_kills,
    totalDeaths: r.total_deaths,
    headshots: r.headshots,
    bestAccuracy: r.best_accuracy,
    totalXp: r.total_xp,
    credits: r.credits,
    kd: round2(r.total_deaths > 0 ? r.total_kills / r.total_deaths : r.total_kills),
    lastSeen: r.updated_at,
    createdAt: r.created_at,
    admin: !!r.is_admin,
    verified: !!r.is_verified,
  }));
}

// ── Ranked Duel ladder (Elo) ─────────────────────────────────────────────────
// Separate from career stats: a hidden-then-shown Elo rating per account, updated
// only by ranked 1v1 results (server-authoritative — the game server reports the
// winner, the client never sends a rating). Login-gated, so player_id is always a
// real account id. Cosmetic-adjacent: rank is bragging rights, never an advantage.
sqlite.exec(`
CREATE TABLE IF NOT EXISTS elyxion_ranked (
  player_id  TEXT PRIMARY KEY,
  user_name  TEXT NOT NULL,
  rating     INTEGER NOT NULL DEFAULT 1000,
  peak       INTEGER NOT NULL DEFAULT 1000,
  games      INTEGER NOT NULL DEFAULT 0,
  wins       INTEGER NOT NULL DEFAULT 0,
  losses     INTEGER NOT NULL DEFAULT 0,
  streak     INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ranked_rating ON elyxion_ranked(rating);
`);

const RANKED_BASE_RATING = 1000;
const RANKED_PLACEMENT_GAMES = 5; // below this, rating shows as "provisional"

// Classic Elo K-factor: volatile while provisional, calmer once established, and
// smallest at the top so elite ratings don't swing on a single game.
function kFactor(games: number, rating: number): number {
  if (games < 10) return 40;
  if (rating >= 2100) return 16;
  return 24;
}

const rankedRowStmt = sqlite.prepare(`SELECT * FROM elyxion_ranked WHERE player_id = ?`);
const rankedEnsureStmt = sqlite.prepare(`
  INSERT OR IGNORE INTO elyxion_ranked (player_id, user_name, rating, peak, created_at, updated_at)
  VALUES (@playerId, @userName, ${RANKED_BASE_RATING}, ${RANKED_BASE_RATING}, @now, @now)`);
const rankedUpdateStmt = sqlite.prepare(`
  UPDATE elyxion_ranked
     SET user_name = @userName, rating = @rating, peak = max(peak, @rating),
         games = games + 1, wins = wins + @win, losses = losses + @loss,
         streak = @streak, updated_at = @now
   WHERE player_id = @playerId`);
const rankedRankStmt = sqlite.prepare(
  `SELECT COUNT(*) AS n FROM elyxion_ranked WHERE games > 0 AND rating > ?`,
);

type RankedRow = {
  player_id: string;
  user_name: string;
  rating: number;
  peak: number;
  games: number;
  wins: number;
  losses: number;
  streak: number;
  created_at: number;
  updated_at: number;
};

export type RankedProfile = {
  id: string;
  userName: string;
  rating: number;
  peak: number;
  games: number;
  wins: number;
  losses: number;
  streak: number;
  rank: number; // ladder position (1 = top); 0 if unranked (no games)
  provisional: boolean;
};

function toRankedProfile(r: RankedRow): RankedProfile {
  return {
    id: r.player_id,
    userName: r.user_name,
    rating: r.rating,
    peak: r.peak,
    games: r.games,
    wins: r.wins,
    losses: r.losses,
    streak: r.streak,
    rank: r.games > 0 ? num(rankedRankStmt.get(r.rating)) + 1 : 0,
    provisional: r.games < RANKED_PLACEMENT_GAMES,
  };
}

// A player's ranked profile (null = never queued ranked). The base rating for a
// brand-new ranked player (so the queue can match on it before their first game).
export function getRankedProfile(playerId: string): RankedProfile | null {
  if (!playerId) return null;
  const r = rankedRowStmt.get(playerId) as RankedRow | undefined;
  return r ? toRankedProfile(r) : null;
}

// Current rating for matchmaking — the stored value, or the base for a newcomer.
export function getRankedRating(playerId: string): number {
  const r = rankedRowStmt.get(playerId) as RankedRow | undefined;
  return r?.rating ?? RANKED_BASE_RATING;
}

export type RankedResult = {
  winner: { id: string; userName: string; rating: number; delta: number; rank: number };
  loser: { id: string; userName: string; rating: number; delta: number; rank: number };
};

// Apply a ranked 1v1 result (server-authoritative). Symmetric Elo: the winner
// gains what the loser sheds, scaled by the upset. `weight` (0..1) damps the
// rating change for a repeat opponent (anti match-fixing — see endRankedMatch);
// at weight 1 it's a normal full-value game. Both rows are created on demand,
// floored at 100 so a rating can't go negative. Synchronous + single-threaded,
// so the read-compute-write can't interleave. Audited as 'ranked.match'.
export function recordRankedResult(
  winnerId: string,
  winnerName: string,
  loserId: string,
  loserName: string,
  now: number = Date.now(),
  weight: number = 1,
): RankedResult | null {
  if (!winnerId || !loserId || winnerId === loserId) return null;
  const w8 = Math.max(0, Math.min(1, weight));
  rankedEnsureStmt.run({ playerId: winnerId, userName: winnerName, now });
  rankedEnsureStmt.run({ playerId: loserId, userName: loserName, now });
  const w = rankedRowStmt.get(winnerId) as RankedRow;
  const l = rankedRowStmt.get(loserId) as RankedRow;
  const expectedW = 1 / (1 + 10 ** ((l.rating - w.rating) / 400));
  const dW = Math.round(kFactor(w.games, w.rating) * (1 - expectedW) * w8);
  const dL = Math.round(kFactor(l.games, l.rating) * (0 - (1 - expectedW)) * w8);
  const newW = Math.max(100, w.rating + dW);
  const newL = Math.max(100, l.rating + dL);
  rankedUpdateStmt.run({
    playerId: winnerId,
    userName: winnerName,
    rating: newW,
    win: 1,
    loss: 0,
    streak: w.streak >= 0 ? w.streak + 1 : 1,
    now,
  });
  rankedUpdateStmt.run({
    playerId: loserId,
    userName: loserName,
    rating: newL,
    win: 0,
    loss: 1,
    streak: l.streak <= 0 ? l.streak - 1 : -1,
    now,
  });
  logEvent({
    event: 'ranked.match',
    actorId: winnerId,
    actorName: winnerName,
    targetId: loserId,
    detail: { winnerRating: newW, loserRating: newL, dW, dL, weight: w8, loser: loserName },
    now,
  });
  return {
    winner: { id: winnerId, userName: winnerName, rating: newW, delta: newW - w.rating, rank: num(rankedRankStmt.get(newW)) + 1 },
    loser: { id: loserId, userName: loserName, rating: newL, delta: newL - l.rating, rank: num(rankedRankStmt.get(newL)) + 1 },
  };
}

const rankedLeaderboardStmt = sqlite.prepare(
  `SELECT * FROM elyxion_ranked WHERE games > 0 ORDER BY rating DESC, wins DESC LIMIT ?`,
);
export type RankedLeaderEntry = {
  id: string;
  userName: string;
  rating: number;
  games: number;
  wins: number;
  losses: number;
  streak: number;
  admin: boolean;
  verified: boolean;
};
export function getRankedLeaderboard(limit: number): RankedLeaderEntry[] {
  const n = Math.max(1, Math.min(100, Math.floor(limit)));
  const rows = rankedLeaderboardStmt.all(n) as RankedRow[];
  const base: RankedLeaderEntry[] = rows.map((r) => ({
    id: r.player_id,
    userName: r.user_name,
    rating: r.rating,
    games: r.games,
    wins: r.wins,
    losses: r.losses,
    streak: r.streak,
    admin: false,
    verified: false,
  }));
  if (base.length) {
    const ph = base.map(() => '?').join(',');
    const flags = sqlite
      .prepare(`SELECT id, is_admin, is_verified FROM elyxion_users WHERE id IN (${ph})`)
      .all(...base.map((e) => e.id)) as { id: string; is_admin: number; is_verified: number }[];
    const byId = new Map(flags.map((f) => [f.id, f]));
    for (const e of base) {
      const f = byId.get(e.id);
      if (f) {
        e.admin = !!f.is_admin;
        e.verified = !!f.is_verified;
      }
    }
  }
  return base;
}

// ── Weekly Challenge ─────────────────────────────────────────────────────────
// A weekly leaderboard for the solo SPEEDRUN challenge (8p FFA vs easy bots).
// SPEEDRUN order: anyone who beat the bots to the cap (best_time_ms > 0) ranks
// above anyone who didn't, fastest WIN first; non-winners then rank by most kills
// (best_kills). Account-only and SEPARATE from career stats — it never touches
// K/D. The match is offline (vs bots) so scores are client-reported + clamped
// (best-effort, like career stats); the stakes are a cosmetic weekly board, and
// each board-defining run also stores a rewatchable replay (elyxion_weekly_replay).
sqlite.exec(`
CREATE TABLE IF NOT EXISTS elyxion_weekly_challenge (
  player_id    TEXT NOT NULL,
  week_key     TEXT NOT NULL,
  user_name    TEXT NOT NULL,
  best_kills   INTEGER NOT NULL DEFAULT 0,
  best_time_ms INTEGER NOT NULL DEFAULT 0,  -- fastest winning run (0 = never won)
  runs         INTEGER NOT NULL DEFAULT 0,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (player_id, week_key)
);
CREATE INDEX IF NOT EXISTS idx_weekly_challenge ON elyxion_weekly_challenge(week_key, best_kills);
`);

const wcRowStmt = sqlite.prepare(
  `SELECT * FROM elyxion_weekly_challenge WHERE player_id = ? AND week_key = ?`,
);
const wcEnsureStmt = sqlite.prepare(`
  INSERT OR IGNORE INTO elyxion_weekly_challenge (player_id, week_key, user_name, updated_at)
  VALUES (@playerId, @weekKey, @userName, @now)`);
const wcUpdateStmt = sqlite.prepare(`
  UPDATE elyxion_weekly_challenge
     SET user_name = @userName, best_kills = @bestKills, best_time_ms = @bestTimeMs,
         runs = runs + 1, updated_at = @now
   WHERE player_id = @playerId AND week_key = @weekKey`);
// SPEEDRUN order: anyone who beat the bots (best_time_ms > 0) ranks above anyone
// who didn't, fastest win first; non-winners then rank by most kills. Recency
// breaks any remaining tie.
const WC_ORDER = `ORDER BY
  (CASE WHEN best_time_ms > 0 THEN 0 ELSE 1 END) ASC,
  (CASE WHEN best_time_ms > 0 THEN best_time_ms ELSE 9.0e18 END) ASC,
  best_kills DESC,
  updated_at ASC`;
const wcLeaderboardStmt = sqlite.prepare(
  `SELECT * FROM elyxion_weekly_challenge WHERE week_key = ? ${WC_ORDER} LIMIT ?`,
);
// Count entries strictly ahead of (@timeMs, @kills): every winner beats a
// non-winner; among winners the faster one beats; among non-winners more kills
// beats. @timeMs <= 0 means the caller is a non-winner.
const wcRankStmt = sqlite.prepare(`
  SELECT COUNT(*) AS n FROM elyxion_weekly_challenge
   WHERE week_key = @weekKey AND (
     (best_time_ms > 0 AND (@timeMs <= 0 OR best_time_ms < @timeMs))
     OR
     (best_time_ms = 0 AND @timeMs <= 0 AND best_kills > @kills)
   )`);

// ── Weekly-challenge REPLAYS ─────────────────────────────────────────────────
// The full recorded run for a player's board-defining run, so anyone can rewatch
// it (transparency / anti-cheat). One row per (player, week); overwritten when a
// player sets a new board-defining run. The blob is the gzipped replay-codec
// binary. Storage is bounded by pruning every week but the current one on write.
sqlite.exec(`
CREATE TABLE IF NOT EXISTS elyxion_weekly_replay (
  player_id   TEXT NOT NULL,
  week_key    TEXT NOT NULL,
  data        BLOB NOT NULL,       -- gzipped replay-codec binary
  raw_bytes   INTEGER NOT NULL,    -- uncompressed size
  duration_ms INTEGER NOT NULL,
  kills       INTEGER NOT NULL,
  won         INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (player_id, week_key)
);
CREATE INDEX IF NOT EXISTS idx_weekly_replay_week ON elyxion_weekly_replay(week_key);
`);

const wrUpsertStmt = sqlite.prepare(`
  INSERT INTO elyxion_weekly_replay
    (player_id, week_key, data, raw_bytes, duration_ms, kills, won, created_at)
  VALUES (@playerId, @weekKey, @data, @rawBytes, @durationMs, @kills, @won, @createdAt)
  ON CONFLICT(player_id, week_key) DO UPDATE SET
    data = @data, raw_bytes = @rawBytes, duration_ms = @durationMs,
    kills = @kills, won = @won, created_at = @createdAt`);
const wrGetStmt = sqlite.prepare(
  `SELECT data, raw_bytes, duration_ms, kills, won FROM elyxion_weekly_replay
    WHERE player_id = ? AND week_key = ?`,
);
const wrPruneStmt = sqlite.prepare(`DELETE FROM elyxion_weekly_replay WHERE week_key != ?`);
const wrWeekPlayersStmt = sqlite.prepare(
  `SELECT player_id FROM elyxion_weekly_replay WHERE week_key = ?`,
);

// Store (gzip) a player's board-defining run for the week, overwriting any prior
// one, and prune replays from previous weeks (keeps the table ~one week deep).
export function storeWeeklyReplay(
  playerId: string,
  raw: Uint8Array,
  meta: { durationMs: number; kills: number; won: boolean },
  now: number = Date.now(),
): void {
  if (!playerId || raw.length === 0) return;
  const wk = challengeWeekKey(now);
  const gz = zlib.gzipSync(Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength));
  wrUpsertStmt.run({
    playerId,
    weekKey: wk,
    data: gz,
    rawBytes: raw.length,
    durationMs: Math.max(0, Math.floor(meta.durationMs)),
    kills: Math.max(0, Math.floor(meta.kills)),
    won: meta.won ? 1 : 0,
    createdAt: now,
  });
  wrPruneStmt.run(wk);
}

// Fetch a player's stored run for the week as the on-disk GZIP blob (no server
// gunzip — the endpoint serves it with Content-Encoding: gzip and the client
// inflates, or gunzips it itself for a non-gzip client). Returns null if absent.
export function getWeeklyReplayGz(
  playerId: string,
  now: number = Date.now(),
): { gz: Buffer; durationMs: number; kills: number; won: boolean } | null {
  if (!playerId) return null;
  const row = wrGetStmt.get(playerId, challengeWeekKey(now)) as
    | { data: Buffer; raw_bytes: number; duration_ms: number; kills: number; won: number }
    | undefined;
  if (!row) return null;
  try {
    return {
      gz: row.data,
      durationMs: row.duration_ms,
      kills: row.kills,
      won: !!row.won,
    };
  } catch {
    return null;
  }
}

// Player ids with a stored replay this week (for the leaderboard's Watch flag).
function weeklyReplayPlayerIds(weekKeyStr: string): Set<string> {
  const rows = wrWeekPlayersStmt.all(weekKeyStr) as { player_id: string }[];
  return new Set(rows.map((r) => r.player_id));
}

// ── Temporary shareable replays ──────────────────────────────────────────────
// Every finished match can be uploaded as a short-lived, shareable replay
// (`/replay/<code>`). Rows expire after TTL_SHARE_REPLAY_HOURS (server sweeper
// deletes them) — the storage is explicitly temporary, so the cap + sweep bound
// disk growth tightly. The blob is the gzipped replay-codec binary exactly like
// weekly replays; the summary columns let the recap page render the full
// competition-style header + standings WITHOUT downloading the blob.
sqlite.exec(`
CREATE TABLE IF NOT EXISTS elyxion_temp_replays (
  code       TEXT PRIMARY KEY,
  data       BLOB NOT NULL,       -- gzipped replay-codec binary
  raw_bytes  INTEGER NOT NULL,
  map_id     TEXT NOT NULL DEFAULT '',
  won        INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  runner     TEXT NOT NULL DEFAULT '',
  stats_json TEXT NOT NULL DEFAULT '{}', -- {runner:{kills,deaths,headshots,shots},players:[{name,kills,deaths,headshots}]}
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  user_id    TEXT NOT NULL DEFAULT '', -- uploading account ('' = guest upload, not listable)
  mode       TEXT NOT NULL DEFAULT ''  -- match mode tag: ffa/duel/tdm/ranked/solo/bots/challenge/training
);
CREATE INDEX IF NOT EXISTS idx_temp_replays_expires ON elyxion_temp_replays(expires_at);
`);

// Additive temp-replay columns (same no-migration pattern): user_id ties uploads
// to the account for the "My replays" page; mode labels the gamemode. Old
// databases get the columns added on boot — and the user index is created HERE
// (after the ALTERs), never in the CREATE TABLE exec, because that runs against
// live old tables before this guard.
function ensureTempReplayColumns() {
  const cols = new Set(
    (sqlite.prepare(`PRAGMA table_info(elyxion_temp_replays)`).all() as { name: string }[]).map(
      (r) => r.name,
    ),
  );
  if (!cols.has('user_id')) sqlite.exec(`ALTER TABLE elyxion_temp_replays ADD COLUMN user_id TEXT NOT NULL DEFAULT ''`);
  if (!cols.has('mode')) sqlite.exec(`ALTER TABLE elyxion_temp_replays ADD COLUMN mode TEXT NOT NULL DEFAULT ''`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_temp_replays_user ON elyxion_temp_replays(user_id, created_at)`);
}
ensureTempReplayColumns();

export const TMP_REPLAY_HOURS = 24; // "temporary": share links live a day, then die
const TMP_REPLAY_MAX_ROWS = 5_000; // growth backstop (sweeper also prunes expired)

const trInsertStmt = sqlite.prepare(`
  INSERT INTO elyxion_temp_replays
    (code, data, raw_bytes, map_id, won, duration_ms, runner, stats_json, created_at, expires_at, user_id, mode)
  VALUES (@code, @data, @rawBytes, @mapId, @won, @durationMs, @runner, @statsJson, @now, @expiresAt, @userId, @mode)`);
const trGetMetaStmt = sqlite.prepare(
  `SELECT map_id, won, duration_ms, runner, stats_json, created_at, expires_at FROM elyxion_temp_replays WHERE code = ?`,
);
const trGetBlobStmt = sqlite.prepare(`SELECT data FROM elyxion_temp_replays WHERE code = ? AND expires_at > ?`);
const trGetEditStmt = sqlite.prepare(
  `SELECT data, mode FROM elyxion_temp_replays WHERE code = ? AND user_id = ? AND expires_at > ?`,
);
const trDeleteStmt = sqlite.prepare(`DELETE FROM elyxion_temp_replays WHERE code = ?`);
const trSweepStmt = sqlite.prepare(`DELETE FROM elyxion_temp_replays WHERE expires_at < ?`);
const trTrimStmt = sqlite.prepare(
  `DELETE FROM elyxion_temp_replays WHERE code NOT IN
     (SELECT code FROM elyxion_temp_replays ORDER BY created_at DESC LIMIT ?)`,
);

export type TempReplayMeta = {
  code: string;
  mapId: string;
  won: boolean;
  durationMs: number;
  runner: string;
  createdAt: number;
  expiresAt: number;
  rawBytes: number;
  stats: {
    runner: { kills: number; deaths: number; headshots: number; shots: number };
    players: { name: string; kills: number; deaths: number; headshots: number }[];
  };
};

type TempReplayMetaRow = {
  map_id: string;
  won: number;
  duration_ms: number;
  runner: string;
  stats_json: string;
  created_at: number;
  expires_at: number;
};

export type TempReplayInput = {
  code: string;
  dataGz: Buffer;
  rawBytes: number;
  mapId: string;
  won: boolean;
  durationMs: number;
  runner: string;
  statsJson: string;
  now: number;
  userId: string; // uploading account id ('' = guest upload)
  mode: string; // ffa/duel/tdm/ranked/solo/bots/challenge/training ('' = unknown)
};

// Store a new temp replay (gzip blob + derived summary). Returns false if the
// code already exists (collision — caller retries with a fresh code).
export function storeTempReplay(t: TempReplayInput): boolean {
  try {
    const r = trInsertStmt.run({
      code: t.code,
      data: t.dataGz,
      rawBytes: t.rawBytes,
      mapId: t.mapId,
      won: t.won ? 1 : 0,
      durationMs: Math.max(0, Math.floor(t.durationMs)),
      runner: t.runner.slice(0, 32) || 'Player',
      statsJson: t.statsJson.slice(0, 64_000),
      now: t.now,
      expiresAt: t.now + TMP_REPLAY_HOURS * 3600_000,
      userId: t.userId.slice(0, 64),
      mode: t.mode.slice(0, 16),
    });
    if (r.changes > 0) trTrimStmt.run(TMP_REPLAY_MAX_ROWS);
    return r.changes > 0;
  } catch {
    return false;
  }
}

export type MyReplayRow = {
  code: string;
  mapId: string;
  mode: string;
  won: boolean;
  durationMs: number;
  runner: string;
  statsJson: string;
  createdAt: number;
  expiresAt: number;
};

const trUserListStmt = sqlite.prepare(
  `SELECT code, map_id, mode, won, duration_ms, runner, stats_json, created_at, expires_at
   FROM elyxion_temp_replays WHERE user_id = ? AND expires_at > ?
   ORDER BY created_at DESC LIMIT 200`,
);
const trUserDeleteStmt = sqlite.prepare(
  `DELETE FROM elyxion_temp_replays WHERE code = ? AND user_id = ?`,
);

// Active replays belonging to one account, newest first — powers the "My
// replays" page. Blobs are NOT fetched (the page only needs the summary).
export function listTempReplaysForUser(userId: string, now: number = Date.now()): MyReplayRow[] {
  if (!userId) return [];
  const rows = trUserListStmt.all(userId, now) as {
    code: string;
    map_id: string;
    mode: string;
    won: number;
    duration_ms: number;
    runner: string;
    stats_json: string;
    created_at: number;
    expires_at: number;
  }[];
  return rows.map((r) => ({
    code: r.code,
    mapId: r.map_id,
    mode: r.mode,
    won: !!r.won,
    durationMs: r.duration_ms,
    runner: r.runner,
    statsJson: r.stats_json,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
  }));
}

// Owner-scoped delete: only the account that uploaded a replay may remove it
// (admins can purge via the DB directly). False when the code isn't theirs.
export function deleteTempReplayForUser(code: string, userId: string): boolean {
  if (!userId || !code) return false;
  try {
    return trUserDeleteStmt.run(code, userId).changes > 0;
  } catch {
    return false;
  }
}

export function getTempReplayMeta(code: string, now: number = Date.now()): TempReplayMeta | null {
  const row = trGetMetaStmt.get(code) as TempReplayMetaRow | undefined;
  if (!row || row.expires_at < now) return null;
  let stats = { runner: { kills: 0, deaths: 0, headshots: 0, shots: 0 }, players: [] as TempReplayMeta['stats']['players'] };
  try {
    stats = JSON.parse(row.stats_json) as TempReplayMeta['stats'];
  } catch {
    /* stale/malformed summary → zeros */
  }
  return {
    code,
    mapId: row.map_id,
    won: !!row.won,
    durationMs: row.duration_ms,
    runner: row.runner || 'Player',
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    rawBytes: 0, // filled by getTempReplayBlob when the blob is fetched
    stats,
  };
}

export function getTempReplayBlob(code: string, now: number = Date.now()): Buffer | null {
  const row = trGetBlobStmt.get(code, now) as { data: Buffer } | undefined;
  return row ? row.data : null;
}

// Owner-scoped source for the replay editor. The mode travels alongside the blob
// so a saved edit remains grouped with the original match type in My Replays.
export function getTempReplayBlobForUser(
  code: string,
  userId: string,
  now: number = Date.now(),
): { data: Buffer; mode: string } | null {
  if (!code || !userId) return null;
  const row = trGetEditStmt.get(code, userId, now) as { data: Buffer; mode: string } | undefined;
  return row ? { data: row.data, mode: row.mode } : null;
}

// Expired rows → deleted. Returns how many were removed (0 when idle).
export function sweepTempReplays(now: number = Date.now()): number {
  try {
    return trSweepStmt.run(now).changes;
  } catch {
    return 0;
  }
}

export function deleteTempReplay(code: string): boolean {
  try {
    return trDeleteStmt.run(code).changes > 0;
  } catch {
    return false;
  }
}

// Headline weekly-challenge participation for the metrics/analytics API.
const wcStatsStmt = sqlite.prepare(`
  SELECT COUNT(*) AS participants,
         COALESCE(SUM(runs), 0) AS runs,
         COALESCE(SUM(CASE WHEN best_time_ms > 0 THEN 1 ELSE 0 END), 0) AS winners,
         MIN(CASE WHEN best_time_ms > 0 THEN best_time_ms END) AS best_time_ms,
         COALESCE(MAX(best_kills), 0) AS top_kills
    FROM elyxion_weekly_challenge WHERE week_key = ?`);
const wrStatsStmt = sqlite.prepare(
  `SELECT COUNT(*) AS n, COALESCE(SUM(raw_bytes), 0) AS bytes FROM elyxion_weekly_replay WHERE week_key = ?`,
);

export type WeeklyChallengeStats = {
  week: string;
  participants: number;
  runs: number;
  winners: number;
  bestTimeMs: number; // fastest winning clear this week (0 = no winner yet)
  topKills: number;
  replaysStored: number;
  replayBytes: number; // total uncompressed replay bytes recorded this week
};

export function getWeeklyChallengeStats(now: number = Date.now()): WeeklyChallengeStats {
  const wk = challengeWeekKey(now);
  const s = wcStatsStmt.get(wk) as {
    participants: number; runs: number; winners: number; best_time_ms: number | null; top_kills: number;
  };
  const r = wrStatsStmt.get(wk) as { n: number; bytes: number };
  return {
    week: wk,
    participants: s.participants,
    runs: s.runs,
    winners: s.winners,
    bestTimeMs: s.best_time_ms ?? 0,
    topKills: s.top_kills,
    replaysStored: r.n,
    replayBytes: r.bytes,
  };
}

type WcRow = {
  player_id: string;
  week_key: string;
  user_name: string;
  best_kills: number;
  best_time_ms: number;
  runs: number;
  updated_at: number;
};

export type WeeklyChallengeEntry = {
  id: string;
  userName: string;
  kills: number;
  timeMs: number; // best winning time, 0 = never beat the bots
  won: boolean;
  runs: number;
  admin: boolean;
  verified: boolean;
  hasReplay: boolean; // a rewatchable run is stored for this player this week
};
export type WeeklyChallengeMe = WeeklyChallengeEntry & { rank: number };

// Record a challenge run, keeping the player's BEST for the week: the fastest
// WINNING time (the speedrun), plus most kills (the fallback for runs that never
// beat the bots). Account-only. Also reports whether THIS run is now the player's
// board-defining run — if so the caller should store its replay (so the stored
// replay always matches the row shown on the leaderboard).
export function recordWeeklyChallenge(
  playerId: string,
  userName: string,
  kills: number,
  won: boolean,
  timeMs: number,
  now: number = Date.now(),
): { me: WeeklyChallengeMe; acceptReplay: boolean } | null {
  if (!playerId) return null;
  const wk = challengeWeekKey(now);
  wcEnsureStmt.run({ playerId, weekKey: wk, userName, now });
  const cur = wcRowStmt.get(playerId, wk) as WcRow;
  const isWin = won && timeMs > 0;
  const bestKills = Math.max(cur.best_kills, kills);
  const bestTimeMs = isWin
    ? cur.best_time_ms > 0
      ? Math.min(cur.best_time_ms, timeMs)
      : timeMs
    : cur.best_time_ms;
  wcUpdateStmt.run({ playerId, weekKey: wk, userName, bestKills, bestTimeMs, now });
  const rank =
    num(wcRankStmt.get({ weekKey: wk, kills: bestKills, timeMs: bestTimeMs })) + 1;
  // The board shows a player's fastest win if they've ever won, else their
  // most-kills loss. This run becomes the defining run when it's a new best win,
  // or — for a player who has never won — a new best-kills loss.
  const neverWonBefore = cur.best_time_ms === 0;
  const isNewBestWin = isWin && (cur.best_time_ms === 0 || timeMs < cur.best_time_ms);
  const isNewBestKillsLoss = !isWin && neverWonBefore && kills > cur.best_kills;
  const acceptReplay = isNewBestWin || isNewBestKillsLoss;
  return {
    me: {
      id: playerId,
      userName,
      kills: bestKills,
      timeMs: bestTimeMs,
      won: bestTimeMs > 0,
      runs: cur.runs + 1,
      rank,
      admin: false,
      verified: false,
      hasReplay: false,
    },
    acceptReplay,
  };
}

function toWcEntry(r: WcRow): WeeklyChallengeEntry {
  return {
    id: r.player_id,
    userName: r.user_name,
    kills: r.best_kills,
    timeMs: r.best_time_ms,
    won: r.best_time_ms > 0,
    runs: r.runs,
    admin: false,
    verified: false,
    hasReplay: false,
  };
}

export function getWeeklyChallengeLeaderboard(
  limit: number,
  now: number = Date.now(),
): WeeklyChallengeEntry[] {
  const n = Math.max(1, Math.min(100, Math.floor(limit)));
  const wk = challengeWeekKey(now);
  const rows = wcLeaderboardStmt.all(wk, n) as WcRow[];
  const base = rows.map(toWcEntry);
  if (base.length) {
    const ph = base.map(() => '?').join(',');
    const flags = sqlite
      .prepare(`SELECT id, is_admin, is_verified FROM elyxion_users WHERE id IN (${ph})`)
      .all(...base.map((e) => e.id)) as { id: string; is_admin: number; is_verified: number }[];
    const byId = new Map(flags.map((f) => [f.id, f]));
    const withReplay = weeklyReplayPlayerIds(wk);
    for (const e of base) {
      const f = byId.get(e.id);
      if (f) {
        e.admin = !!f.is_admin;
        e.verified = !!f.is_verified;
      }
      e.hasReplay = withReplay.has(e.id);
    }
  }
  return base;
}

export function getWeeklyChallengeMe(
  playerId: string,
  now: number = Date.now(),
): WeeklyChallengeMe | null {
  if (!playerId) return null;
  const wk = challengeWeekKey(now);
  const r = wcRowStmt.get(playerId, wk) as WcRow | undefined;
  if (!r) return null;
  const rank =
    num(wcRankStmt.get({ weekKey: wk, kills: r.best_kills, timeMs: r.best_time_ms })) + 1;
  const entry = toWcEntry(r);
  entry.hasReplay = weeklyReplayPlayerIds(wk).has(playerId);
  return { ...entry, rank };
}

// ── Server announcements ─────────────────────────────────────────────────────
// Site-wide notices admins post from the dashboard. Served publicly to the
// landing page (menu) until manually deleted or (optionally) expired; rows are
// soft-deleted so removed announcements stay in the audit trail.
sqlite.exec(`
CREATE TABLE IF NOT EXISTS elyxion_announcements (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  text       TEXT NOT NULL,
  author     TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL DEFAULT 0, -- epoch ms; 0 = never expires
  deleted    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_announcements_active ON elyxion_announcements(expires_at, deleted);
`);

export const ANNOUNCEMENT_MAX_LEN = 500; // caps the landing-page strip size

type AnnouncementRow = {
  id: number;
  text: string;
  author: string;
  created_at: number;
  expires_at: number;
  deleted: number;
};

const annInsertStmt = sqlite.prepare(
  `INSERT INTO elyxion_announcements (text, author, created_at, expires_at) VALUES (@text, @author, @createdAt, @expiresAt)`,
);
const annListStmt = sqlite.prepare(
  `SELECT id, text, author, created_at, expires_at, deleted FROM elyxion_announcements
   WHERE deleted = 0 ORDER BY created_at DESC LIMIT ?`,
);
const annActiveStmt = sqlite.prepare(
  `SELECT id, text, author, created_at, expires_at, deleted FROM elyxion_announcements
   WHERE deleted = 0 AND (expires_at = 0 OR expires_at > ?) ORDER BY created_at DESC LIMIT 20`,
);
const annDeleteStmt = sqlite.prepare(
  `UPDATE elyxion_announcements SET deleted = 1 WHERE id = ? AND deleted = 0`,
);

export type Announcement = {
  id: number;
  text: string;
  author: string;
  createdAt: number;
  expiresAt: number; // epoch ms; 0 = never expires
};

const toAnnouncement = (r: AnnouncementRow): Announcement => ({
  id: r.id,
  text: r.text,
  author: r.author,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
});

// Post a new announcement. Returns its id, or null on an empty/oversized body
// (the caller surfaces a 4xx) or a write failure.
export function createAnnouncement(a: {
  text: string;
  author: string;
  now: number;
  expiresAt: number; // epoch ms; 0 = never
}): number | null {
  const text = a.text.trim();
  if (!text || text.length > ANNOUNCEMENT_MAX_LEN) return null;
  try {
    const r = annInsertStmt.run({
      text: text.slice(0, ANNOUNCEMENT_MAX_LEN),
      author: (a.author || 'admin').slice(0, 64),
      createdAt: a.now,
      expiresAt: Math.max(0, Math.floor(a.expiresAt)),
    });
    return Number(r.lastInsertRowid) || null;
  } catch {
    return null;
  }
}

// All non-deleted announcements, newest first (admin management list — includes
// expired ones so staff can see what lapsed).
export function listAnnouncements(limit: number = 50): Announcement[] {
  try {
    return (annListStmt.all(limit) as AnnouncementRow[]).map(toAnnouncement);
  } catch {
    return [];
  }
}

// Announcements currently shown to players (non-deleted, not yet expired),
// newest first — the public landing-page feed.
export function listActiveAnnouncements(now: number = Date.now()): Announcement[] {
  try {
    return (annActiveStmt.all(now) as AnnouncementRow[]).map(toAnnouncement);
  } catch {
    return [];
  }
}

// Soft-delete an announcement (hidden from the landing page immediately; the
// row is kept for the audit trail). False when the id is missing/gone.
export function deleteAnnouncement(id: number): boolean {
  try {
    return annDeleteStmt.run(id).changes > 0;
  } catch {
    return false;
  }
}
