// Admin / moderation + metrics API. Mounted at /api/admin. Two ways to authorize:
//   1) a logged-in session whose account has is_admin = 1 (designate admins via
//      the ADMIN_USERNAMES env var — see server/auth.ts). The browser dashboard /
//      mod-tool path; can do everything.
//   2) a bearer token equal to the ADMIN_API_TOKEN env var (Authorization: Bearer
//      <token>, or an X-Admin-Token header). The headless/script/agent path for
//      pulling metrics + traffic. READ-ONLY: state-changing routes (verify/grant)
//      reject token auth and require a real session, so a leaked read token can
//      never mutate accounts. If ADMIN_API_TOKEN is unset, token auth is disabled
//      entirely (session-only). All mutations are audit-logged.

import { timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { Router, type Request, type Response, type NextFunction } from 'express';
import { accountId } from './auth';
import {
  FEEDBACK_STATUSES,
  feedbackCounts,
  feedbackTypeCounts,
  findAccountByName,
  findUserById,
  getAuditLog,
  getMetricsOverview,
  getMetricsTimeseries,
  getPlayersTable,
  getRecentMatches,
  getRetention,
  getWeeklyChallengeStats,
  listFeedback,
  logEvent,
  setAdmin,
  setFeedbackStatus,
  setVerified,
  type AccountInfo,
  type FeedbackStatus,
} from './db';
import { WEEKLY_CHALLENGE_FRAG_LIMIT, WEEKLY_CHALLENGE_MAP } from '../src/game/constants';
import { sendPortalZip } from './portal-zip';

// App version for the portal README metadata (overridable via env for CI).
const APP_VERSION = (process.env.APP_VERSION ?? '').trim() || '1.0.0';

export const adminRouter = Router();

type AdminVia = 'session' | 'token';
type AdminRequest = Request & { admin: AccountInfo; adminVia: AdminVia };

// Live concurrency source. The WS layer owns the real counts; index.ts injects
// them via setLiveCountsSource after attaching the socket. Default zeros so the
// report is well-formed even before the socket attaches.
type LiveCounts = {
  online: number;
  inMatch: number;
  rooms: number;
  loopLagMs: number;
  loopLagMaxMs: number;
};
let liveSource: () => LiveCounts = () => ({
  online: 0,
  inMatch: 0,
  rooms: 0,
  loopLagMs: 0,
  loopLagMaxMs: 0,
});
export function setLiveCountsSource(fn: () => LiveCounts): void {
  liveSource = fn;
}

const API_TOKEN = process.env.ADMIN_API_TOKEN || '';
export const adminApiTokenEnabled = API_TOKEN.length > 0;

// Constant-time check of the request's bearer/header token against ADMIN_API_TOKEN.
// Disabled (always false) when no token is configured.
function tokenOk(req: Request): boolean {
  if (!API_TOKEN) return false;
  const auth = req.get('authorization') ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  const provided = m ? m[1].trim() : (req.get('x-admin-token') ?? '').trim();
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(API_TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Synthetic identity for a token caller (never used to mutate — denyToken blocks
// that — so it never lands in an audit row).
const TOKEN_ADMIN: AccountInfo = { id: 'api-token', username: 'api-token', isAdmin: true, isVerified: false };

// The current request's admin account, or null if the caller isn't an admin.
function currentAdmin(req: Request): AccountInfo | null {
  const id = accountId(req);
  if (!id) return null;
  const u = findUserById(id);
  return u?.isAdmin ? u : null;
}

const requireAdmin = (req: Request, res: Response, next: NextFunction) => {
  const admin = currentAdmin(req);
  if (admin) {
    (req as AdminRequest).admin = admin;
    (req as AdminRequest).adminVia = 'session';
    next();
    return;
  }
  if (tokenOk(req)) {
    (req as AdminRequest).admin = TOKEN_ADMIN;
    (req as AdminRequest).adminVia = 'token';
    next();
    return;
  }
  res.status(403).json({ error: 'forbidden' });
};
adminRouter.use(requireAdmin);

// Guard for state-changing routes: a read-only API token may not mutate — only a
// real logged-in admin session can. Returns true (and responds 403) when blocked.
function denyToken(req: Request, res: Response): boolean {
  if ((req as AdminRequest).adminVia === 'token') {
    res.status(403).json({ error: 'session_required' });
    return true;
  }
  return false;
}

const cleanUsername = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

// Set/clear a player's verified blue-check (Krunker-style), by username.
adminRouter.post('/verify', (req, res) => {
  if (denyToken(req, res)) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const target = findAccountByName(cleanUsername(body.username).toLowerCase());
  if (!target) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const value = body.verified !== false; // default true
  setVerified(target.id, value);
  const admin = (req as AdminRequest).admin;
  logEvent({
    event: value ? 'admin.verify' : 'admin.unverify',
    actorId: admin.id,
    actorName: admin.username,
    targetId: target.id,
    detail: { username: target.username },
    ip: req.ip,
  });
  res.json({ ok: true, username: target.username, verified: value });
});

// Promote/demote an admin, by username.
adminRouter.post('/grant', (req, res) => {
  if (denyToken(req, res)) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const target = findAccountByName(cleanUsername(body.username).toLowerCase());
  if (!target) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const value = body.admin !== false; // default true
  setAdmin(target.id, value);
  const admin = (req as AdminRequest).admin;
  logEvent({
    event: value ? 'admin.grant' : 'admin.revoke',
    actorId: admin.id,
    actorName: admin.username,
    targetId: target.id,
    detail: { username: target.username },
    ip: req.ip,
  });
  res.json({ ok: true, username: target.username, admin: value });
});

// Look up a player's current flags so the admin UI can show/toggle state.
adminRouter.get('/lookup', (req, res) => {
  const target = findAccountByName(cleanUsername(req.query.username).toLowerCase());
  if (!target) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  res.json({ username: target.username, admin: target.isAdmin, verified: target.isVerified });
});

// Update a player feedback row's moderation status (open → ack → resolved /
// spam). Session-only: a read-only token may not mutate. Audit-logged.
adminRouter.post('/feedback/:id/status', (req, res) => {
  if (denyToken(req, res)) return;
  const id = parseInt(req.params.id, 10);
  const body = (req.body ?? {}) as Record<string, unknown>;
  const status = typeof body.status === 'string' ? body.status : '';
  if (!Number.isFinite(id) || id <= 0) {
    res.status(400).json({ error: 'bad_id' });
    return;
  }
  if (!(FEEDBACK_STATUSES as readonly string[]).includes(status)) {
    res.status(400).json({ error: 'bad_status' });
    return;
  }
  if (!setFeedbackStatus(id, status as FeedbackStatus)) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const admin = (req as unknown as AdminRequest).admin;
  logEvent({
    event: 'admin.feedback_status',
    actorId: admin.id,
    actorName: admin.username,
    targetId: String(id),
    detail: { status },
    ip: req.ip,
  });
  res.json({ ok: true, id, status });
});

// Recent audit events for moderation review / the future metrics dashboard.
// Optional ?event= filter and ?limit= (clamped server-side).
adminRouter.get('/audit', (req, res) => {
  const rawLimit = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : 100;
  const event =
    typeof req.query.event === 'string' && req.query.event ? req.query.event : undefined;
  res.json({ events: getAuditLog(Number.isFinite(rawLimit) ? rawLimit : 100, event) });
});

// ── Metrics dashboard (read-only aggregates) ─────────────────────────────────
// All gated by requireAdmin (router-level). The dashboard at /admin renders these.
const intParam = (v: unknown, fallback: number): number => {
  const n = typeof v === 'string' ? parseInt(v, 10) : NaN;
  return Number.isFinite(n) ? n : fallback;
};

// Headline KPIs + 24h/7d/30d activity windows + live concurrency.
adminRouter.get('/metrics/overview', (_req, res) => {
  res.json({ overview: getMetricsOverview() });
});

// Dense daily series (matches / logins / registrations / active players).
adminRouter.get('/metrics/timeseries', (req, res) => {
  res.json({ series: getMetricsTimeseries(intParam(req.query.days, 30)) });
});

// D1/D7 cohort retention by registration day.
adminRouter.get('/metrics/retention', (req, res) => {
  res.json({ cohorts: getRetention(intParam(req.query.days, 14)) });
});

// Recent recorded matches, keyset-paginated by audit id (?before=<lastId>).
adminRouter.get('/metrics/matches', (req, res) => {
  const before = intParam(req.query.before, 0);
  res.json({ matches: getRecentMatches(intParam(req.query.limit, 50), before > 0 ? before : undefined) });
});

// Searchable player table (?sort=kills|games|level|accuracy|xp|recent &q=&limit=).
adminRouter.get('/metrics/players', (req, res) => {
  const sort = typeof req.query.sort === 'string' ? req.query.sort : undefined;
  const q = typeof req.query.q === 'string' ? req.query.q : undefined;
  res.json({ players: getPlayersTable({ sort, q, limit: intParam(req.query.limit, 100) }) });
});

// Live concurrency right now (online players / players in a match / open rooms).
// /api/live is the public version; this mirrors it inside the token-gated API.
adminRouter.get('/metrics/live', (_req, res) => {
  res.json({ live: liveSource() });
});

// Player-submitted feedback / bug reports, newest first, keyset-paginated by id
// (?before=<lastId>); optional ?status= and ?type= (bug/feature/general)
// filters. Read-only (token or session).
adminRouter.get('/metrics/feedback', (req, res) => {
  const before = intParam(req.query.before, 0);
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  const type = typeof req.query.type === 'string' ? req.query.type : undefined;
  res.json({
    feedback: listFeedback({
      limit: intParam(req.query.limit, 50),
      beforeId: before > 0 ? before : undefined,
      status,
      type,
    }),
    counts: feedbackCounts(),
    typeCounts: feedbackTypeCounts(),
  });
});

// Weekly-challenge participation this week (+ the fixed run params).
adminRouter.get('/metrics/weekly', (_req, res) => {
  res.json({
    weekly: { ...getWeeklyChallengeStats(), map: WEEKLY_CHALLENGE_MAP, fragLimit: WEEKLY_CHALLENGE_FRAG_LIMIT },
  });
});

// Tally a recent slice of matches by game mode + online/offline split — a cheap
// "what's actually being played" read for the report (mode lives in match audit
// detail; historical rows without it fall under 'unknown').
function modeBreakdown(limit: number) {
  const rows = getRecentMatches(limit);
  const byMode: Record<string, number> = {};
  let online = 0;
  let offline = 0;
  for (const m of rows) {
    const mode = m.mode ?? 'unknown';
    byMode[mode] = (byMode[mode] ?? 0) + 1;
    if (m.offline) offline += 1;
    else online += 1;
  }
  return { sampled: rows.length, byMode, online, offline };
}

// One-call consolidated snapshot for analysis/agents: KPIs + live concurrency +
// recent daily traffic + what's being played + the weekly challenge. Everything a
// dashboard or an agent needs in a single GET. `days` (default 14) sizes the
// timeseries; `sample` (default 200, max 200) sizes the mode tally.
adminRouter.get('/metrics/report', (req, res) => {
  const days = intParam(req.query.days, 14);
  const sample = intParam(req.query.sample, 200);
  res.json({
    generatedAt: Date.now(),
    via: (req as AdminRequest).adminVia,
    live: liveSource(),
    overview: getMetricsOverview(),
    timeseries: getMetricsTimeseries(days),
    recentModeBreakdown: modeBreakdown(sample),
    weekly: { ...getWeeklyChallengeStats(), map: WEEKLY_CHALLENGE_MAP, fragLimit: WEEKLY_CHALLENGE_FRAG_LIMIT },
  });
});

// ── Portal distribution zip ─────────────────────────────────────────────────
// Streams the production static build (dist/) as a downloadable ZIP so the
// admin can hand the bundle to other gaming portals (CrazyGames, Poki, itch,
// Kongregate…). Session-gated (denyToken: no bearer-token downloads) and
// audit-logged since it exfiltrates the whole build. Only files under dist/
// are archived; the README travels inside the archive as PORTAL-README.txt
// (never written to disk), so no path-controlled content can be smuggled in.
adminRouter.get('/portal-zip', async (req, res) => {
  if (denyToken(req, res)) return;
  const distDir = path.join(process.cwd(), 'dist');
  const stamp = new Date().toISOString().slice(0, 10);
  const readme = [
    'Elyxion — static game bundle for portal distribution',
    `Version: ${APP_VERSION} · Packaged: ${stamp}`,
    '',
    'WHAT THIS IS',
    '  The production web build (HTML + JS + assets). Upload the contents',
    '  as-is to any static host or portal that accepts an HTML5 game upload',
    '  (CrazyGames, Poki, itch.io, Kongregate, GameDistribution…).',
    '',
    'HOW TO SERVE IT',
    '  · Host the extracted files at the ROOT of a domain/subdomain (not a',
    '    subdirectory) — the game resolves its assets relative to the site root.',
    '  · HTTPS is required. Serve index.html for all unknown paths (SPA).',
    '  · No server-side code is needed to serve the game itself.',
    '',
    'BACKEND / MULTIPLAYER',
    '  Accounts, progression, leaderboards, chat and multiplayer run on the',
    '  developer backend. The bundle works standalone (offline play vs bots)',
    '  and automatically connects to the backend for online play.',
    '',
    'PORTAL-SPECIFIC NOTES',
    '  · CrazyGames: submit the zip at developer.crazygames.com. The build',
    '    already integrates the CrazyGames SDK (ads, happytime, invites,',
    '    gameplay events) and activates on their domain automatically.',
    '  · Other portals: the bundle detects it is not on CrazyGames and skips',
    '    their SDK; everything else behaves identically.',
    '  · Cross-origin backends: the game reads its backend address from the',
    '    ?api= URL parameter or localStorage (key "elyxion-api-base") so one',
    '    build can serve many portals without rebuilding. Add',
    '    ?api=https://your-backend.example.com to the portal launch URL if the',
    '    game must reach a different backend than its host origin.',
    '',
    'SUPPORT',
    '  Contact the developer for portal-specific builds, sandbox keys or',
    '  embed-origin allowlisting (needed for cross-origin iframe hosting).',
  ].join('\n');
  logEvent({
    event: 'admin_portal_zip_downloaded',
    actorId: (req as AdminRequest).admin.id,
    actorName: (req as AdminRequest).admin.username,
    detail: 'production build archive',
  });
  const result = sendPortalZip(res, {
    distDir,
    name: `elyxion-portal-${stamp}.zip`,
    ver: APP_VERSION,
    readme,
  });
  if (!result.ok) {
    const missing = result.error === 'build_missing';
    res.status(missing ? 404 : 500).json({ error: missing ? 'build_missing' : 'zip_failed' });
    return;
  }
  // Keep the request alive until the archive has fully flushed to the socket
  // (the download response only completes when the zip is fully written).
  await result.done;
});
