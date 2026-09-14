// Player feedback / bug reports. The in-game form (FeedbackModal) POSTs here; the
// admin panel reads them back via /api/admin/metrics/feedback. Guests may submit
// (identity = '' like the stats API). This is free-text shown only to admins — it
// is never trusted or rendered to other players — so the guard rails are just
// length caps + a tight rate limit to blunt spam.

import { Router, type Request } from 'express';
import { accountId } from './auth';
import { FEEDBACK_TYPES, findUserById, logEvent, submitFeedback, type FeedbackType } from './db';

export const feedbackRouter = Router();

// --- POST rate limiter (mirrors server/stats.ts) ----------------------------
// Human-typed feedback is low-volume, so the cap is tight: a handful per window
// per identity (the cookie account when present, else the client IP).
const RATE_WINDOW_MS = 10 * 60_000; // rolling 10 min
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

// Periodic sweep so identities that stop posting don't linger in the map.
const rateSweep = setInterval(() => {
  const cutoff = Date.now() - RATE_WINDOW_MS;
  for (const [id, hits] of postHits) {
    if (hits.length === 0 || hits[hits.length - 1] <= cutoff) postHits.delete(id);
  }
}, RATE_WINDOW_MS);
rateSweep.unref?.();

const TITLE_MIN = 3;
const TITLE_MAX = 120;
const BODY_MIN = 10;
const BODY_MAX = 4000;

function asType(v: unknown): FeedbackType | null {
  return typeof v === 'string' && (FEEDBACK_TYPES as readonly string[]).includes(v)
    ? (v as FeedbackType)
    : null;
}

function str(req: Request, ...keys: string[]): string {
  const body = (req.body ?? {}) as Record<string, unknown>;
  for (const k of keys) {
    const v = body[k];
    if (typeof v === 'string') return v.trim();
  }
  return '';
}

feedbackRouter.post('/feedback', (req, res) => {
  const now = Date.now();
  const id = accountId(req);
  const rateKey = id || req.ip || 'unknown';
  if (!allowPost(rateKey, now)) {
    res.status(429).json({ error: 'rate_limited' });
    return;
  }

  const type = asType((req.body as Record<string, unknown>)?.type);
  const title = str(req, 'title');
  const text = str(req, 'body', 'description', 'message');

  if (!type) {
    res.status(400).json({ error: 'bad_type' });
    return;
  }
  if (title.length < TITLE_MIN || title.length > TITLE_MAX) {
    res.status(400).json({ error: 'bad_title' });
    return;
  }
  if (text.length < BODY_MIN || text.length > BODY_MAX) {
    res.status(400).json({ error: 'bad_body' });
    return;
  }

  // Display name: trust the account username when logged in; otherwise the
  // client-supplied name (cosmetic only); otherwise Guest.
  const account = id ? findUserById(id) : null;
  const playerName = account?.username || str(req, 'name').slice(0, 32) || 'Guest';

  const newId = submitFeedback({
    playerId: id,
    playerName,
    type,
    title,
    body: text,
    ip: req.ip,
    userAgent: (req.get('user-agent') ?? '').slice(0, 256),
    now,
  });
  if (!newId) {
    res.status(500).json({ error: 'server_error' });
    return;
  }

  logEvent({
    event: 'feedback.submitted',
    actorId: id,
    actorName: playerName,
    targetId: String(newId),
    detail: { type, title },
    ip: req.ip,
    now,
  });

  res.json({ ok: true, id: newId });
});

// ── Player reports (moderation queue) ───────────────────────────────────────
// In-game "report player" action → POST /api/report. Same guard rails as
// feedback: length caps + a tight per-identity rate limit. Read back by mods
// in the /admin Moderation tab.
import {
  REPORT_REASONS,
  findAccountByName,
  submitPlayerReport,
  type ReportReason,
} from './db';

const REPORT_WINDOW_MS = 10 * 60_000;
const REPORT_MAX = 8; // per identity per window — genuine grievances, spam-blunt
const reportHits = new Map<string, number[]>();
function allowReport(identity: string, now: number): boolean {
  const cutoff = now - REPORT_WINDOW_MS;
  const recent = (reportHits.get(identity) ?? []).filter((ts) => ts > cutoff);
  if (recent.length >= REPORT_MAX) {
    reportHits.set(identity, recent);
    return false;
  }
  recent.push(now);
  reportHits.set(identity, recent);
  return true;
}
const reportSweep = setInterval(() => {
  const cutoff = Date.now() - REPORT_WINDOW_MS;
  for (const [id, hits] of reportHits) {
    if (hits.length === 0 || hits[hits.length - 1] <= cutoff) reportHits.delete(id);
  }
}, REPORT_WINDOW_MS);
reportSweep.unref?.();

feedbackRouter.post('/report', (req, res) => {
  const now = Date.now();
  const reporterId = accountId(req);
  if (!allowReport(reporterId || req.ip || 'unknown', now)) {
    res.status(429).json({ error: 'rate_limited' });
    return;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const targetName = typeof body.targetName === 'string' ? body.targetName.trim().slice(0, 32) : '';
  if (!targetName) {
    res.status(400).json({ error: 'bad_target' });
    return;
  }
  const reason = (REPORT_REASONS as readonly string[]).includes(String(body.reason))
    ? (body.reason as ReportReason)
    : 'other';
  const detail = typeof body.detail === 'string' ? body.detail.trim().slice(0, 1000) : '';
  const roomId = typeof body.roomId === 'string' ? body.roomId.trim().slice(0, 16) : '';
  // Resolve the target's account id when the name matches a registered account,
  // so mods can ban directly from the report without re-searching.
  const target = findAccountByName(targetName.toLowerCase());
  const reporter = reporterId ? findAccountByName(reporterId) : undefined;
  const id = submitPlayerReport({
    reporterId,
    reporterName: reporter?.username ?? 'Guest',
    targetId: target?.id ?? '',
    targetName,
    reason,
    detail,
    roomId,
    now,
  });
  if (id === 0) {
    res.status(500).json({ error: 'failed' });
    return;
  }
  logEvent({
    event: 'report.submit',
    actorId: reporterId,
    actorName: reporter?.username,
    targetId: target?.id,
    detail: { reportId: id, target: targetName, reason },
    ip: req.ip,
  });
  res.json({ ok: true, id });
});
