// PostgreSQL-backed store (migrated from better-sqlite3). Self-contained: no
// ORM, just `pg` with fully parameterized queries. The schema is created on
// first import (CREATE TABLE IF NOT EXISTS), so there are no migrations to run.
//
// Concurrency notes (the old sync SQLite API relied on single-threadedness for
// its atomic read-compute-write guarantees; a networked Postgres does not):
//   • Progressions that read-compute-write (recordMatch, claimChallenge, ranked
//     Elo, weekly-challenge bests, shop spends) run inside a per-key async
//     mutex (see withLock) — same player ⇒ serialized; different players run
//     concurrently. This preserves the old "can't interleave" guarantee.
//   • Session tokens live in a write-through in-memory cache seeded at boot, so
//     cookie auth (accountId() and friends) stays synchronous. Postgres remains
//     authoritative for new/revoked sessions.
//   • logEvent no longer blocks request paths: it fires the insert and never
//     throws into the caller.
import zlib from 'node:zlib';
import { Pool } from 'pg';
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

// ── Connection ───────────────────────────────────────────────────────────────
// DATABASE_URL is required (a hosted Postgres such as Supabase, or local
// Postgres). Loaded from .env / .env.local (server/env.ts) or the platform env.
const databaseUrl = process.env.DATABASE_URL?.trim();

export const pool = databaseUrl
  ? new Pool({
      connectionString: databaseUrl,
      ssl: /supabase\.(co|com)/i.test(databaseUrl) ? { rejectUnauthorized: false } : undefined,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    })
  : null;

if (!pool) {
  console.error(
    '[db] DATABASE_URL is not set — set it to your PostgreSQL connection string ' +
      '(.env / .env.local locally, platform env when hosted).',
  );
}

// Tiny helpers over pool.query. All SQL is a template literal with $n params —
// user input never reaches SQL text.
async function many<T extends Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  if (!pool) throw new Error('DATABASE_URL is not configured');
  const res = await pool.query<T>(text, params);
  return res.rows;
}
async function one<T extends Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T | undefined> {
  const rows = await many<T>(text, params);
  return rows[0];
}
// UPDATE/DELETE rowCount (>0 = a row changed).
async function exec(text: string, params: unknown[] = []): Promise<number> {
  if (!pool) throw new Error('DATABASE_URL is not configured');
  const res = await pool.query(text, params);
  return res.rowCount ?? 0;
}
// INSERT ... RETURNING id (BIGSERIAL → string in pg) as a JS number.
async function insertId(text: string, params: unknown[] = []): Promise<number> {
  const row = await one<{ id: string | number }>(text, params);
  return row ? Number(row.id) || 0 : 0;
}
// COUNT(*)/SUM() come back as bigint/numeric → strings; normalize once here.
const nOf = (v: unknown): number => Number(v ?? 0);

// `$1, $2, …` placeholder list for IN (...) clauses.
function ph(n: number, start = 1): string {
  return Array.from({ length: n }, (_, i) => `$${start + i}`).join(',');
}

// Upsert builder: INSERT (cols) VALUES ($1..$n) ON CONFLICT (conflict) DO UPDATE
// SET non-key cols = EXCLUDED.col. Used by the ban tables (last write wins).
function upsertSql(table: string, conflict: string[], cols: string[]): string {
  const sets = cols
    .filter((c) => !conflict.includes(c))
    .map((c) => `${c} = EXCLUDED.${c}`)
    .join(', ');
  return `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${ph(cols.length)})
    ON CONFLICT (${conflict.join(', ')}) DO UPDATE SET ${sets}`;
}

// Per-key async mutex. Preserves the old sync store's "read-compute-write can't
// interleave" behavior for one player without serializing unrelated players.
const locks = new Map<string, Promise<unknown>>();
function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const tail = (locks.get(key) ?? Promise.resolve())
    .catch(() => undefined)
    .then(fn);
  locks.set(
    key,
    tail.catch(() => undefined),
  );
  return tail;
}

// ── Schema ───────────────────────────────────────────────────────────────────
let schemaPromise: Promise<void> | null = null;

function ensureSchema(): Promise<void> {
  if (!pool) return Promise.reject(new Error('DATABASE_URL is not configured'));
  schemaPromise ??= (async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS elyxion_stats (
        player_id        TEXT PRIMARY KEY,
        user_name        TEXT NOT NULL DEFAULT 'Player',
        total_kills      INTEGER NOT NULL DEFAULT 0,
        total_deaths     INTEGER NOT NULL DEFAULT 0,
        total_games      INTEGER NOT NULL DEFAULT 0,
        total_wins       INTEGER NOT NULL DEFAULT 0,
        best_kill_streak INTEGER NOT NULL DEFAULT 0,
        headshots        INTEGER NOT NULL DEFAULT 0,
        shots_fired      INTEGER NOT NULL DEFAULT 0,
        shots_hit        INTEGER NOT NULL DEFAULT 0,
        best_accuracy    DOUBLE PRECISION NOT NULL DEFAULT 0,
        created_at       BIGINT NOT NULL,
        updated_at       BIGINT NOT NULL,
        total_xp         INTEGER NOT NULL DEFAULT 0,
        level            INTEGER NOT NULL DEFAULT 1,
        credits          INTEGER NOT NULL DEFAULT 0,
        unlocked         TEXT NOT NULL DEFAULT '[]',
        equipped         TEXT NOT NULL DEFAULT '{}',
        first_win_day    INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_elyxion_stats_kills ON elyxion_stats(total_kills);
    `);
    await pool.query(`
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
        best_accuracy    DOUBLE PRECISION NOT NULL DEFAULT 0,
        updated_at       BIGINT NOT NULL,
        PRIMARY KEY (player_id, period_key)
      );
      CREATE INDEX IF NOT EXISTS idx_period_kills ON elyxion_period_stats(period_key, total_kills);
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS elyxion_users (
        id             TEXT PRIMARY KEY,
        username       TEXT NOT NULL,
        username_lower TEXT NOT NULL UNIQUE,
        pw_hash        TEXT NOT NULL,
        pw_salt        TEXT NOT NULL,
        email          TEXT,
        created_at     BIGINT NOT NULL,
        is_admin       BOOLEAN NOT NULL DEFAULT FALSE,
        is_verified    BOOLEAN NOT NULL DEFAULT FALSE
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS elyxion_sessions (
        token      TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL,
        created_at BIGINT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_user ON elyxion_sessions(user_id);
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS elyxion_bans (
        name_lower   TEXT PRIMARY KEY,
        name         TEXT NOT NULL,
        reason       TEXT NOT NULL DEFAULT '',
        banned_by    TEXT NOT NULL DEFAULT '',
        created_at   BIGINT NOT NULL,
        banned_until BIGINT NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS elyxion_ip_bans (
        ip           TEXT PRIMARY KEY,
        reason       TEXT NOT NULL DEFAULT '',
        banned_by    TEXT NOT NULL DEFAULT '',
        banned_name  TEXT NOT NULL DEFAULT '',
        created_at   BIGINT NOT NULL,
        banned_until BIGINT NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS elyxion_guest_bans (
        guest_id      TEXT PRIMARY KEY,
        reason        TEXT NOT NULL DEFAULT '',
        banned_by     TEXT NOT NULL DEFAULT '',
        captured_name TEXT NOT NULL DEFAULT '',
        created_at    BIGINT NOT NULL,
        banned_until  BIGINT NOT NULL DEFAULT 0
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS elyxion_violations (
        id            SERIAL PRIMARY KEY,
        created_at    BIGINT NOT NULL,
        updated_at    BIGINT NOT NULL,
        player_id     TEXT NOT NULL,
        player_name   TEXT NOT NULL DEFAULT '',
        severity      TEXT NOT NULL DEFAULT 'warning',
        reason        TEXT NOT NULL DEFAULT '',
        issued_by     TEXT NOT NULL DEFAULT '',
        status        TEXT NOT NULL DEFAULT 'active',
        expires_at    BIGINT NOT NULL DEFAULT 0,
        appeal_status TEXT NOT NULL DEFAULT 'none',
        appeal_text   TEXT NOT NULL DEFAULT '',
        appealed_at   BIGINT NOT NULL DEFAULT 0,
        reviewed_by   TEXT NOT NULL DEFAULT '',
        reviewed_at   BIGINT NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_violations_player ON elyxion_violations(player_id, id);
      CREATE INDEX IF NOT EXISTS idx_violations_status ON elyxion_violations(status, id);
      CREATE INDEX IF NOT EXISTS idx_violations_appeal ON elyxion_violations(appeal_status, id);
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS elyxion_audit (
        id         SERIAL PRIMARY KEY,
        ts         BIGINT NOT NULL,
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
    await pool.query(`
      CREATE TABLE IF NOT EXISTS elyxion_feedback (
        id          SERIAL PRIMARY KEY,
        ts          BIGINT NOT NULL,
        player_id   TEXT NOT NULL DEFAULT '',
        player_name TEXT NOT NULL DEFAULT '',
        type        TEXT NOT NULL DEFAULT 'general',
        title       TEXT NOT NULL DEFAULT '',
        body        TEXT NOT NULL DEFAULT '',
        status      TEXT NOT NULL DEFAULT 'open',
        ip          TEXT NOT NULL DEFAULT '',
        user_agent  TEXT NOT NULL DEFAULT '',
        updated_at  BIGINT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_feedback_ts ON elyxion_feedback(ts);
      CREATE INDEX IF NOT EXISTS idx_feedback_status ON elyxion_feedback(status, id);
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS elyxion_tickets (
        id          SERIAL PRIMARY KEY,
        ts          BIGINT NOT NULL,
        player_id   TEXT NOT NULL DEFAULT '',
        player_name TEXT NOT NULL DEFAULT '',
        category    TEXT NOT NULL DEFAULT 'help',
        subject     TEXT NOT NULL DEFAULT '',
        body        TEXT NOT NULL DEFAULT '',
        status      TEXT NOT NULL DEFAULT 'open',
        ip          TEXT NOT NULL DEFAULT '',
        user_agent  TEXT NOT NULL DEFAULT '',
        updated_at  BIGINT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tickets_ts ON elyxion_tickets(ts);
      CREATE INDEX IF NOT EXISTS idx_tickets_status ON elyxion_tickets(status, id);
      CREATE INDEX IF NOT EXISTS idx_tickets_player ON elyxion_tickets(player_id, id);
      CREATE TABLE IF NOT EXISTS elyxion_ticket_replies (
        id        SERIAL PRIMARY KEY,
        ticket_id INTEGER NOT NULL,
        ts        BIGINT NOT NULL,
        author    TEXT NOT NULL DEFAULT '',
        body      TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS idx_ticket_replies_ticket ON elyxion_ticket_replies(ticket_id, id);
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS elyxion_community_messages (
        id          SERIAL PRIMARY KEY,
        channel     TEXT NOT NULL,
        ts          BIGINT NOT NULL,
        player_id   TEXT NOT NULL DEFAULT '',
        player_name TEXT NOT NULL DEFAULT '',
        text        TEXT NOT NULL DEFAULT '',
        deleted     BOOLEAN NOT NULL DEFAULT FALSE,
        admin       BOOLEAN NOT NULL DEFAULT FALSE,
        verified    BOOLEAN NOT NULL DEFAULT FALSE,
        ip          TEXT NOT NULL DEFAULT '',
        user_agent  TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS idx_community_channel_id ON elyxion_community_messages(channel, id);
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS elyxion_challenges (
        player_id  TEXT NOT NULL,
        challenge  TEXT NOT NULL,
        period     TEXT NOT NULL,
        progress   INTEGER NOT NULL DEFAULT 0,
        goal       INTEGER NOT NULL,
        claimed    BOOLEAN NOT NULL DEFAULT FALSE,
        PRIMARY KEY (player_id, challenge, period)
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS elyxion_ranked (
        player_id  TEXT PRIMARY KEY,
        user_name  TEXT NOT NULL,
        rating     INTEGER NOT NULL DEFAULT 1000,
        peak       INTEGER NOT NULL DEFAULT 1000,
        games      INTEGER NOT NULL DEFAULT 0,
        wins       INTEGER NOT NULL DEFAULT 0,
        losses     INTEGER NOT NULL DEFAULT 0,
        streak     INTEGER NOT NULL DEFAULT 0,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ranked_rating ON elyxion_ranked(rating);
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS elyxion_weekly_challenge (
        player_id    TEXT NOT NULL,
        week_key     TEXT NOT NULL,
        user_name    TEXT NOT NULL,
        best_kills   INTEGER NOT NULL DEFAULT 0,
        best_time_ms INTEGER NOT NULL DEFAULT 0,
        runs         INTEGER NOT NULL DEFAULT 0,
        updated_at   BIGINT NOT NULL,
        PRIMARY KEY (player_id, week_key)
      );
      CREATE INDEX IF NOT EXISTS idx_weekly_challenge ON elyxion_weekly_challenge(week_key, best_kills);
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS elyxion_weekly_replay (
        player_id   TEXT NOT NULL,
        week_key    TEXT NOT NULL,
        data        BYTEA NOT NULL,
        raw_bytes   INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        kills       INTEGER NOT NULL,
        won         BOOLEAN NOT NULL DEFAULT FALSE,
        created_at  BIGINT NOT NULL,
        PRIMARY KEY (player_id, week_key)
      );
      CREATE INDEX IF NOT EXISTS idx_weekly_replay_week ON elyxion_weekly_replay(week_key);
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS elyxion_temp_replays (
        code        TEXT PRIMARY KEY,
        data        BYTEA NOT NULL,
        raw_bytes   INTEGER NOT NULL,
        map_id      TEXT NOT NULL DEFAULT '',
        won         BOOLEAN NOT NULL DEFAULT FALSE,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        runner      TEXT NOT NULL DEFAULT '',
        stats_json  TEXT NOT NULL DEFAULT '{}',
        created_at  BIGINT NOT NULL,
        expires_at  BIGINT NOT NULL,
        user_id     TEXT NOT NULL DEFAULT '',
        mode        TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS idx_temp_replays_expires ON elyxion_temp_replays(expires_at);
      CREATE INDEX IF NOT EXISTS idx_temp_replays_user ON elyxion_temp_replays(user_id, created_at);
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS elyxion_player_reports (
        id            SERIAL PRIMARY KEY,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        reporter_id   TEXT NOT NULL DEFAULT '',
        reporter_name TEXT NOT NULL DEFAULT 'Guest',
        target_id     TEXT NOT NULL,
        target_name   TEXT NOT NULL,
        reason        TEXT NOT NULL,
        details       TEXT NOT NULL DEFAULT '',
        ip            TEXT NOT NULL DEFAULT '',
        user_agent    TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS idx_elyxion_player_reports_created
        ON elyxion_player_reports (created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_elyxion_player_reports_target
        ON elyxion_player_reports (target_id, created_at DESC);
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS elyxion_announcements (
        id         SERIAL PRIMARY KEY,
        text       TEXT NOT NULL,
        author     TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        expires_at BIGINT NOT NULL DEFAULT 0,
        deleted    BOOLEAN NOT NULL DEFAULT FALSE
      );
      CREATE INDEX IF NOT EXISTS idx_announcements_active ON elyxion_announcements(expires_at, deleted);
    `);
  })();
  return schemaPromise;
}

// Await before the first DB touch: resolves once the schema is ensured and the
// session cache is seeded. Routers may gate handlers with this.
let readyPromise: Promise<void> | null = null;

export function dbReady(): Promise<void> {
  if (!pool) return Promise.reject(new Error('DATABASE_URL is not configured'));
  readyPromise ??= (async () => {
    await ensureSchema();
    await pool.query('SELECT 1');
    await seedSessions();
  })();
  return readyPromise;
}

// ── Session cache (sync cookie auth over async Postgres) ─────────────────────
// token → userId, seeded at boot and kept write-through. Postgres stays the
// durable store; the cache only makes accountId() lookups synchronous again.
const sessionCache = new Map<string, string>();

async function seedSessions(): Promise<void> {
  try {
    const rows = await many<{ token: string; user_id: string }>(
      `SELECT token, user_id FROM elyxion_sessions`,
    );
    for (const r of rows) sessionCache.set(r.token, r.user_id);
    console.log(`[db] sessions cached: ${sessionCache.size}`);
  } catch (err) {
    console.error('[db] session seed failed', err);
  }
}

// ── Audit log ────────────────────────────────────────────────────────────────
export type AuditInput = {
  event: string;
  actorId?: string;
  actorName?: string;
  targetId?: string;
  detail?: unknown;
  ip?: string;
  now?: number;
};

// Record an audit event. Fire-and-forget: never blocks or throws into the
// request path — a logging failure must not break a match submission or login.
export function logEvent(e: AuditInput): void {
  const detail =
    e.detail == null
      ? ''
      : typeof e.detail === 'string'
        ? e.detail.slice(0, 2000)
        : JSON.stringify(e.detail).slice(0, 2000);
  void many(
    `INSERT INTO elyxion_audit (ts, event, actor_id, actor_name, target_id, detail, ip)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [e.now ?? Date.now(), e.event, e.actorId ?? '', e.actorName ?? '', e.targetId ?? '', detail, (e.ip ?? '').slice(0, 64)],
  ).catch((err) => console.error('[audit] log failed', err));
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

function mapAuditRow(r: Record<string, unknown>): AuditRow {
  return {
    id: nOf(r.id),
    ts: nOf(r.ts),
    event: String(r.event ?? ''),
    actor_id: String(r.actor_id ?? ''),
    actor_name: String(r.actor_name ?? ''),
    target_id: String(r.target_id ?? ''),
    detail: String(r.detail ?? ''),
    ip: String(r.ip ?? ''),
  };
}

export async function getAuditLog(limit: number, event?: string): Promise<AuditRow[]> {
  const n = Math.max(1, Math.min(500, Math.floor(limit)));
  const rows = event
    ? await many<Record<string, unknown>>(
        `SELECT * FROM elyxion_audit WHERE event = $1 ORDER BY ts DESC, id DESC LIMIT $2`,
        [event, n],
      )
    : await many<Record<string, unknown>>(
        `SELECT * FROM elyxion_audit ORDER BY ts DESC, id DESC LIMIT $1`,
        [n],
      );
  return rows.map(mapAuditRow);
}

// ── Feedback / bug reports ───────────────────────────────────────────────────
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

function mapFeedbackRow(r: Record<string, unknown>): FeedbackRow {
  return {
    id: nOf(r.id),
    ts: nOf(r.ts),
    playerId: String(r.player_id ?? ''),
    playerName: String(r.player_name ?? '') || 'Guest',
    type: String(r.type ?? 'general') as FeedbackType,
    title: String(r.title ?? ''),
    body: String(r.body ?? ''),
    status: String(r.status ?? 'open') as FeedbackStatus,
    ip: String(r.ip ?? ''),
    userAgent: String(r.user_agent ?? ''),
    updatedAt: nOf(r.updated_at),
  };
}

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

// Global table-growth backstop (bounds a scripted flood; oldest falls off first).
const FEEDBACK_MAX_ROWS = 20_000;

// Store a player feedback/bug report. Returns the new row id (0 on failure —
// never throws into the request path).
export async function submitFeedback(f: FeedbackInput): Promise<number> {
  try {
    await dbReady();
    const now = f.now ?? Date.now();
    const id = await insertId(
      `INSERT INTO elyxion_feedback (ts, player_id, player_name, type, title, body, status, ip, user_agent, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'open', $7, $8, $1)
       RETURNING id`,
      [
        now,
        (f.playerId ?? '').slice(0, 64),
        (f.playerName ?? '').slice(0, 32) || 'Guest',
        f.type,
        f.title.slice(0, 200),
        f.body.slice(0, 5000),
        (f.ip ?? '').slice(0, 64),
        (f.userAgent ?? '').slice(0, 256),
      ],
    );
    // Trim oldest rows past the cap (keep newest FEEDBACK_MAX_ROWS).
    await exec(
      `DELETE FROM elyxion_feedback
        WHERE id < (SELECT COALESCE(MIN(id), 0) FROM
          (SELECT id FROM elyxion_feedback ORDER BY id DESC OFFSET $1) t)`,
      [FEEDBACK_MAX_ROWS],
    ).catch(() => undefined);
    return id;
  } catch (err) {
    console.error('[feedback] submit failed', err);
    return 0;
  }
}

// Recent feedback, newest first, keyset-paginated by id. Optional status / type
// filters ('all'/'' = unfiltered).
export async function listFeedback(opts: {
  limit?: number;
  beforeId?: number;
  status?: string;
  type?: string;
}): Promise<FeedbackRow[]> {
  const n = Math.max(1, Math.min(200, Math.floor(opts.limit ?? 50)));
  const before = opts.beforeId && opts.beforeId > 0 ? opts.beforeId : 0;
  const status = opts.status && opts.status !== 'all' ? opts.status : '';
  const type = opts.type && opts.type !== 'all' ? opts.type : '';
  const where: string[] = [];
  const params: unknown[] = [];
  if (status) {
    params.push(status);
    where.push(`status = $${params.length}`);
  }
  if (type) {
    params.push(type);
    where.push(`type = $${params.length}`);
  }
  if (before) {
    params.push(before);
    where.push(`id < $${params.length}`);
  }
  params.push(n);
  const rows = await many<Record<string, unknown>>(
    `SELECT * FROM elyxion_feedback${where.length ? ` WHERE ${where.join(' AND ')}` : ''}
      ORDER BY id DESC LIMIT $${params.length}`,
    params,
  );
  return rows.map(mapFeedbackRow);
}

// Update a feedback row's moderation status. Returns true if a row changed.
export async function setFeedbackStatus(id: number, status: FeedbackStatus, now?: number): Promise<boolean> {
  return (
    (await exec(`UPDATE elyxion_feedback SET status = $1, updated_at = $2 WHERE id = $3`, [
      status,
      now ?? Date.now(),
      id,
    ])) > 0
  );
}

export async function feedbackCounts(): Promise<Record<string, number>> {
  const rows = await many<{ status: string; n: string }>(
    `SELECT status, COUNT(*) AS n FROM elyxion_feedback GROUP BY status`,
  );
  const out: Record<string, number> = {};
  for (const r of rows) out[r.status] = nOf(r.n);
  return out;
}

export async function feedbackTypeCounts(): Promise<Record<string, number>> {
  const rows = await many<{ type: string; n: string }>(
    `SELECT type, COUNT(*) AS n FROM elyxion_feedback GROUP BY type`,
  );
  const out: Record<string, number> = {};
  for (const r of rows) out[r.type] = nOf(r.n);
  return out;
}

// ── Support tickets ──────────────────────────────────────────────────────────
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

function mapTicketRow(r: Record<string, unknown>): TicketRow {
  return {
    id: nOf(r.id),
    ts: nOf(r.ts),
    playerId: String(r.player_id ?? ''),
    playerName: String(r.player_name ?? '') || 'Guest',
    category: String(r.category ?? 'help') as TicketCategory,
    subject: String(r.subject ?? ''),
    body: String(r.body ?? ''),
    status: String(r.status ?? 'open') as TicketStatus,
    ip: String(r.ip ?? ''),
    userAgent: String(r.user_agent ?? ''),
    updatedAt: nOf(r.updated_at),
    replyCount: nOf(r.reply_count),
  };
}

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

const TICKETS_MAX_ROWS = 50_000;

// Store a support ticket. Returns the new row id (0 on failure — never throws
// into the request path).
export async function submitTicket(t: TicketInput): Promise<number> {
  try {
    await dbReady();
    const now = t.now ?? Date.now();
    const id = await insertId(
      `INSERT INTO elyxion_tickets (ts, player_id, player_name, category, subject, body, status, ip, user_agent, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'open', $7, $8, $1)
       RETURNING id`,
      [
        now,
        (t.playerId ?? '').slice(0, 64),
        (t.playerName ?? '').slice(0, 32) || 'Guest',
        t.category,
        t.subject.slice(0, 200),
        t.body.slice(0, 6000),
        (t.ip ?? '').slice(0, 64),
        (t.userAgent ?? '').slice(0, 256),
      ],
    );
    await exec(
      `DELETE FROM elyxion_tickets
        WHERE id < (SELECT COALESCE(MIN(id), 0) FROM
          (SELECT id FROM elyxion_tickets ORDER BY id DESC OFFSET $1) s)`,
      [TICKETS_MAX_ROWS],
    ).catch(() => undefined);
    return id;
  } catch (err) {
    console.error('[support] submit failed', err);
    return 0;
  }
}

// Recent tickets, newest first, keyset-paginated by id. `playerId` narrows to
// one account's own tickets (the /support "your tickets" list); omit for admin.
export async function listTickets(opts: {
  limit?: number;
  beforeId?: number;
  status?: string;
  playerId?: string;
}): Promise<TicketRow[]> {
  const n = Math.max(1, Math.min(200, Math.floor(opts.limit ?? 50)));
  const before = opts.beforeId && opts.beforeId > 0 ? opts.beforeId : 0;
  const status = opts.status && opts.status !== 'all' ? opts.status : '';
  const where: string[] = [];
  const params: unknown[] = [];
  if (status) {
    params.push(status);
    where.push(`t.status = $${params.length}`);
  }
  if (opts.playerId) {
    params.push(opts.playerId);
    where.push(`t.player_id = $${params.length}`);
  }
  if (before) {
    params.push(before);
    where.push(`t.id < $${params.length}`);
  }
  params.push(n);
  const rows = await many<Record<string, unknown>>(
    `SELECT t.*, (SELECT COUNT(*) FROM elyxion_ticket_replies r WHERE r.ticket_id = t.id) AS reply_count
       FROM elyxion_tickets t${where.length ? ` WHERE ${where.join(' AND ')}` : ''}
      ORDER BY t.id DESC LIMIT $${params.length}`,
    params,
  );
  return rows.map(mapTicketRow);
}

export async function getTicket(id: number): Promise<TicketRow | null> {
  const row = await one<Record<string, unknown>>(
    `SELECT t.*, (SELECT COUNT(*) FROM elyxion_ticket_replies r WHERE r.ticket_id = t.id) AS reply_count
       FROM elyxion_tickets t WHERE t.id = $1`,
    [id],
  );
  return row ? mapTicketRow(row) : null;
}

// Update a ticket's status. Returns true if a row changed.
export async function setTicketStatus(id: number, status: TicketStatus, now?: number): Promise<boolean> {
  return (
    (await exec(`UPDATE elyxion_tickets SET status = $1, updated_at = $2 WHERE id = $3`, [
      status,
      now ?? Date.now(),
      id,
    ])) > 0
  );
}

// Append an admin reply to a ticket (bumps updated_at so the thread sorts by
// latest activity). If the ticket is still 'open' a reply implicitly acks it.
// Returns the new reply id (0 on failure / missing ticket).
export async function addTicketReply(ticketId: number, author: string, body: string, now?: number): Promise<number> {
  try {
    await dbReady();
    const t = now ?? Date.now();
    const ticket = await getTicket(ticketId);
    if (!ticket) return 0;
    const replyId = await insertId(
      `INSERT INTO elyxion_ticket_replies (ticket_id, ts, author, body)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [ticketId, t, (author || 'Admin').slice(0, 32), body.slice(0, 4000)],
    );
    const nextStatus = ticket.status === 'open' ? 'ack' : ticket.status;
    await setTicketStatus(ticketId, nextStatus, t);
    return replyId;
  } catch (err) {
    console.error('[support] reply failed', err);
    return 0;
  }
}

// The ticket AUTHOR replying (the /support page). Unlike an admin reply this
// must NOT auto-ack (the ticket still needs the admin). A reply to a
// resolved/closed ticket reopens it as 'open'. Returns the new reply id.
export async function addPlayerTicketReply(
  ticketId: number,
  author: string,
  body: string,
  now?: number,
): Promise<number> {
  try {
    await dbReady();
    const t = now ?? Date.now();
    const ticket = await getTicket(ticketId);
    if (!ticket) return 0;
    const replyId = await insertId(
      `INSERT INTO elyxion_ticket_replies (ticket_id, ts, author, body)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [ticketId, t, (author || 'Guest').slice(0, 32), body.slice(0, 4000)],
    );
    const nextStatus =
      ticket.status === 'resolved' || ticket.status === 'closed' ? 'open' : ticket.status;
    await setTicketStatus(ticketId, nextStatus, t);
    return replyId;
  } catch (err) {
    console.error('[support] player reply failed', err);
    return 0;
  }
}

export async function listReplies(ticketId: number): Promise<TicketReplyRow[]> {
  const rows = await many<Record<string, unknown>>(
    `SELECT * FROM elyxion_ticket_replies WHERE ticket_id = $1 ORDER BY id ASC LIMIT 200`,
    [ticketId],
  );
  return rows.map((r) => ({
    id: nOf(r.id),
    ticketId: nOf(r.ticket_id),
    ts: nOf(r.ts),
    author: String(r.author ?? '') || 'Admin',
    body: String(r.body ?? ''),
  }));
}

export async function ticketCounts(): Promise<Record<string, number>> {
  const rows = await many<{ status: string; n: string }>(
    `SELECT status, COUNT(*) AS n FROM elyxion_tickets GROUP BY status`,
  );
  const out: Record<string, number> = {};
  for (const r of rows) out[r.status] = nOf(r.n);
  return out;
}

// ── Violations / warnings ─────────────────────────────────────────────────────
export type ViolationSeverity = 'warning' | 'strike';
export type ViolationStatus = 'active' | 'dismissed';
export type ViolationAppealStatus = 'none' | 'pending' | 'approved' | 'denied';

export type ViolationRow = {
  id: number;
  createdAt: number;
  updatedAt: number;
  playerId: string;
  playerName: string;
  severity: ViolationSeverity;
  reason: string;
  issuedBy: string;
  status: ViolationStatus;
  expiresAt: number;
  appealStatus: ViolationAppealStatus;
  appealText: string;
  appealedAt: number;
  reviewedBy: string;
  reviewedAt: number;
};

function mapViolationRow(r: Record<string, unknown>): ViolationRow {
  return {
    id: nOf(r.id),
    createdAt: nOf(r.created_at),
    updatedAt: nOf(r.updated_at),
    playerId: String(r.player_id ?? ''),
    playerName: String(r.player_name ?? '') || 'Guest',
    severity: String(r.severity ?? 'warning') as ViolationSeverity,
    reason: String(r.reason ?? ''),
    issuedBy: String(r.issued_by ?? ''),
    status: String(r.status ?? 'active') as ViolationStatus,
    expiresAt: nOf(r.expires_at),
    appealStatus: String(r.appeal_status ?? 'none') as ViolationAppealStatus,
    appealText: String(r.appeal_text ?? ''),
    appealedAt: nOf(r.appealed_at),
    reviewedBy: String(r.reviewed_by ?? ''),
    reviewedAt: nOf(r.reviewed_at),
  };
}

export async function issueViolation(v: {
  playerId: string;
  playerName: string;
  severity: ViolationSeverity;
  reason: string;
  issuedBy: string;
  expiresAt?: number;
  now?: number;
}): Promise<number> {
  try {
    await dbReady();
    const now = v.now ?? Date.now();
    return await insertId(
      `INSERT INTO elyxion_violations
        (created_at, updated_at, player_id, player_name, severity, reason, issued_by, status, expires_at)
       VALUES ($1, $1, $2, $3, $4, $5, $6, 'active', $7)
       RETURNING id`,
      [
        now,
        v.playerId.slice(0, 64),
        v.playerName.slice(0, 32) || 'Guest',
        v.severity,
        v.reason.slice(0, 500),
        v.issuedBy.slice(0, 32),
        v.expiresAt && v.expiresAt > now ? Math.floor(v.expiresAt) : 0,
      ],
    );
  } catch (err) {
    console.error('[violations] issue failed', err);
    return 0;
  }
}

export async function listViolations(opts: { playerId?: string; limit?: number }): Promise<ViolationRow[]> {
  const limit = Math.max(1, Math.min(200, Math.floor(opts.limit ?? 100)));
  const rows = opts.playerId
    ? await many<Record<string, unknown>>(
        `SELECT * FROM elyxion_violations WHERE player_id = $1 ORDER BY id DESC LIMIT $2`,
        [opts.playerId, limit],
      )
    : await many<Record<string, unknown>>(
        `SELECT * FROM elyxion_violations ORDER BY id DESC LIMIT $1`,
        [limit],
      );
  return rows.map(mapViolationRow);
}

export async function getViolation(id: number): Promise<ViolationRow | null> {
  const row = await one<Record<string, unknown>>(`SELECT * FROM elyxion_violations WHERE id = $1`, [id]);
  return row ? mapViolationRow(row) : null;
}

export async function setViolationStatus(id: number, status: ViolationStatus, now?: number): Promise<boolean> {
  return (
    (await exec(
      `UPDATE elyxion_violations SET status = $1, updated_at = $2 WHERE id = $3`,
      [status, now ?? Date.now(), id],
    )) > 0
  );
}

export async function submitViolationAppeal(id: number, playerId: string, text: string, now?: number): Promise<boolean> {
  return (
    (await exec(
      `UPDATE elyxion_violations
          SET appeal_status = 'pending', appeal_text = $1, appealed_at = $2,
              updated_at = $2, reviewed_by = '', reviewed_at = 0
        WHERE id = $3 AND player_id = $4 AND status = 'active'`,
      [text.slice(0, 2000), now ?? Date.now(), id, playerId],
    )) > 0
  );
}

export async function reviewViolationAppeal(
  id: number,
  appealStatus: Exclude<ViolationAppealStatus, 'none' | 'pending'>,
  reviewedBy: string,
  now?: number,
): Promise<boolean> {
  return (
    (await exec(
      `UPDATE elyxion_violations
          SET appeal_status = $1,
              status = CASE WHEN $1 = 'approved' THEN 'dismissed' ELSE status END,
              reviewed_by = $2, reviewed_at = $3, updated_at = $3
        WHERE id = $4 AND appeal_status = 'pending'`,
      [appealStatus, reviewedBy.slice(0, 32), now ?? Date.now(), id],
    )) > 0
  );
}

export async function violationCounts(): Promise<{ active: number; dismissed: number; pendingAppeals: number }> {
  const rows = await many<{ status: string; appeal_status: string; n: string }>(
    `SELECT status, appeal_status, COUNT(*) AS n FROM elyxion_violations GROUP BY status, appeal_status`,
  );
  const out = { active: 0, dismissed: 0, pendingAppeals: 0 };
  for (const row of rows) {
    if (row.status === 'active') out.active += nOf(row.n);
    if (row.status === 'dismissed') out.dismissed += nOf(row.n);
    if (row.appeal_status === 'pending') out.pendingAppeals += nOf(row.n);
  }
  return out;
}

// ── Community chat (Discord-style social hub) ───────────────────────────────
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

function mapCommunityRow(r: Record<string, unknown>): CommunityMessageRow {
  return {
    id: nOf(r.id),
    channel: String(r.channel ?? '') as CommunityChannel,
    ts: nOf(r.ts),
    playerId: String(r.player_id ?? ''),
    playerName: String(r.player_name ?? '') || 'Guest',
    text: String(r.text ?? ''),
    deleted: r.deleted === true,
    admin: r.admin === true,
    verified: r.verified === true,
    ip: String(r.ip ?? ''),
    userAgent: String(r.user_agent ?? ''),
  };
}

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

const COMMUNITY_MAX_ROWS = 50_000;

// Store a community chat message. Returns the new row id (0 on failure — never
// throws into the request path).
export async function postCommunityMessage(m: CommunityMessageInput): Promise<number> {
  try {
    await dbReady();
    const now = m.now ?? Date.now();
    const id = await insertId(
      `INSERT INTO elyxion_community_messages (channel, ts, player_id, player_name, text, deleted, admin, verified, ip, user_agent)
       VALUES ($1, $2, $3, $4, $5, FALSE, $6, $7, $8, $9)
       RETURNING id`,
      [
        m.channel,
        now,
        (m.playerId ?? '').slice(0, 64),
        (m.playerName ?? '').slice(0, 32) || 'Guest',
        m.text.slice(0, 600),
        m.admin ? true : false,
        m.verified ? true : false,
        (m.ip ?? '').slice(0, 64),
        (m.userAgent ?? '').slice(0, 256),
      ],
    );
    await exec(
      `DELETE FROM elyxion_community_messages
        WHERE id < (SELECT COALESCE(MIN(id), 0) FROM
          (SELECT id FROM elyxion_community_messages ORDER BY id DESC OFFSET $1) s)`,
      [COMMUNITY_MAX_ROWS],
    ).catch(() => undefined);
    return id;
  } catch (err) {
    console.error('[community] post failed', err);
    return 0;
  }
}

// Recent messages in one channel, newest first, keyset-paginated by id.
export async function listCommunityMessages(opts: {
  channel: CommunityChannel;
  limit?: number;
  beforeId?: number;
}): Promise<CommunityMessageRow[]> {
  const n = Math.max(1, Math.min(200, Math.floor(opts.limit ?? 50)));
  const before = opts.beforeId && opts.beforeId > 0 ? opts.beforeId : 0;
  const rows = before
    ? await many<Record<string, unknown>>(
        `SELECT * FROM elyxion_community_messages
          WHERE channel = $1 AND id < $2 ORDER BY id DESC LIMIT $3`,
        [opts.channel, before, n],
      )
    : await many<Record<string, unknown>>(
        `SELECT * FROM elyxion_community_messages WHERE channel = $1 ORDER BY id DESC LIMIT $2`,
        [opts.channel, n],
      );
  return rows.map(mapCommunityRow);
}

// Recent messages across ALL channels, newest first — the admin moderation view.
export async function listAllCommunityMessages(opts: { limit?: number; beforeId?: number }): Promise<CommunityMessageRow[]> {
  const n = Math.max(1, Math.min(200, Math.floor(opts.limit ?? 50)));
  const before = opts.beforeId && opts.beforeId > 0 ? opts.beforeId : 0;
  const rows = before
    ? await many<Record<string, unknown>>(
        `SELECT * FROM elyxion_community_messages WHERE id < $1 ORDER BY id DESC LIMIT $2`,
        [before, n],
      )
    : await many<Record<string, unknown>>(
        `SELECT * FROM elyxion_community_messages ORDER BY id DESC LIMIT $1`,
        [n],
      );
  return rows.map(mapCommunityRow);
}

// Mark a message deleted (soft delete — kept for audit). Returns true if a row
// changed.
export async function deleteCommunityMessage(id: number): Promise<boolean> {
  return (
    (await exec(
      `UPDATE elyxion_community_messages SET deleted = TRUE WHERE id = $1 AND deleted = FALSE`,
      [id],
    )) > 0
  );
}

// ── Stats / progression ──────────────────────────────────────────────────────
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

const toPublic = (r: Record<string, unknown> | undefined): PublicStats =>
  r
    ? {
        totalKills: nOf(r.total_kills),
        totalDeaths: nOf(r.total_deaths),
        totalGames: nOf(r.total_games),
        totalWins: nOf(r.total_wins),
        bestKillStreak: nOf(r.best_kill_streak),
        headshots: nOf(r.headshots),
        bestAccuracy: nOf(r.best_accuracy),
      }
    : { ...ZERO_STATS };

export async function getStats(playerId: string): Promise<PublicStats> {
  await dbReady();
  const row = await one<Record<string, unknown>>(
    `SELECT total_kills, total_deaths, total_games, total_wins,
            best_kill_streak, headshots, best_accuracy
       FROM elyxion_stats WHERE player_id = $1`,
    [playerId],
  );
  return toPublic(row);
}

// Create a bare stats row for a player who is equipping/buying before ever
// recording a match, so UPDATEs have a row to touch. Idempotent.
async function ensureRow(playerId: string, now: number): Promise<void> {
  await exec(
    `INSERT INTO elyxion_stats (player_id, user_name, created_at, updated_at)
     VALUES ($1, 'Player', $2, $2)
     ON CONFLICT (player_id) DO NOTHING`,
    [playerId, now],
  );
}

// YYYYMMDD in UTC — a stable, timezone-independent "today" for the first-win bonus.
function ymd(now: number): number {
  const d = new Date(now);
  return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
}

// Period keys for a timestamp (UTC): "d:YYYYMMDD" (today) and "w:YYYYMMDD" of the
// current week's Monday. Both are the buckets a match contributes to.
function dayKey(now: number): string {
  return `d:${ymd(now)}`;
}
function weekKey(now: number): string {
  const d = new Date(now);
  const dow = (d.getUTCDay() + 6) % 7;
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow));
  return `w:${ymd(monday.getTime())}`;
}

// Week key for the WEEKLY CHALLENGE (board + replays). Own key namespace so a
// format change starts a clean board; bump CHALLENGE_FORMAT when rules change.
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

type ProgRow = {
  total_xp: number;
  level: number;
  credits: number;
  unlocked: string;
  equipped: string;
  first_win_day: number;
};

async function progSelectFor(playerId: string): Promise<ProgRow | undefined> {
  const r = await one<Record<string, unknown>>(
    `SELECT total_xp, level, credits, unlocked, equipped, first_win_day
       FROM elyxion_stats WHERE player_id = $1`,
    [playerId],
  );
  return r
    ? {
        total_xp: nOf(r.total_xp),
        level: nOf(r.level),
        credits: nOf(r.credits),
        unlocked: String(r.unlocked ?? '[]'),
        equipped: String(r.equipped ?? '{}'),
        first_win_day: nOf(r.first_win_day),
      }
    : undefined;
}

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

// Is this account id an admin?
export async function isAdminId(playerId: string): Promise<boolean> {
  if (!playerId) return false;
  await dbReady();
  const r = await one<{ is_admin: boolean }>(
    `SELECT is_admin FROM elyxion_users WHERE id = $1`,
    [playerId],
  );
  return r?.is_admin === true;
}

// Owned set = the default freebies ∪ level grants ∪ stored (bought/granted).
// Admins own EVERYTHING (every manifest id).
async function ownedSetFor(prog: ProgRow | undefined, playerId: string): Promise<Set<string>> {
  if (await isAdminId(playerId)) return new Set(ALL_COSMETIC_IDS);
  return new Set([
    ...defaultUnlockedIds(),
    ...levelGrantsAt(prog?.level ?? 1),
    ...parseIdList(prog?.unlocked),
  ]);
}

// The unlocked-cosmetic set for an account id, used to ownership-check WS
// cosmetic equips. An empty/unknown id → defaults only; admins → all.
export async function unlockedSetFor(playerId: string): Promise<Set<string>> {
  if (!playerId) return new Set(defaultUnlockedIds());
  await dbReady();
  const prog = await progSelectFor(playerId);
  return ownedSetFor(prog, playerId);
}

export type Progression = {
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

// Atomic stat upsert: increments are applied in SQL (column + delta), not
// read-modify-write in JS, so two near-simultaneous POSTs can't clobber deltas.
// RETURNING hands back the final row. (Postgres: GREATEST instead of scalar max.)
const STAT_UPSERT_COLS = `total_kills, total_deaths, total_games, total_wins,
          best_kill_streak, headshots, best_accuracy`;
const statsUpsertSql = `
INSERT INTO elyxion_stats (
  player_id, user_name, total_kills, total_deaths, total_games, total_wins,
  best_kill_streak, headshots, shots_fired, shots_hit, best_accuracy,
  created_at, updated_at
) VALUES (
  $1, $2, $3, $4, 1, $5, $6, $7, $8, $9, $10, $11, $11
)
ON CONFLICT(player_id) DO UPDATE SET
  user_name        = EXCLUDED.user_name,
  total_kills      = elyxion_stats.total_kills + EXCLUDED.total_kills,
  total_deaths     = elyxion_stats.total_deaths + EXCLUDED.total_deaths,
  total_games      = elyxion_stats.total_games + 1,
  total_wins       = elyxion_stats.total_wins + EXCLUDED.total_wins,
  best_kill_streak = GREATEST(elyxion_stats.best_kill_streak, EXCLUDED.best_kill_streak),
  headshots        = elyxion_stats.headshots + EXCLUDED.headshots,
  shots_fired      = elyxion_stats.shots_fired + EXCLUDED.shots_fired,
  shots_hit        = elyxion_stats.shots_hit + EXCLUDED.shots_hit,
  best_accuracy    = GREATEST(elyxion_stats.best_accuracy, EXCLUDED.best_accuracy),
  updated_at       = EXCLUDED.updated_at
RETURNING ${STAT_UPSERT_COLS}`;

// Per-period bucket upsert — same accumulation as the all-time row, keyed by period.
const periodUpsertSql = `
INSERT INTO elyxion_period_stats (
  player_id, period_key, user_name, total_kills, total_deaths, total_games,
  total_wins, best_kill_streak, headshots, best_accuracy, updated_at
) VALUES (
  $1, $2, $3, $4, $5, 1, $6, $7, $8, $9, $10
)
ON CONFLICT(player_id, period_key) DO UPDATE SET
  user_name        = EXCLUDED.user_name,
  total_kills      = elyxion_period_stats.total_kills + EXCLUDED.total_kills,
  total_deaths     = elyxion_period_stats.total_deaths + EXCLUDED.total_deaths,
  total_games      = elyxion_period_stats.total_games + 1,
  total_wins       = elyxion_period_stats.total_wins + EXCLUDED.total_wins,
  best_kill_streak = GREATEST(elyxion_period_stats.best_kill_streak, EXCLUDED.best_kill_streak),
  headshots        = elyxion_period_stats.headshots + EXCLUDED.headshots,
  best_accuracy    = GREATEST(elyxion_period_stats.best_accuracy, EXCLUDED.best_accuracy),
  updated_at       = EXCLUDED.updated_at`;

// Records a match: applies the atomic stat upsert, then derives XP/level/credits
// and milestone unlocks from the (already-clamped) delta. Runs under the
// player's lock, so concurrent submissions for one player serialize like the
// old sync store. The client never reports its own XP; everything is server-
// derived.
export function recordMatch(delta: MatchDelta): Promise<MatchRecordResult> {
  return withLock(`p:${delta.playerId}`, async (): Promise<MatchRecordResult> => {
    // Guests (no account) accrue nothing — no row, no XP, no leaderboard seeding.
    if (!delta.playerId) {
      return {
        stats: { ...ZERO_STATS },
        xpGained: 0,
        creditsGained: 0,
        leveledUp: false,
        newUnlocks: [],
        progression: { totalXp: 0, level: 1, credits: 0, unlocked: [...defaultUnlockedIds()], equipped: {} },
      };
    }
    await dbReady();
    const stats = toPublic(
      await one<Record<string, unknown>>(statsUpsertSql, [
        delta.playerId,
        delta.userName.slice(0, 32) || 'Player',
        delta.kills,
        delta.deaths,
        delta.wins,
        delta.bestStreak,
        delta.headshots,
        delta.shotsFired,
        delta.shotsHit,
        delta.accuracy,
        delta.now,
      ]),
    );

    // Daily/weekly leaderboard buckets — online matches only (these are the
    // competitive ladders; offline bot grinding shouldn't seed them).
    if (!delta.offline) {
      for (const key of [dayKey(delta.now), weekKey(delta.now)]) {
        await exec(periodUpsertSql, [
          delta.playerId,
          key,
          delta.userName.slice(0, 32) || 'Player',
          delta.kills,
          delta.deaths,
          delta.wins,
          delta.bestStreak,
          delta.headshots,
          delta.accuracy,
          delta.now,
        ]);
      }
    }

    const prog = await progSelectFor(delta.playerId);
    const curXp = prog?.total_xp ?? 0;
    const curCredits = prog?.credits ?? 0;
    const owned = await ownedSetFor(prog, delta.playerId);
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
    // now earned. `stats` is the post-match clamped aggregate, so titles unlock
    // the moment a career threshold is crossed.
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

    await exec(
      `UPDATE elyxion_stats
          SET total_xp = $2, level = $3, credits = $4, unlocked = $5,
              equipped = $6, first_win_day = $7
        WHERE player_id = $1`,
      [
        delta.playerId,
        newXp,
        newLevel,
        newCredits,
        JSON.stringify([...owned]),
        JSON.stringify(equipped),
        newFirstWinDay,
      ],
    );

    // Advance daily/weekly challenges from this match (online matches only).
    await trackChallenges(delta.playerId, delta);

    return {
      stats,
      xpGained,
      creditsGained,
      leveledUp,
      newUnlocks,
      progression: { totalXp: newXp, level: newLevel, credits: newCredits, unlocked: [...owned], equipped },
    };
  });
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
  ranked: { rating: number; rank: number; provisional: boolean } | null;
};

export async function getProfile(playerId: string): Promise<Profile> {
  await dbReady();
  const prog = await progSelectFor(playerId);
  const totalXp = prog?.total_xp ?? 0;
  const lp = levelProgress(totalXp);
  const rp = await getRankedProfile(playerId);
  return {
    level: lp.level,
    totalXp,
    xpIntoLevel: lp.xpIntoLevel,
    xpForNext: lp.xpForNext,
    credits: prog?.credits ?? 0,
    unlocked: [...(await ownedSetFor(prog, playerId))],
    equipped: parseEquipped(prog?.equipped),
    stats: await getStats(playerId),
    ranked: rp ? { rating: rp.rating, rank: rp.rank, provisional: rp.provisional } : null,
  };
}

export type EquipResult =
  | { ok: true; equipped: Record<string, string> }
  | { ok: false; reason: 'unknown' | 'slot_mismatch' | 'locked'; equipped: Record<string, string> };

// Equip a cosmetic the player owns. Server-validated against the manifest and
// the owned set, so a forged equip can't grant or apply a locked item.
export async function setEquipped(playerId: string, slot: string, id: string): Promise<EquipResult> {
  if (!playerId) return { ok: false, reason: 'locked', equipped: {} }; // guest: no persistence
  await dbReady();
  const prog = await progSelectFor(playerId);
  const equipped = parseEquipped(prog?.equipped);
  if (!cosmeticById(id)) return { ok: false, reason: 'unknown', equipped };
  if (slotOf(id) !== slot) return { ok: false, reason: 'slot_mismatch', equipped };
  if (!(await ownedSetFor(prog, playerId)).has(id)) return { ok: false, reason: 'locked', equipped };
  equipped[slot] = id;
  const now = Date.now();
  await ensureRow(playerId, now);
  await exec(`UPDATE elyxion_stats SET equipped = $2 WHERE player_id = $1`, [
    playerId,
    JSON.stringify(equipped),
  ]);
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

// Spend credits to unlock a buyable cosmetic. Validated server-side, under the
// player lock so two buys can't both pass the balance check.
export function buyCosmetic(playerId: string, id: string): Promise<BuyResult> {
  return withLock(`p:${playerId}`, async (): Promise<BuyResult> => {
    if (!playerId)
      return { ok: false, reason: 'insufficient', credits: 0, unlocked: [...defaultUnlockedIds()] };
    await dbReady();
    const c = cosmeticById(id);
    const prog = await progSelectFor(playerId);
    const credits = prog?.credits ?? 0;
    const owned = await ownedSetFor(prog, playerId);
    if (!c) return { ok: false, reason: 'unknown', credits, unlocked: [...owned] };
    if (c.source.type !== 'credits')
      return { ok: false, reason: 'not_for_sale', credits, unlocked: [...owned] };
    if (owned.has(id)) return { ok: false, reason: 'owned', credits, unlocked: [...owned] };
    if (credits < c.source.price)
      return { ok: false, reason: 'insufficient', credits, unlocked: [...owned] };
    const newCredits = credits - c.source.price;
    owned.add(id);
    const now = Date.now();
    await ensureRow(playerId, now);
    await exec(`UPDATE elyxion_stats SET credits = $2, unlocked = $3 WHERE player_id = $1`, [
      playerId,
      newCredits,
      JSON.stringify([...owned]),
    ]);
    return { ok: true, credits: newCredits, unlocked: [...owned] };
  });
}

export type CaseResult =
  | { ok: true; won: string; dupe: boolean; refund: number; credits: number; unlocked: string[] }
  | { ok: false; reason: 'insufficient'; credits: number };

// Open a hat case: spend credits, roll a hat weighted by rarity (server-
// authoritative), unlock it — or, if already owned, refund part of the cost.
export function openCase(playerId: string): Promise<CaseResult> {
  return withLock(`p:${playerId}`, async (): Promise<CaseResult> => {
    if (!playerId) return { ok: false, reason: 'insufficient', credits: 0 };
    await dbReady();
    const now = Date.now();
    await ensureRow(playerId, now);
    const prog = await progSelectFor(playerId);
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

    const owned = await ownedSetFor(prog, playerId);
    const dupe = owned.has(won.id);
    let newCredits = credits - HAT_CASE_COST;
    let refund = 0;
    if (dupe) {
      refund = Math.floor(HAT_CASE_COST * DUPE_REFUND_FRAC);
      newCredits += refund;
    } else {
      owned.add(won.id);
    }
    await exec(`UPDATE elyxion_stats SET credits = $2, unlocked = $3 WHERE player_id = $1`, [
      playerId,
      newCredits,
      JSON.stringify([...owned]),
    ]);
    return { ok: true, won: won.id, dupe, refund, credits: newCredits, unlocked: [...owned] };
  });
}

// ── Bans (moderation) ──────────────────────────────────────────────────────
// Two identities: display NAME (case-insensitive; the stable handle for
// accounts) and IP ADDRESS (+ the stable guest uuid). bannedUntil: epoch ms the
// ban lifts; 0 = permanent.
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

const normGuest = (guestId: string): string => guestId.trim().toLowerCase();
const usableGuest = (guestId: string): boolean => normGuest(guestId).length > 0;

const normIp = (ip: string): string => ip.trim();
// 'unknown' is the fallback when no forwarding header exists — never meaningful
// as a ban target (it'd block every connection behind a missing header).
const usableIp = (ip: string): boolean => {
  const n = normIp(ip);
  return n.length > 0 && n !== 'unknown';
};

export async function isBannedName(name: string): Promise<boolean> {
  return !!(await getBanByName(name));
}

// Ban row for a name (undefined = not banned) — the reason rides along so the
// kicked message can say why. Reads are expiry-aware: a lapsed ban reads as
// "not banned" everywhere, so an expired row is inert until the sweeper deletes it.
export async function getBanByName(name: string): Promise<BanRow | undefined> {
  if (!name) return undefined;
  await dbReady();
  const r = await one<Record<string, unknown>>(
    `SELECT name, reason, banned_by, created_at, banned_until FROM elyxion_bans WHERE name_lower = $1`,
    [name.trim().toLowerCase()],
  );
  if (!r || !banActive(nOf(r.banned_until), Date.now())) return undefined;
  return {
    name: String(r.name),
    reason: String(r.reason),
    bannedBy: String(r.banned_by),
    createdAt: nOf(r.created_at),
    bannedUntil: nOf(r.banned_until),
  };
}

export async function getBanByIp(ip: string): Promise<IpBanRow | undefined> {
  if (!usableIp(ip)) return undefined;
  await dbReady();
  const r = await one<Record<string, unknown>>(
    `SELECT ip, reason, banned_by, created_at, banned_until FROM elyxion_ip_bans WHERE ip = $1`,
    [normIp(ip)],
  );
  if (!r || !banActive(nOf(r.banned_until), Date.now())) return undefined;
  return {
    ip: String(r.ip),
    reason: String(r.reason),
    bannedBy: String(r.banned_by),
    createdAt: nOf(r.created_at),
    bannedUntil: nOf(r.banned_until),
  };
}

// Ban row for a guest identity (undefined = not banned). Expiry-aware, like the
// name/IP lookups.
export async function getBanByGuestId(guestId: string): Promise<GuestBanRow | undefined> {
  if (!usableGuest(guestId)) return undefined;
  await dbReady();
  const r = await one<Record<string, unknown>>(
    `SELECT guest_id, reason, banned_by, created_at, banned_until FROM elyxion_guest_bans WHERE guest_id = $1`,
    [normGuest(guestId)],
  );
  if (!r || !banActive(nOf(r.banned_until), Date.now())) return undefined;
  return {
    guestId: String(r.guest_id),
    reason: String(r.reason),
    bannedBy: String(r.banned_by),
    createdAt: nOf(r.created_at),
    bannedUntil: nOf(r.banned_until),
  };
}

// Name ban; when the target is online their IP is auto-captured too, so a
// reconnecting guest can't dodge the ban by renumbering. `capturedFrom` is the
// banned player's name_lower, tying the IP row to this ban. Captured IPs
// inherit the same expiry.
export async function addBan(
  name: string,
  reason: string,
  bannedBy: string,
  ip?: string,
  capturedFrom?: string,
  now: number = Date.now(),
  bannedUntil: number = 0,
): Promise<boolean> {
  const n = name.trim();
  if (!n) return false;
  await dbReady();
  await exec(
    upsertSql('elyxion_bans', ['name_lower'], ['name_lower', 'name', 'reason', 'banned_by', 'created_at', 'banned_until']),
    [n.toLowerCase(), n, reason || '', bannedBy || '', now, bannedUntil],
  );
  if (usableIp(ip ?? ''))
    await addIpBan(ip!, reason, bannedBy, capturedFrom ?? n.toLowerCase(), now, bannedUntil);
  return true;
}

export async function addIpBan(
  ip: string,
  reason: string,
  bannedBy: string,
  capturedFrom: string = '',
  now: number = Date.now(),
  bannedUntil: number = 0,
): Promise<boolean> {
  if (!usableIp(ip)) return false;
  await dbReady();
  await exec(
    upsertSql('elyxion_ip_bans', ['ip'], ['ip', 'reason', 'banned_by', 'banned_name', 'created_at', 'banned_until']),
    [normIp(ip), reason || '', bannedBy || '', capturedFrom, now, bannedUntil],
  );
  return true;
}

// Direct guest-uuid ban (or the db half of a ban captured from a name ban).
export async function addGuestBan(
  guestId: string,
  reason: string,
  bannedBy: string,
  capturedFrom: string = '',
  now: number = Date.now(),
  bannedUntil: number = 0,
): Promise<boolean> {
  if (!usableGuest(guestId)) return false;
  await dbReady();
  await exec(
    upsertSql('elyxion_guest_bans', ['guest_id'], ['guest_id', 'reason', 'banned_by', 'captured_name', 'created_at', 'banned_until']),
    [normGuest(guestId), reason || '', bannedBy || '', capturedFrom, now, bannedUntil],
  );
  return true;
}

// Delete lapsed timed bans (permanent rows survive). Idempotent — safe to run
// on a timer; cheap enough that running it on the game sweep is fine.
export async function sweepExpiredBans(now: number = Date.now()): Promise<{
  nameBans: number;
  ipBans: number;
  guestBans: number;
}> {
  await dbReady();
  const nameBans = await exec(`DELETE FROM elyxion_bans WHERE banned_until > 0 AND banned_until <= $1`, [now]);
  const ipBans = await exec(`DELETE FROM elyxion_ip_bans WHERE banned_until > 0 AND banned_until <= $1`, [now]);
  const guestBans = await exec(`DELETE FROM elyxion_guest_bans WHERE banned_until > 0 AND banned_until <= $1`, [now]);
  return { nameBans, ipBans, guestBans };
}

// Lifting a name ban also lifts the IPs AND guest uuids it auto-captured (an
// unban must mean "this player can come back"). Manual /banip rows survive.
export async function removeBan(name: string): Promise<boolean> {
  const lower = name.trim().toLowerCase();
  if (!lower) return false;
  await dbReady();
  let removed = (await exec(`DELETE FROM elyxion_bans WHERE name_lower = $1`, [lower])) > 0;
  removed = (await exec(`DELETE FROM elyxion_ip_bans WHERE banned_name = $1`, [lower])) > 0 || removed;
  removed = (await exec(`DELETE FROM elyxion_guest_bans WHERE captured_name = $1`, [lower])) > 0 || removed;
  return removed;
}

export async function removeIpBan(ip: string): Promise<boolean> {
  if (!usableIp(ip)) return false;
  await dbReady();
  return (await exec(`DELETE FROM elyxion_ip_bans WHERE ip = $1`, [normIp(ip)])) > 0;
}

// Lifting a guest-uuid ban also lifts the IP that ban captured (the uuid was the
// target; the address was only collateral for the cookie-clearing dodge).
export async function removeGuestBan(guestId: string): Promise<boolean> {
  const g = normGuest(guestId);
  if (!g) return false;
  await dbReady();
  let removed = (await exec(`DELETE FROM elyxion_guest_bans WHERE guest_id = $1`, [g])) > 0;
  removed = (await exec(`DELETE FROM elyxion_ip_bans WHERE banned_name = $1`, [g])) > 0 || removed;
  return removed;
}

export async function listBans(): Promise<BanListItem[]> {
  await dbReady();
  const now = Date.now();
  const nameRows = await many<Record<string, unknown>>(
    `SELECT name, reason, banned_by, created_at, banned_until FROM elyxion_bans
      WHERE banned_until = 0 OR banned_until > $1 ORDER BY created_at DESC`,
    [now],
  );
  const ipRows = await many<Record<string, unknown>>(
    `SELECT ip, reason, banned_by, created_at, banned_until FROM elyxion_ip_bans
      WHERE banned_until = 0 OR banned_until > $1 ORDER BY created_at DESC`,
    [now],
  );
  const guestRows = await many<Record<string, unknown>>(
    `SELECT guest_id, reason, banned_by, created_at, banned_until FROM elyxion_guest_bans
      WHERE banned_until = 0 OR banned_until > $1 ORDER BY created_at DESC`,
    [now],
  );
  const all: BanListItem[] = [
    ...nameRows.map((r) => ({
      kind: 'name' as const,
      name: String(r.name),
      reason: String(r.reason),
      bannedBy: String(r.banned_by),
      createdAt: nOf(r.created_at),
      bannedUntil: nOf(r.banned_until),
    })),
    ...ipRows.map((r) => ({
      kind: 'ip' as const,
      name: '',
      ip: String(r.ip),
      reason: String(r.reason),
      bannedBy: String(r.banned_by),
      createdAt: nOf(r.created_at),
      bannedUntil: nOf(r.banned_until),
    })),
    ...guestRows.map((r) => ({
      kind: 'guest' as const,
      name: '',
      guestId: String(r.guest_id),
      reason: String(r.reason),
      bannedBy: String(r.banned_by),
      createdAt: nOf(r.created_at),
      bannedUntil: nOf(r.banned_until),
    })),
  ];
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

// ── Challenges (daily/weekly progress) ──────────────────────────────────────

// Progress upserts. 'add' accumulates, 'max' keeps the best single match; both
// clamp at the goal. (Postgres: LEAST/GREATEST instead of 2-arg MIN/MAX.)
async function bumpChallenge(
  playerId: string,
  challenge: string,
  period: string,
  goal: number,
  value: number,
  mode: 'add' | 'max',
): Promise<void> {
  await exec(
    `INSERT INTO elyxion_challenges (player_id, challenge, period, progress, goal, claimed)
     VALUES ($1, $2, $3, LEAST($4, $5), $4, FALSE)
     ON CONFLICT (player_id, challenge, period) DO UPDATE
       SET progress = LEAST(elyxion_challenges.goal,
         ${mode === 'add' ? 'elyxion_challenges.progress + $5' : 'GREATEST(elyxion_challenges.progress, $5)'})`,
    [playerId, challenge, period, goal, value],
  );
}

async function challengeRowFor(
  playerId: string,
  challenge: string,
  period: string,
): Promise<{ progress: number; claimed: boolean } | undefined> {
  const r = await one<Record<string, unknown>>(
    `SELECT progress, claimed FROM elyxion_challenges
      WHERE player_id = $1 AND challenge = $2 AND period = $3`,
    [playerId, challenge, period],
  );
  return r ? { progress: nOf(r.progress), claimed: r.claimed === true } : undefined;
}

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
// practice matches earn no challenge credit.
async function trackChallenges(playerId: string, delta: MatchDelta): Promise<void> {
  if (delta.offline) return;
  const now = delta.now;
  const daily = activeChallenges(playerId, DAILY_CHALLENGES, dailyPeriod(now), DAILY_COUNT);
  const weekly = activeChallenges(playerId, WEEKLY_CHALLENGES, weeklyPeriod(now), WEEKLY_COUNT);
  for (const c of [...daily, ...weekly]) {
    const value = metricValue(c.metric, delta);
    if (value <= 0) continue; // nothing to record this match
    await bumpChallenge(playerId, c.id, periodFor(c, now), c.goal, value, c.track);
  }
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

export async function getChallenges(
  playerId: string,
  now: number,
): Promise<{ daily: ChallengeView[]; weekly: ChallengeView[] }> {
  await dbReady();
  const view = async (def: ChallengeDef): Promise<ChallengeView> => {
    const row = await challengeRowFor(playerId, def.id, periodFor(def, now));
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
    daily: await Promise.all(activeChallenges(playerId, DAILY_CHALLENGES, dailyPeriod(now), DAILY_COUNT).map(view)),
    weekly: await Promise.all(activeChallenges(playerId, WEEKLY_CHALLENGES, weeklyPeriod(now), WEEKLY_COUNT).map(view)),
  };
}

export type ClaimResult =
  | { ok: true; xpGained: number; creditsGained: number; progression: Progression; newUnlocks: string[] }
  | { ok: false; reason: 'unknown' | 'not_active' | 'incomplete' | 'claimed' };

// Pay out a reward (challenge claim): add XP + credits, recompute level + any
// milestone unlocks. Runs under the player lock with the claim flip so a second
// (even concurrent) claim can't double-pay.
export function claimChallenge(playerId: string, id: string, now: number): Promise<ClaimResult> {
  return withLock(`p:${playerId}`, async (): Promise<ClaimResult> => {
    if (!playerId) return { ok: false, reason: 'not_active' }; // guest: no challenges
    await dbReady();
    const def = challengeById(id);
    if (!def) return { ok: false, reason: 'unknown' };
    if (!activeFor(playerId, def, now)) return { ok: false, reason: 'not_active' };
    const period = periodFor(def, now);
    const row = await challengeRowFor(playerId, id, period);
    const progress = row?.progress ?? 0;
    if (progress < def.goal) return { ok: false, reason: 'incomplete' };
    if (row?.claimed) return { ok: false, reason: 'claimed' };
    // Atomic claim: the `AND claimed = FALSE` guard means a concurrent claim
    // flips no rows → no double payout, independent of JS ordering.
    const changed = await exec(
      `UPDATE elyxion_challenges SET claimed = TRUE
        WHERE player_id = $1 AND challenge = $2 AND period = $3 AND claimed = FALSE`,
      [playerId, id, period],
    );
    if (changed === 0) return { ok: false, reason: 'claimed' };
    const { progression, newUnlocks } = await grantXpCredits(playerId, def.rewardXp, def.rewardCredits);
    return { ok: true, xpGained: def.rewardXp, creditsGained: def.rewardCredits, progression, newUnlocks };
  });
}

// Focused XP/credits/unlock payout (leaves equipped + first_win_day untouched) —
// used to pay challenge rewards on top of match XP. Caller holds the lock.
async function grantXpCredits(
  playerId: string,
  xp: number,
  credits: number,
): Promise<{ progression: Progression; newUnlocks: string[] }> {
  const now = Date.now();
  await ensureRow(playerId, now);
  const prog = await progSelectFor(playerId);
  const owned = await ownedSetFor(prog, playerId);
  const equipped = parseEquipped(prog?.equipped);
  const newXp = (prog?.total_xp ?? 0) + Math.max(0, Math.floor(xp));
  const newLevel = levelForXp(newXp);
  const before = new Set(owned);
  for (const id of levelGrantsAt(newLevel)) owned.add(id);
  const newUnlocks = [...owned].filter((id) => !before.has(id));
  const newCredits = (prog?.credits ?? 0) + Math.max(0, Math.floor(credits));
  await exec(
    `UPDATE elyxion_stats SET total_xp = $2, level = $3, credits = $4, unlocked = $5
      WHERE player_id = $1`,
    [playerId, newXp, newLevel, newCredits, JSON.stringify([...owned])],
  );
  return {
    progression: { totalXp: newXp, level: newLevel, credits: newCredits, unlocked: [...owned], equipped },
    newUnlocks,
  };
}

// ── Global leaderboard ──────────────────────────────────────────────────────
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
  kd: number;
  admin: boolean; // staff badge on the standings
  verified: boolean; // blue verified check on the standings
};

// Minimum games before a player appears on / is ranked by the accuracy board —
// stops a single lucky 1-shot 100% match from topping the standings.
const MIN_ACC_GAMES = 5;

const LEADERBOARD_COLS = `player_id, user_name, total_kills, total_deaths, total_games,
          total_wins, best_kill_streak, headshots, best_accuracy`;

// One ORDER BY per sort column — the router whitelists `sort`, and the value
// picked from this map (never user input) is interpolated. `limit` is bound.
const LEADER_ORDER: Record<string, string> = {
  kills: 'total_kills DESC',
  wins: 'total_wins DESC, total_kills DESC',
  accuracy: `best_accuracy DESC, total_kills DESC`,
};

const round2 = (n: number): number => Math.round(n * 100) / 100;

type LeaderboardRow = Record<string, unknown>;

const toLeaderboardEntry = (row: LeaderboardRow): LeaderboardEntry => ({
  id: String(row.player_id),
  userName: String(row.user_name),
  totalKills: nOf(row.total_kills),
  totalDeaths: nOf(row.total_deaths),
  totalGames: nOf(row.total_games),
  totalWins: nOf(row.total_wins),
  bestKillStreak: nOf(row.best_kill_streak),
  headshots: nOf(row.headshots),
  bestAccuracy: nOf(row.best_accuracy),
  kd: round2(
    nOf(row.total_deaths) > 0 ? nOf(row.total_kills) / nOf(row.total_deaths) : nOf(row.total_kills),
  ),
  admin: false,
  verified: false,
});

// Fill in admin/verified for a batch of entries with one parameterized query.
async function attachUserFlags(entries: LeaderboardEntry[]): Promise<LeaderboardEntry[]> {
  if (entries.length === 0) return entries;
  const ids = entries.map((e) => e.id);
  const rows = await many<Record<string, unknown>>(
    `SELECT id, is_admin, is_verified FROM elyxion_users WHERE id IN (${ph(ids.length)})`,
    ids,
  );
  const byId = new Map(rows.map((r) => [String(r.id), r]));
  for (const e of entries) {
    const f = byId.get(e.id);
    if (f) {
      e.admin = f.is_admin === true;
      e.verified = f.is_verified === true;
    }
  }
  return entries;
}

export async function getLeaderboard(opts: {
  sort: 'kills' | 'wins' | 'accuracy';
  limit: number;
  window?: LeaderWindow;
}): Promise<LeaderboardEntry[]> {
  await dbReady();
  const limit = Math.max(1, Math.min(100, Math.floor(opts.limit)));
  const win = opts.window ?? 'all';
  const key = windowKey(win, Date.now());
  const order = LEADER_ORDER[opts.sort] ?? LEADER_ORDER.kills;
  const rows = key
    ? await many<LeaderboardRow>(
        `SELECT ${LEADERBOARD_COLS} FROM elyxion_period_stats
          WHERE period_key = $1 AND total_games > 0 ORDER BY ${order} LIMIT $2`,
        [key, limit],
      )
    : await many<LeaderboardRow>(
        `SELECT ${LEADERBOARD_COLS} FROM elyxion_stats
          WHERE total_games > 0 ORDER BY ${order} LIMIT $1`,
        [limit],
      );
  return attachUserFlags(rows.map(toLeaderboardEntry));
}

export type LeaderWindow = 'all' | 'daily' | 'weekly';
// The period_key a window resolves to right now (null for all-time).
function windowKey(win: LeaderWindow, now: number): string | null {
  return win === 'daily' ? dayKey(now) : win === 'weekly' ? weekKey(now) : null;
}

// The requesting player's rank + their own entry within the window, for the "you
// are #N" pin. `rank: 0` = unranked (below the accuracy floor). Returns null if
// the player has no row in the window at all.
export async function getPlayerRank(
  playerId: string,
  sort: 'kills' | 'wins' | 'accuracy',
  window: LeaderWindow = 'all',
): Promise<{ rank: number; entry: LeaderboardEntry } | null> {
  if (!playerId) return null;
  await dbReady();
  const key = windowKey(window, Date.now());
  const row = key
    ? await one<LeaderboardRow>(
        `SELECT ${LEADERBOARD_COLS} FROM elyxion_period_stats WHERE player_id = $1 AND period_key = $2`,
        [playerId, key],
      )
    : await one<LeaderboardRow>(
        `SELECT ${LEADERBOARD_COLS} FROM elyxion_stats WHERE player_id = $1`,
        [playerId],
      );
  if (!row || nOf(row.total_games) <= 0) return null;
  const [entry] = await attachUserFlags([toLeaderboardEntry(row)]);
  if (sort === 'accuracy' && nOf(row.total_games) < MIN_ACC_GAMES) return { rank: 0, entry };
  const metric =
    sort === 'kills' ? nOf(row.total_kills) : sort === 'wins' ? nOf(row.total_wins) : nOf(row.best_accuracy);
  const floor = sort === 'accuracy' ? MIN_ACC_GAMES : 0;
  // Rank = 1 + (players strictly ahead on the primary metric). Ties share a rank.
  const above = key
    ? nOf(
        (
          await one<{ n: string }>(
            `SELECT COUNT(*) AS n FROM elyxion_period_stats
              WHERE period_key = $1 AND total_games >= $2 AND
                ${sort === 'kills' ? 'total_kills' : sort === 'wins' ? 'total_wins' : 'best_accuracy'} > $3`,
            [key, floor, metric],
          )
        )?.n,
      )
    : nOf(
        (
          await one<{ n: string }>(
            `SELECT COUNT(*) AS n FROM elyxion_stats
              WHERE total_games >= $1 AND
                ${sort === 'kills' ? 'total_kills' : sort === 'wins' ? 'total_wins' : 'best_accuracy'} > $2`,
            [floor, metric],
          )
        )?.n,
      );
  return { rank: above + 1, entry };
}

// ── Accounts (auth) ──────────────────────────────────────────────────────────
// Registered users + opaque session tokens. Passwords are hashed in
// server/auth.ts (scrypt); this layer only stores/reads. The account id is the
// progression player_id, so logging in carries your XP/cosmetics across devices.

export type UserRow = { id: string; username: string; pw_hash: string; pw_salt: string };
// Public account info (no secrets) — id, name, and moderation flags.
export type AccountInfo = { id: string; username: string; isAdmin: boolean; isVerified: boolean };

const toAccountInfo = (r: Record<string, unknown> | undefined): AccountInfo | undefined =>
  r
    ? {
        id: String(r.id),
        username: String(r.username),
        isAdmin: r.is_admin === true,
        isVerified: r.is_verified === true,
      }
    : undefined;

export async function createUser(u: {
  id: string;
  username: string;
  usernameLower: string;
  pwHash: string;
  pwSalt: string;
  email: string | null;
  createdAt: number;
}): Promise<void> {
  await dbReady();
  await exec(
    `INSERT INTO elyxion_users (id, username, username_lower, pw_hash, pw_salt, email, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [u.id, u.username, u.usernameLower, u.pwHash, u.pwSalt, u.email, u.createdAt],
  );
}

export async function findUserByName(usernameLower: string): Promise<UserRow | undefined> {
  await dbReady();
  const r = await one<Record<string, unknown>>(
    `SELECT id, username, pw_hash, pw_salt FROM elyxion_users WHERE username_lower = $1`,
    [usernameLower],
  );
  return r
    ? {
        id: String(r.id),
        username: String(r.username),
        pw_hash: String(r.pw_hash),
        pw_salt: String(r.pw_salt),
      }
    : undefined;
}

export async function findUserById(id: string): Promise<AccountInfo | undefined> {
  if (!id) return undefined;
  await dbReady();
  const r = await one<Record<string, unknown>>(
    `SELECT id, username, is_admin, is_verified FROM elyxion_users WHERE id = $1`,
    [id],
  );
  return toAccountInfo(r);
}

// Resolve a username (lowercased) to its public account info — used by the admin
// API to verify/promote a player by name without touching password fields.
export async function findAccountByName(usernameLower: string): Promise<AccountInfo | undefined> {
  await dbReady();
  const r = await one<Record<string, unknown>>(
    `SELECT id, username, is_admin, is_verified FROM elyxion_users WHERE username_lower = $1`,
    [usernameLower],
  );
  return toAccountInfo(r);
}

export async function setVerified(id: string, value: boolean): Promise<boolean> {
  await dbReady();
  return (await exec(`UPDATE elyxion_users SET is_verified = $2 WHERE id = $1`, [id, value])) > 0;
}

export async function setAdmin(id: string, value: boolean): Promise<boolean> {
  await dbReady();
  return (await exec(`UPDATE elyxion_users SET is_admin = $2 WHERE id = $1`, [id, value])) > 0;
}

// Add an administrative credit grant to an account, creating its progression
// row when the account has not played a match yet. Returns the new balance.
export async function grantCredits(playerId: string, amount: number, now: number = Date.now()): Promise<number | null> {
  if (!playerId || !Number.isSafeInteger(amount) || amount <= 0) return null;
  await dbReady();
  await ensureRow(playerId, now);
  await exec(
    `UPDATE elyxion_stats SET credits = credits + $2, updated_at = $3 WHERE player_id = $1`,
    [playerId, amount, now],
  );
  const row = await progSelectFor(playerId);
  return row?.credits ?? null;
}

// Promote the configured ADMIN_USERNAMES to admin on boot (idempotent). Lets you
// designate your account on Railway via an env var — register first, set the var,
// redeploy. Returns the number of rows flipped.
export async function syncAdminsFromEnv(usernamesLower: string[]): Promise<number> {
  if (usernamesLower.length === 0) return 0;
  await dbReady();
  return exec(
    `UPDATE elyxion_users SET is_admin = TRUE WHERE username_lower IN (${ph(usernamesLower.length)})`,
    usernamesLower,
  );
}

export async function createSession(token: string, userId: string, now: number): Promise<void> {
  await dbReady();
  await exec(`INSERT INTO elyxion_sessions (token, user_id, created_at) VALUES ($1, $2, $3)`, [
    token,
    userId,
    now,
  ]);
  sessionCache.set(token, userId); // write-through: sync cookie auth keeps working
}

// Resolve a session token to its account id ('' if missing/unknown). SYNCHRONOUS
// by design: Express middleware (accountId()) calls this on every request. The
// write-through cache covers tokens minted by this process; tokens created by a
// previous process become visible after the boot-time seed. A cache miss falls
// back to '' — same semantics as a revoked/unknown session for this process.
export function userIdFromSession(token: string): string {
  if (!token) return '';
  return sessionCache.get(token) ?? '';
}

export async function deleteSession(token: string): Promise<void> {
  await dbReady();
  await exec(`DELETE FROM elyxion_sessions WHERE token = $1`, [token]);
  sessionCache.delete(token);
}

// Replace a password hash and revoke every active session for the account. The
// caller is responsible for generating the scrypt hash and salt.
export async function setPasswordHash(id: string, pwHash: string, pwSalt: string): Promise<boolean> {
  await dbReady();
  const changed =
    (await exec(`UPDATE elyxion_users SET pw_hash = $2, pw_salt = $3 WHERE id = $1`, [id, pwHash, pwSalt])) > 0;
  if (changed) {
    await exec(`DELETE FROM elyxion_sessions WHERE user_id = $1`, [id]);
    for (const [token, uid] of sessionCache) if (uid === id) sessionCache.delete(token);
  }
  return changed;
}

// ── Admin metrics (dashboard) ────────────────────────────────────────────────
// Read-only aggregates for the /admin dashboard. Everything here derives from
// data we already keep: elyxion_stats (career totals + created_at/updated_at),
// elyxion_users (registrations), and elyxion_audit (the per-event timeline).

const DAY_MS = 86_400_000;

// Floor a timestamp to its UTC day index (days since epoch).
function dayIndex(ts: number): number {
  return Math.floor(ts / DAY_MS);
}
function dayIndexToISO(d: number): string {
  return new Date(d * DAY_MS).toISOString().slice(0, 10);
}

export type MetricsWindow = {
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

async function windowMetrics(sinceTs: number): Promise<MetricsWindow> {
  const [matches, active, newAccounts, logins] = await Promise.all([
    one<{ n: string }>(`SELECT COUNT(*) AS n FROM elyxion_audit WHERE event = 'match' AND ts >= $1`, [sinceTs]),
    one<{ n: string }>(
      `SELECT COUNT(DISTINCT actor_id) AS n FROM elyxion_audit
        WHERE event IN ('match','login') AND actor_id <> '' AND ts >= $1`,
      [sinceTs],
    ),
    one<{ n: string }>(`SELECT COUNT(*) AS n FROM elyxion_users WHERE created_at >= $1`, [sinceTs]),
    one<{ n: string }>(`SELECT COUNT(*) AS n FROM elyxion_audit WHERE event = 'login' AND ts >= $1`, [sinceTs]),
  ]);
  return {
    matches: nOf(matches?.n),
    activePlayers: nOf(active?.n),
    newAccounts: nOf(newAccounts?.n),
    logins: nOf(logins?.n),
  };
}

export async function getMetricsOverview(now: number = Date.now()): Promise<MetricsOverview> {
  await dbReady();
  const [agg, day, week, month, lifeMs, accounts, players, matches, onlineMatches] = await Promise.all([
    one<Record<string, unknown>>(
      `SELECT COALESCE(SUM(total_kills),0)  AS kills,
              COALESCE(SUM(total_deaths),0) AS deaths,
              COALESCE(SUM(shots_fired),0)  AS fired,
              COALESCE(SUM(shots_hit),0)    AS hit,
              COALESCE(SUM(total_xp),0)     AS xp
         FROM elyxion_stats`,
    ),
    windowMetrics(now - DAY_MS),
    windowMetrics(now - 7 * DAY_MS),
    windowMetrics(now - 30 * DAY_MS),
    one<{ ms: string | null }>(
      `SELECT AVG(updated_at - created_at) AS ms FROM elyxion_stats WHERE total_games > 0`,
    ),
    one<{ n: string }>(`SELECT COUNT(*) AS n FROM elyxion_users`),
    one<{ n: string }>(`SELECT COUNT(*) AS n FROM elyxion_stats WHERE total_games > 0`),
    one<{ n: string }>(`SELECT COUNT(*) AS n FROM elyxion_audit WHERE event = 'match'`),
    // Offline/practice matches serialize "offline":true into the detail JSON; the
    // online count is everything that isn't that. A coarse but reliable NOT LIKE —
    // our detail serialization is stable (see server/stats.ts).
    one<{ n: string }>(
      `SELECT COUNT(*) AS n FROM elyxion_audit WHERE event = 'match' AND detail NOT LIKE '%"offline":true%'`,
    ),
  ]);
  const life = nOf(lifeMs?.ms);
  return {
    totalAccounts: nOf(accounts?.n),
    playersWithGames: nOf(players?.n),
    totalMatches: nOf(matches?.n),
    onlineMatches: nOf(onlineMatches?.n),
    totalKills: nOf(agg?.kills),
    totalDeaths: nOf(agg?.deaths),
    globalAccuracy: nOf(agg?.fired) > 0 ? round2((nOf(agg?.hit) / nOf(agg?.fired)) * 100) : 0,
    totalXp: nOf(agg?.xp),
    avgLifetimeDays: round2(life / DAY_MS),
    stickiness: month.activePlayers > 0 ? round2(day.activePlayers / month.activePlayers) : 0,
    windows: { day, week, month },
  };
}

export type DayPoint = {
  date: string; // YYYY-MM-DD (UTC)
  matches: number;
  logins: number;
  registrations: number;
  activePlayers: number;
};

// A continuous daily series (gaps filled with zeros) for the last `days` days —
// charts need a dense series, so we materialize every day in the range.
// (ts/86400000 on BIGINT is integer division in Postgres — exact day bucketing.)
export async function getMetricsTimeseries(days: number, now: number = Date.now()): Promise<DayPoint[]> {
  await dbReady();
  const span = Math.max(1, Math.min(180, Math.floor(days)));
  const today = dayIndex(now);
  const start = today - (span - 1);
  const cutoff = start * DAY_MS;
  const [matches, logins, active, regs] = await Promise.all([
    many<{ d: number; n: string }>(
      `SELECT CAST(ts/${DAY_MS} AS INTEGER) AS d, COUNT(*) AS n
         FROM elyxion_audit WHERE event = 'match' AND ts >= $1 GROUP BY d`,
      [cutoff],
    ),
    many<{ d: number; n: string }>(
      `SELECT CAST(ts/${DAY_MS} AS INTEGER) AS d, COUNT(*) AS n
         FROM elyxion_audit WHERE event = 'login' AND ts >= $1 GROUP BY d`,
      [cutoff],
    ),
    many<{ d: number; n: string }>(
      `SELECT CAST(ts/${DAY_MS} AS INTEGER) AS d, COUNT(DISTINCT actor_id) AS n
         FROM elyxion_audit WHERE event IN ('match','login') AND actor_id <> '' AND ts >= $1 GROUP BY d`,
      [cutoff],
    ),
    many<{ d: number; n: string }>(
      `SELECT CAST(created_at/${DAY_MS} AS INTEGER) AS d, COUNT(*) AS n
         FROM elyxion_users WHERE created_at >= $1 GROUP BY d`,
      [cutoff],
    ),
  ]);
  const toMap = (rows: { d: number; n: string }[]): Map<number, number> =>
    new Map(rows.map((r) => [nOf(r.d), nOf(r.n)]));
  const mMap = toMap(matches);
  const lMap = toMap(logins);
  const aMap = toMap(active);
  const rMap = toMap(regs);
  const out: DayPoint[] = [];
  for (let d = start; d <= today; d++) {
    out.push({
      date: dayIndexToISO(d),
      matches: mMap.get(d) ?? 0,
      logins: lMap.get(d) ?? 0,
      registrations: rMap.get(d) ?? 0,
      activePlayers: aMap.get(d) ?? 0,
    });
  }
  return out;
}

// Cohort retention: of the accounts that registered on day D, how many came back
// (a 'match' or 'login') within the next 1 day (D1) and the next 7 days (D7).
// Both windows exclude the registration day itself.
export async function getRetention(days: number, now: number = Date.now()): Promise<{ date: string; size: number; d1: number; d7: number }[]> {
  await dbReady();
  const span = Math.max(1, Math.min(120, Math.floor(days)));
  const cutoff = (dayIndex(now) - (span - 1)) * DAY_MS;
  const rows = await many<{ d: number; size: string; d1: string; d7: string }>(
    `SELECT CAST(u.created_at/${DAY_MS} AS INTEGER) AS d,
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
      WHERE u.created_at >= $1
      GROUP BY d ORDER BY d`,
    [cutoff],
  );
  return rows.map((r) => ({
    date: dayIndexToISO(nOf(r.d)),
    size: nOf(r.size),
    d1: nOf(r.d1),
    d7: nOf(r.d7),
  }));
}

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
export async function getRecentMatches(limit: number, beforeId?: number): Promise<MatchRow[]> {
  await dbReady();
  const n = Math.max(1, Math.min(200, Math.floor(limit)));
  const rows = beforeId && beforeId > 0
    ? await many<Record<string, unknown>>(
        `SELECT id, ts, actor_id, actor_name, detail FROM elyxion_audit
          WHERE event = 'match' AND id < $1 ORDER BY id DESC LIMIT $2`,
        [beforeId, n],
      )
    : await many<Record<string, unknown>>(
        `SELECT id, ts, actor_id, actor_name, detail FROM elyxion_audit
          WHERE event = 'match' ORDER BY id DESC LIMIT $1`,
        [n],
      );
  return rows.map((r) => {
    let d: Record<string, unknown> = {};
    try {
      d = JSON.parse(String(r.detail ?? '{}')) as Record<string, unknown>;
    } catch {
      /* malformed/empty detail → zeros */
    }
    const intOf = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    return {
      id: nOf(r.id),
      ts: nOf(r.ts),
      playerId: String(r.actor_id ?? ''),
      playerName: String(r.actor_name ?? '') || 'Guest',
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

// Searchable player table (?sort=… &q=… &limit=…). ILIKE: Postgres LIKE is
// case-sensitive (SQLite's was not) and the search box expects case-insensitive.
export async function getPlayersTable(opts: {
  sort?: string;
  q?: string;
  limit?: number;
}): Promise<PlayerRow[]> {
  await dbReady();
  const orderBy = PLAYER_SORTS[opts.sort ?? 'recent'] ?? PLAYER_SORTS.recent;
  const limit = Math.max(1, Math.min(500, Math.floor(opts.limit ?? 100)));
  const like = `%${(opts.q ?? '').slice(0, 40)}%`;
  const rows = await many<Record<string, unknown>>(
    `SELECT u.id AS player_id, COALESCE(u.username, s.user_name) AS user_name,
            COALESCE(s.level, 1) AS level, COALESCE(s.total_games, 0) AS total_games,
            COALESCE(s.total_kills, 0) AS total_kills, COALESCE(s.total_deaths, 0) AS total_deaths,
            COALESCE(s.headshots, 0) AS headshots, COALESCE(s.best_accuracy, 0) AS best_accuracy,
            COALESCE(s.total_xp, 0) AS total_xp, COALESCE(s.credits, 0) AS credits,
            COALESCE(s.updated_at, u.created_at) AS updated_at, u.created_at AS created_at,
            COALESCE(u.is_admin, FALSE) AS is_admin, COALESCE(u.is_verified, FALSE) AS is_verified
       FROM elyxion_users u LEFT JOIN elyxion_stats s ON s.player_id = u.id
      WHERE u.username ILIKE $1
      ORDER BY ${orderBy} LIMIT $2`,
    [like, limit],
  );
  return rows.map((r) => ({
    id: String(r.player_id),
    userName: String(r.user_name),
    level: nOf(r.level),
    totalGames: nOf(r.total_games),
    totalKills: nOf(r.total_kills),
    totalDeaths: nOf(r.total_deaths),
    headshots: nOf(r.headshots),
    bestAccuracy: nOf(r.best_accuracy),
    totalXp: nOf(r.total_xp),
    credits: nOf(r.credits),
    kd: round2(nOf(r.total_deaths) > 0 ? nOf(r.total_kills) / nOf(r.total_deaths) : nOf(r.total_kills)),
    lastSeen: nOf(r.updated_at),
    createdAt: nOf(r.created_at),
    admin: r.is_admin === true,
    verified: r.is_verified === true,
  }));
}

// ── Ranked Duel ladder (Elo) ─────────────────────────────────────────────────
// Separate from career stats: a hidden-then-shown Elo rating per account, updated
// only by ranked 1v1 results (server-authoritative). Login-gated, so player_id is
// always a real account id.

const RANKED_BASE_RATING = 1000;
const RANKED_PLACEMENT_GAMES = 5; // below this, rating shows as "provisional"

// Classic Elo K-factor: volatile while provisional, calmer once established, and
// smallest at the top so elite ratings don't swing on a single game.
function kFactor(games: number, rating: number): number {
  if (games < 10) return 40;
  if (rating >= 2100) return 16;
  return 24;
}

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

function mapRankedRow(r: Record<string, unknown>): RankedRow {
  return {
    player_id: String(r.player_id),
    user_name: String(r.user_name),
    rating: nOf(r.rating),
    peak: nOf(r.peak),
    games: nOf(r.games),
    wins: nOf(r.wins),
    losses: nOf(r.losses),
    streak: nOf(r.streak),
    created_at: nOf(r.created_at),
    updated_at: nOf(r.updated_at),
  };
}

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

// Rank = 1 + (ladder players strictly ahead on rating).
async function rankedRankAbove(rating: number): Promise<number> {
  const r = await one<{ n: string }>(
    `SELECT COUNT(*) AS n FROM elyxion_ranked WHERE games > 0 AND rating > $1`,
    [rating],
  );
  return nOf(r?.n);
}

function toRankedProfile(r: RankedRow, rankAbove: number): RankedProfile {
  return {
    id: r.player_id,
    userName: r.user_name,
    rating: r.rating,
    peak: r.peak,
    games: r.games,
    wins: r.wins,
    losses: r.losses,
    streak: r.streak,
    rank: r.games > 0 ? rankAbove + 1 : 0,
    provisional: r.games < RANKED_PLACEMENT_GAMES,
  };
}

// A player's ranked profile (null = never queued ranked). The base rating for a
// brand-new ranked player (so the queue can match on it before their first game).
export async function getRankedProfile(playerId: string): Promise<RankedProfile | null> {
  if (!playerId) return null;
  await dbReady();
  const r = await one<Record<string, unknown>>(
    `SELECT * FROM elyxion_ranked WHERE player_id = $1`,
    [playerId],
  );
  if (!r) return null;
  const row = mapRankedRow(r);
  return toRankedProfile(row, await rankedRankAbove(row.rating));
}

// Current rating for matchmaking — the stored value, or the base for a newcomer.
export async function getRankedRating(playerId: string): Promise<number> {
  if (!playerId) return RANKED_BASE_RATING;
  await dbReady();
  const r = await one<{ rating: number }>(
    `SELECT rating FROM elyxion_ranked WHERE player_id = $1`,
    [playerId],
  );
  return r ? nOf(r.rating) : RANKED_BASE_RATING;
}

export type RankedResult = {
  winner: { id: string; userName: string; rating: number; delta: number; rank: number };
  loser: { id: string; userName: string; rating: number; delta: number; rank: number };
};

// Apply a ranked 1v1 result (server-authoritative). Symmetric Elo: the winner
// gains what the loser sheds, scaled by the upset. `weight` (0..1) damps the
// rating change for a repeat opponent (anti match-fixing); at weight 1 it's a
// normal full-value game. Both rows are created on demand, floored at 100 so a
// rating can't go negative. Serialized under one ladder lock so the read-
// compute-write of both rows can't interleave. Audited as 'ranked.match'.
export async function recordRankedResult(
  winnerId: string,
  winnerName: string,
  loserId: string,
  loserName: string,
  now: number = Date.now(),
  weight: number = 1,
): Promise<RankedResult | null> {
  if (!winnerId || !loserId || winnerId === loserId) return null;
  return withLock('ranked', async () => {
    await dbReady();
    const w8 = Math.max(0, Math.min(1, weight));
    await exec(
      `INSERT INTO elyxion_ranked (player_id, user_name, rating, peak, created_at, updated_at)
       VALUES ($1, $2, ${RANKED_BASE_RATING}, ${RANKED_BASE_RATING}, $3, $3)
       ON CONFLICT (player_id) DO NOTHING`,
      [winnerId, winnerName, now],
    );
    await exec(
      `INSERT INTO elyxion_ranked (player_id, user_name, rating, peak, created_at, updated_at)
       VALUES ($1, $2, ${RANKED_BASE_RATING}, ${RANKED_BASE_RATING}, $3, $3)
       ON CONFLICT (player_id) DO NOTHING`,
      [loserId, loserName, now],
    );
    const wRow = mapRankedRow((await one<Record<string, unknown>>(`SELECT * FROM elyxion_ranked WHERE player_id = $1`, [winnerId]))!);
    const lRow = mapRankedRow((await one<Record<string, unknown>>(`SELECT * FROM elyxion_ranked WHERE player_id = $1`, [loserId]))!);
    const expectedW = 1 / (1 + 10 ** ((lRow.rating - wRow.rating) / 400));
    const dW = Math.round(kFactor(wRow.games, wRow.rating) * (1 - expectedW) * w8);
    const dL = Math.round(kFactor(lRow.games, lRow.rating) * (0 - (1 - expectedW)) * w8);
    const newW = Math.max(100, wRow.rating + dW);
    const newL = Math.max(100, lRow.rating + dL);
    for (const [row, newRating, win, streak] of [
      [wRow, newW, 1, wRow.streak >= 0 ? wRow.streak + 1 : 1] as const,
      [lRow, newL, 0, lRow.streak <= 0 ? lRow.streak - 1 : -1] as const,
    ]) {
      await exec(
        `UPDATE elyxion_ranked
            SET user_name = $2, rating = $3, peak = GREATEST(peak, $3),
                games = games + 1, wins = wins + $4, losses = losses + $5,
                streak = $6, updated_at = $7
          WHERE player_id = $1`,
        [row.player_id, win === 1 ? winnerName : loserName, newRating, win, win === 1 ? 0 : 1, streak, now],
      );
    }
    logEvent({
      event: 'ranked.match',
      actorId: winnerId,
      actorName: winnerName,
      targetId: loserId,
      detail: { winnerRating: newW, loserRating: newL, dW, dL, weight: w8, loser: loserName },
      now,
    });
    return {
      winner: { id: winnerId, userName: winnerName, rating: newW, delta: newW - wRow.rating, rank: (await rankedRankAbove(newW)) + 1 },
      loser: { id: loserId, userName: loserName, rating: newL, delta: newL - lRow.rating, rank: (await rankedRankAbove(newL)) + 1 },
    };
  });
}

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

export async function getRankedLeaderboard(limit: number): Promise<RankedLeaderEntry[]> {
  await dbReady();
  const n = Math.max(1, Math.min(100, Math.floor(limit)));
  const rows = await many<Record<string, unknown>>(
    `SELECT * FROM elyxion_ranked WHERE games > 0 ORDER BY rating DESC, wins DESC LIMIT $1`,
    [n],
  );
  const base: RankedLeaderEntry[] = rows.map((r) => {
    const row = mapRankedRow(r);
    return {
      id: row.player_id,
      userName: row.user_name,
      rating: row.rating,
      games: row.games,
      wins: row.wins,
      losses: row.losses,
      streak: row.streak,
      admin: false,
      verified: false,
    };
  });
  if (base.length) {
    const flags = await many<Record<string, unknown>>(
      `SELECT id, is_admin, is_verified FROM elyxion_users WHERE id IN (${ph(base.length)})`,
      base.map((e) => e.id),
    );
    const byId = new Map(flags.map((f) => [String(f.id), f]));
    for (const e of base) {
      const f = byId.get(e.id);
      if (f) {
        e.admin = f.is_admin === true;
        e.verified = f.is_verified === true;
      }
    }
  }
  return base;
}

// ── Weekly Challenge ─────────────────────────────────────────────────────────
// A weekly leaderboard for the solo SPEEDRUN challenge (8p FFA vs easy bots).
// SPEEDRUN order: anyone who beat the bots to the cap (best_time_ms > 0) ranks
// above anyone who didn't, fastest WIN first; non-winners then rank by most kills.

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

export async function getWeeklyChallengeStats(now: number = Date.now()): Promise<WeeklyChallengeStats> {
  await dbReady();
  const wk = challengeWeekKey(now);
  const [s, r] = await Promise.all([
    one<Record<string, unknown>>(
      `SELECT COUNT(*) AS participants,
              COALESCE(SUM(runs), 0) AS runs,
              COALESCE(SUM(CASE WHEN best_time_ms > 0 THEN 1 ELSE 0 END), 0) AS winners,
              MIN(CASE WHEN best_time_ms > 0 THEN best_time_ms END) AS best_time_ms,
              COALESCE(MAX(best_kills), 0) AS top_kills
         FROM elyxion_weekly_challenge WHERE week_key = $1`,
      [wk],
    ),
    one<Record<string, unknown>>(
      `SELECT COUNT(*) AS n, COALESCE(SUM(raw_bytes), 0) AS bytes FROM elyxion_weekly_replay WHERE week_key = $1`,
      [wk],
    ),
  ]);
  return {
    week: wk,
    participants: nOf(s?.participants),
    runs: nOf(s?.runs),
    winners: nOf(s?.winners),
    bestTimeMs: nOf(s?.best_time_ms),
    topKills: nOf(s?.top_kills),
    replaysStored: nOf(r?.n),
    replayBytes: nOf(r?.bytes),
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

function mapWcRow(r: Record<string, unknown>): WcRow {
  return {
    player_id: String(r.player_id),
    week_key: String(r.week_key),
    user_name: String(r.user_name),
    best_kills: nOf(r.best_kills),
    best_time_ms: nOf(r.best_time_ms),
    runs: nOf(r.runs),
    updated_at: nOf(r.updated_at),
  };
}

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

// Count entries strictly ahead of (timeMs, kills): every winner beats a
// non-winner; among winners the faster one beats; among non-winners more kills
// beats. timeMs <= 0 means the caller is a non-winner.
async function wcRankAbove(weekKeyStr: string, kills: number, timeMs: number): Promise<number> {
  const r = await one<{ n: string }>(
    `SELECT COUNT(*) AS n FROM elyxion_weekly_challenge
      WHERE week_key = $1 AND (
        (best_time_ms > 0 AND ($2 <= 0 OR best_time_ms < $2))
        OR
        (best_time_ms = 0 AND $2 <= 0 AND best_kills > $3)
      )`,
    [weekKeyStr, timeMs, kills],
  );
  return nOf(r?.n);
}

// Record a challenge run, keeping the player's BEST for the week: the fastest
// WINNING time (the speedrun), plus most kills (the fallback for runs that never
// beat the bots). Account-only. Also reports whether THIS run is now the player's
// board-defining run — if so the caller should store its replay. Serialized per
// player so the read-compute-write can't interleave.
export function recordWeeklyChallenge(
  playerId: string,
  userName: string,
  kills: number,
  won: boolean,
  timeMs: number,
  now: number = Date.now(),
): Promise<{ me: WeeklyChallengeMe; acceptReplay: boolean } | null> {
  return withLock(`p:${playerId}`, async () => {
    if (!playerId) return null;
    await dbReady();
    const wk = challengeWeekKey(now);
    await exec(
      `INSERT INTO elyxion_weekly_challenge (player_id, week_key, user_name, updated_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (player_id, week_key) DO NOTHING`,
      [playerId, wk, userName, now],
    );
    const cur = mapWcRow((await one<Record<string, unknown>>(
      `SELECT * FROM elyxion_weekly_challenge WHERE player_id = $1 AND week_key = $2`,
      [playerId, wk],
    ))!);
    const isWin = won && timeMs > 0;
    const bestKills = Math.max(cur.best_kills, kills);
    const bestTimeMs = isWin
      ? cur.best_time_ms > 0
        ? Math.min(cur.best_time_ms, timeMs)
        : timeMs
      : cur.best_time_ms;
    await exec(
      `UPDATE elyxion_weekly_challenge
          SET user_name = $3, best_kills = $4, best_time_ms = $5, runs = runs + 1, updated_at = $6
        WHERE player_id = $1 AND week_key = $2`,
      [playerId, wk, userName, bestKills, bestTimeMs, now],
    );
    const rank = (await wcRankAbove(wk, bestKills, bestTimeMs)) + 1;
    // The board shows a player's fastest win if they've ever won, else their
    // most-kills loss. This run becomes the defining run when it's a new best
    // win, or — for a player who has never won — a new best-kills loss.
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
  });
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

// Player ids with a stored replay this week (for the leaderboard's Watch flag).
async function weeklyReplayPlayerIds(weekKeyStr: string): Promise<Set<string>> {
  const rows = await many<{ player_id: string }>(
    `SELECT player_id FROM elyxion_weekly_replay WHERE week_key = $1`,
    [weekKeyStr],
  );
  return new Set(rows.map((r) => r.player_id));
}

export async function getWeeklyChallengeLeaderboard(
  limit: number,
  now: number = Date.now(),
): Promise<WeeklyChallengeEntry[]> {
  await dbReady();
  const n = Math.max(1, Math.min(100, Math.floor(limit)));
  const wk = challengeWeekKey(now);
  // SPEEDRUN order: winners (best_time_ms > 0) first by fastest time, then by
  // most kills; recency breaks remaining ties.
  const rows = await many<Record<string, unknown>>(
    `SELECT * FROM elyxion_weekly_challenge WHERE week_key = $1
      ORDER BY (CASE WHEN best_time_ms > 0 THEN 0 ELSE 1 END) ASC,
               (CASE WHEN best_time_ms > 0 THEN best_time_ms ELSE 9.0e18 END) ASC,
               best_kills DESC, updated_at ASC LIMIT $2`,
    [wk, n],
  );
  const base = rows.map((r) => toWcEntry(mapWcRow(r)));
  if (base.length) {
    const flags = await many<Record<string, unknown>>(
      `SELECT id, is_admin, is_verified FROM elyxion_users WHERE id IN (${ph(base.length)})`,
      base.map((e) => e.id),
    );
    const byId = new Map(flags.map((f) => [String(f.id), f]));
    const withReplay = await weeklyReplayPlayerIds(wk);
    for (const e of base) {
      const f = byId.get(e.id);
      if (f) {
        e.admin = f.is_admin === true;
        e.verified = f.is_verified === true;
      }
      e.hasReplay = withReplay.has(e.id);
    }
  }
  return base;
}

export async function getWeeklyChallengeMe(
  playerId: string,
  now: number = Date.now(),
): Promise<WeeklyChallengeMe | null> {
  if (!playerId) return null;
  await dbReady();
  const wk = challengeWeekKey(now);
  const r = await one<Record<string, unknown>>(
    `SELECT * FROM elyxion_weekly_challenge WHERE player_id = $1 AND week_key = $2`,
    [playerId, wk],
  );
  if (!r) return null;
  const row = mapWcRow(r);
  const entry = toWcEntry(row);
  entry.hasReplay = (await weeklyReplayPlayerIds(wk)).has(playerId);
  return { ...entry, rank: (await wcRankAbove(wk, row.best_kills, row.best_time_ms)) + 1 };
}

// ── Weekly-challenge REPLAYS ─────────────────────────────────────────────────
// The full recorded run for a player's board-defining run. One row per (player,
// week); overwritten when a player sets a new board-defining run. The blob is
// the gzipped replay-codec binary. Storage is bounded by pruning every week but
// the current one on write.

// Store (gzip) a player's board-defining run for the week, overwriting any prior
// one, and prune replays from previous weeks (keeps the table ~one week deep).
export async function storeWeeklyReplay(
  playerId: string,
  raw: Uint8Array,
  meta: { durationMs: number; kills: number; won: boolean },
  now: number = Date.now(),
): Promise<void> {
  if (!playerId || raw.length === 0) return;
  await dbReady();
  const wk = challengeWeekKey(now);
  const gz = zlib.gzipSync(Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength));
  await exec(
    `INSERT INTO elyxion_weekly_replay
      (player_id, week_key, data, raw_bytes, duration_ms, kills, won, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (player_id, week_key) DO UPDATE SET
       data = EXCLUDED.data, raw_bytes = EXCLUDED.raw_bytes, duration_ms = EXCLUDED.duration_ms,
       kills = EXCLUDED.kills, won = EXCLUDED.won, created_at = EXCLUDED.created_at`,
    [playerId, wk, gz, raw.length, Math.max(0, Math.floor(meta.durationMs)), Math.max(0, Math.floor(meta.kills)), meta.won, now],
  );
  await exec(`DELETE FROM elyxion_weekly_replay WHERE week_key != $1`, [wk]);
}

// Fetch a player's stored run for the week as the on-disk GZIP blob (no server
// gunzip — the endpoint serves it with Content-Encoding: gzip). Returns null if
// absent.
export async function getWeeklyReplayGz(
  playerId: string,
  now: number = Date.now(),
): Promise<{ gz: Buffer; durationMs: number; kills: number; won: boolean } | null> {
  if (!playerId) return null;
  await dbReady();
  const row = await one<Record<string, unknown>>(
    `SELECT data, raw_bytes, duration_ms, kills, won FROM elyxion_weekly_replay
      WHERE player_id = $1 AND week_key = $2`,
    [playerId, challengeWeekKey(now)],
  );
  if (!row) return null;
  return {
    gz: row.data as Buffer,
    durationMs: nOf(row.duration_ms),
    kills: nOf(row.kills),
    won: row.won === true,
  };
}

// ── Temporary shareable replays ──────────────────────────────────────────────
// Every finished match can be uploaded as a short-lived, shareable replay.
// Rows expire after TTL (server sweeper deletes them). The blob is the gzipped
// replay-codec binary; the summary columns let the recap page render the full
// header + standings WITHOUT downloading the blob.

export const TMP_REPLAY_HOURS = 24; // "temporary": share links live a day, then die
const TMP_REPLAY_MAX_ROWS = 5_000; // growth backstop (sweeper also prunes expired)

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
export async function storeTempReplay(t: TempReplayInput): Promise<boolean> {
  try {
    await dbReady();
    const changed = await exec(
      `INSERT INTO elyxion_temp_replays
        (code, data, raw_bytes, map_id, won, duration_ms, runner, stats_json, created_at, expires_at, user_id, mode)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (code) DO NOTHING`,
      [
        t.code,
        t.dataGz,
        t.rawBytes,
        t.mapId,
        t.won,
        Math.max(0, Math.floor(t.durationMs)),
        t.runner.slice(0, 32) || 'Player',
        t.statsJson.slice(0, 64_000),
        t.now,
        t.now + TMP_REPLAY_HOURS * 3600_000,
        t.userId.slice(0, 64),
        t.mode.slice(0, 16),
      ],
    );
    if (changed > 0) {
      await exec(
        `DELETE FROM elyxion_temp_replays WHERE code NOT IN
           (SELECT code FROM elyxion_temp_replays ORDER BY created_at DESC LIMIT $1)`,
        [TMP_REPLAY_MAX_ROWS],
      ).catch(() => undefined);
    }
    return changed > 0;
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

// Active replays belonging to one account, newest first — powers the "My
// replays" page. Blobs are NOT fetched (the page only needs the summary).
export async function listTempReplaysForUser(userId: string, now: number = Date.now()): Promise<MyReplayRow[]> {
  if (!userId) return [];
  await dbReady();
  const rows = await many<Record<string, unknown>>(
    `SELECT code, map_id, mode, won, duration_ms, runner, stats_json, created_at, expires_at
       FROM elyxion_temp_replays WHERE user_id = $1 AND expires_at > $2
      ORDER BY created_at DESC LIMIT 200`,
    [userId, now],
  );
  return rows.map((r) => ({
    code: String(r.code),
    mapId: String(r.map_id),
    mode: String(r.mode),
    won: r.won === true,
    durationMs: nOf(r.duration_ms),
    runner: String(r.runner),
    statsJson: String(r.stats_json),
    createdAt: nOf(r.created_at),
    expiresAt: nOf(r.expires_at),
  }));
}

// Owner-scoped delete: only the account that uploaded a replay may remove it
// (admins can purge via the DB directly). False when the code isn't theirs.
export async function deleteTempReplayForUser(code: string, userId: string): Promise<boolean> {
  if (!userId || !code) return false;
  try {
    await dbReady();
    return (await exec(`DELETE FROM elyxion_temp_replays WHERE code = $1 AND user_id = $2`, [code, userId])) > 0;
  } catch {
    return false;
  }
}

export async function getTempReplayMeta(code: string, now: number = Date.now()): Promise<TempReplayMeta | null> {
  await dbReady();
  const row = await one<Record<string, unknown>>(
    `SELECT map_id, won, duration_ms, runner, stats_json, created_at, expires_at
       FROM elyxion_temp_replays WHERE code = $1`,
    [code],
  );
  if (!row || nOf(row.expires_at) < now) return null;
  let stats = { runner: { kills: 0, deaths: 0, headshots: 0, shots: 0 }, players: [] as TempReplayMeta['stats']['players'] };
  try {
    stats = JSON.parse(String(row.stats_json ?? '{}')) as TempReplayMeta['stats'];
  } catch {
    /* stale/malformed summary → zeros */
  }
  return {
    code,
    mapId: String(row.map_id),
    won: row.won === true,
    durationMs: nOf(row.duration_ms),
    runner: String(row.runner ?? '') || 'Player',
    createdAt: nOf(row.created_at),
    expiresAt: nOf(row.expires_at),
    rawBytes: 0, // filled by getTempReplayBlob when the blob is fetched
    stats,
  };
}

export async function getTempReplayBlob(code: string, now: number = Date.now()): Promise<Buffer | null> {
  await dbReady();
  const row = await one<Record<string, unknown>>(
    `SELECT data FROM elyxion_temp_replays WHERE code = $1 AND expires_at > $2`,
    [code, now],
  );
  return row ? (row.data as Buffer) : null;
}

// Owner-scoped source for the replay editor. The mode travels alongside the blob
// so a saved edit remains grouped with the original match type in My Replays.
export async function getTempReplayBlobForUser(
  code: string,
  userId: string,
  now: number = Date.now(),
): Promise<{ data: Buffer; mode: string } | null> {
  if (!code || !userId) return null;
  await dbReady();
  const row = await one<Record<string, unknown>>(
    `SELECT data, mode FROM elyxion_temp_replays WHERE code = $1 AND user_id = $2 AND expires_at > $3`,
    [code, userId, now],
  );
  return row ? { data: row.data as Buffer, mode: String(row.mode ?? '') } : null;
}

// Expired rows → deleted. Returns how many were removed (0 when idle).
export async function sweepTempReplays(now: number = Date.now()): Promise<number> {
  try {
    await dbReady();
    return await exec(`DELETE FROM elyxion_temp_replays WHERE expires_at < $1`, [now]);
  } catch {
    return 0;
  }
}

export async function deleteTempReplay(code: string): Promise<boolean> {
  try {
    await dbReady();
    return (await exec(`DELETE FROM elyxion_temp_replays WHERE code = $1`, [code])) > 0;
  } catch {
    return false;
  }
}

// ── Server announcements ─────────────────────────────────────────────────────
// Site-wide notices admins post from the dashboard. Served publicly to the
// landing page (menu) until manually deleted or (optionally) expired; rows are
// soft-deleted so removed announcements stay in the audit trail.

export const ANNOUNCEMENT_MAX_LEN = 500; // caps the landing-page strip size

export type Announcement = {
  id: number;
  text: string;
  author: string;
  createdAt: number;
  expiresAt: number; // epoch ms; 0 = never expires
};

const toAnnouncement = (r: Record<string, unknown>): Announcement => ({
  id: nOf(r.id),
  text: String(r.text ?? ''),
  author: String(r.author ?? ''),
  createdAt: nOf(r.created_at),
  expiresAt: nOf(r.expires_at),
});

// Post a new announcement. Returns its id, or null on an empty/oversized body
// (the caller surfaces a 4xx) or a write failure.
export async function createAnnouncement(a: {
  text: string;
  author: string;
  now: number;
  expiresAt: number; // epoch ms; 0 = never
}): Promise<number | null> {
  const text = a.text.trim();
  if (!text || text.length > ANNOUNCEMENT_MAX_LEN) return null;
  try {
    await dbReady();
    return await insertId(
      `INSERT INTO elyxion_announcements (text, author, created_at, expires_at)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [text.slice(0, ANNOUNCEMENT_MAX_LEN), (a.author || 'admin').slice(0, 64), a.now, Math.max(0, Math.floor(a.expiresAt))],
    );
  } catch {
    return null;
  }
}

// All non-deleted announcements, newest first (admin management list — includes
// expired ones so staff can see what lapsed).
export async function listAnnouncements(limit: number = 50): Promise<Announcement[]> {
  try {
    await dbReady();
    const rows = await many<Record<string, unknown>>(
      `SELECT id, text, author, created_at, expires_at, deleted FROM elyxion_announcements
        WHERE deleted = FALSE ORDER BY created_at DESC LIMIT $1`,
      [limit],
    );
    return rows.map(toAnnouncement);
  } catch {
    return [];
  }
}

// Announcements currently shown to players (non-deleted, not yet expired),
// newest first — the public landing-page feed.
export async function listActiveAnnouncements(now: number = Date.now()): Promise<Announcement[]> {
  try {
    await dbReady();
    const rows = await many<Record<string, unknown>>(
      `SELECT id, text, author, created_at, expires_at, deleted FROM elyxion_announcements
        WHERE deleted = FALSE AND (expires_at = 0 OR expires_at > $1) ORDER BY created_at DESC LIMIT 20`,
      [now],
    );
    return rows.map(toAnnouncement);
  } catch {
    return [];
  }
}

// Soft-delete an announcement (hidden from the landing page immediately; the
// row is kept for the audit trail). False when the id is missing/gone.
export async function deleteAnnouncement(id: number): Promise<boolean> {
  try {
    await dbReady();
    return (
      (await exec(`UPDATE elyxion_announcements SET deleted = TRUE WHERE id = $1 AND deleted = FALSE`, [id])) > 0
    );
  } catch {
    return false;
  }
}
