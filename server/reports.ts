import { Pool } from 'pg';
import { Router, type Request } from 'express';
import { accountId, ensureGuestId, guestId } from './auth';
import { findUserById } from './db';

// Player reports are kept in PostgreSQL so they remain available independently
// from the legacy SQLite store. DATABASE_URL is supplied through runtime env.
const databaseUrl = process.env.DATABASE_URL?.trim();
const pool = databaseUrl
  ? new Pool({
      connectionString: databaseUrl,
      ssl: databaseUrl.includes('supabase.co') ? { rejectUnauthorized: false } : undefined,
      max: 5,
      idleTimeoutMillis: 30_000,
    })
  : null;

let schemaReady: Promise<void> | null = null;
function ensureSchema(): Promise<void> {
  if (!pool) return Promise.reject(new Error('DATABASE_URL is not configured'));
  schemaReady ??= pool
    .query(`
      CREATE TABLE IF NOT EXISTS elyxion_player_reports (
        id            BIGSERIAL PRIMARY KEY,
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
    `)
    .then(() => undefined);
  return schemaReady;
}

const RATE_WINDOW_MS = 10 * 60_000;
const RATE_MAX_POSTS = 6;
const postHits = new Map<string, number[]>();
function allowPost(identity: string, now: number): boolean {
  const cutoff = now - RATE_WINDOW_MS;
  const recent = (postHits.get(identity) ?? []).filter((ts) => ts > cutoff);
  if (recent.length >= RATE_MAX_POSTS) {
    postHits.set(identity, recent);
    return false;
  }
  recent.push(now);
  postHits.set(identity, recent);
  return true;
}
setInterval(() => {
  const cutoff = Date.now() - RATE_WINDOW_MS;
  for (const [id, hits] of postHits) {
    if (hits.length === 0 || hits[hits.length - 1] <= cutoff) postHits.delete(id);
  }
}, RATE_WINDOW_MS).unref?.();

const REPORT_REASONS = ['cheating', 'harassment', 'inappropriate_name', 'griefing', 'other'] as const;
type ReportReason = (typeof REPORT_REASONS)[number];
const NAME_MAX = 32;
const DETAILS_MAX = 2000;
const ID_MAX = 64;

function asReason(value: unknown): ReportReason | null {
  return typeof value === 'string' && REPORT_REASONS.includes(value as ReportReason)
    ? (value as ReportReason)
    : null;
}
function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}
function identity(req: Request): string {
  return accountId(req) || guestId(req) || req.ip || 'unknown';
}

export const reportsRouter = Router();

reportsRouter.post('/reports', async (req, res) => {
  const now = Date.now();
  if (!pool) {
    res.status(503).json({ error: 'reports_unavailable' });
    return;
  }
  const rateKey = identity(req);
  if (!allowPost(rateKey, now)) {
    res.status(429).json({ error: 'rate_limited' });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const targetId = text(body.targetId, ID_MAX);
  const targetName = text(body.targetName, NAME_MAX);
  const reason = asReason(body.reason);
  const details = text(body.details, DETAILS_MAX);
  if (!targetId || !targetName || !reason) {
    res.status(400).json({ error: 'bad_report' });
    return;
  }

  const reporterId = accountId(req) || ensureGuestId(req, res);
  const account = reporterId ? findUserById(reporterId) : null;
  const reporterName = account?.username || 'Guest';

  try {
    await ensureSchema();
    const result = await pool.query<{ id: string }>(
      `INSERT INTO elyxion_player_reports
        (reporter_id, reporter_name, target_id, target_name, reason, details, ip, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        reporterId,
        reporterName,
        targetId,
        targetName,
        reason,
        details,
        (req.ip ?? '').slice(0, 64),
        (req.get('user-agent') ?? '').slice(0, 256),
      ],
    );
    res.json({ ok: true, id: result.rows[0]?.id ?? '' });
  } catch (err) {
    console.error('[reports] submit failed', err);
    res.status(500).json({ error: 'server_error' });
  }
});
