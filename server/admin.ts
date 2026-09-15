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
  applyAdminProgressionDelta,
  applyAdminProgressionPatch,
  getAdminPlayerProgression,
  type AdminProgressionPatch,
  getRetention,
  getWeeklyChallengeStats,
  listFeedback,
  listPlayerReports,
  listStaff,
  logEvent,
  playerReportCounts,
  setAdmin,
  setFeedbackStatus,
  setPlayerReportStatus,
  setRole,
  setVerified,
  roleRank,
  type AccountInfo,
  type FeedbackStatus,
  type ReportStatus,
  type StaffRole,
} from './db';
import { WEEKLY_CHALLENGE_FRAG_LIMIT, WEEKLY_CHALLENGE_MAP } from '../src/game/constants';
import { sendPortalZip } from './portal-zip';
import {
  getActiveBan,
  issueBan,
  liftBan,
  listActiveBans,
  listBanHistory,
  listPlayerViolations,
  listRecentViolations,
  getBanEvidence,
  attachBanEvidence,
  decideAppeal,
  getAppealById,
  listAllAppeals,
  listOpenAppeals,
} from './bans';
import { getWeeklyReplayGz } from './db';

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

// Socket-drop hook for freshly banned players. index.ts injects the game
// server's closer after the WS layer attaches; null until then (and absent
// in contexts without the game socket).
let dropSockets: ((playerId: string, reason: string) => void) | null = null;
export function setBanSocketDropper(fn: (playerId: string, reason: string) => void): void {
  dropSockets = fn;
}
function dropPlayerSockets(playerId: string, reason: string): void {
  dropSockets?.(playerId, reason);
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
const TOKEN_ADMIN: AccountInfo = { id: 'api-token', username: 'api-token', isAdmin: true, isVerified: false, role: 'admin' };

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

// Role tiers: 'admin' = full dashboard; 'mod' = moderation panel (bans,
// reports, anticheat feed); 'jrmod' = reports queue + watch only. The base
// requireAdmin above still admits any staff tier plus the API token.
function callerRole(req: Request): StaffRole {
  const admin = (req as unknown as AdminRequest).admin;
  return admin && admin.id !== 'api-token' ? admin.role : 'admin';
}
const requireRole = (min: StaffRole) => (req: Request, res: Response, next: NextFunction) => {
  if (roleRank(callerRole(req)) >= roleRank(min)) return next();
  res.status(403).json({ error: 'insufficient_role' });
};

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

// ── Player account management ────────────────────────────────────────────────
// Direct edits to a player's progression: XP/level/credits and career stat
// counters. Session-only (denyToken) and every mutation is audit-logged with
// the before/after values so mistakes are traceable and reversible by hand.

adminRouter.get('/player/:username', (req, res) => {
  const target = findAccountByName(cleanUsername(req.params.username).toLowerCase());
  if (!target) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const prog = getAdminPlayerProgression(target.id);
  if (!prog) {
    res.status(404).json({ error: 'no_progression' });
    return;
  }
  res.json({
    id: target.id,
    username: target.username,
    isAdmin: target.isAdmin,
    isVerified: target.isVerified,
    ...prog,
  });
});

// Apply a partial patch to a player's progression. Only whitelisted fields are
// accepted; values are clamped to sane ranges; XP changes recompute the level
// server-side (level is derived, never stored raw). Audit-logged.
adminRouter.post('/player/:username', (req, res) => {
  if (denyToken(req, res)) return;
  const target = findAccountByName(cleanUsername(req.params.username).toLowerCase());
  if (!target) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const patch: AdminProgressionPatch = {};

  const num = (v: unknown): number | null => {
    const n = Math.floor(Number(v));
    return Number.isFinite(n) && n >= 0 ? n : null;
  };

  if ('totalXp' in body) {
    const v = num(body.totalXp);
    if (v === null || v > 1_000_000_000) {
      res.status(400).json({ error: 'bad_value', field: 'totalXp' });
      return;
    }
    patch.totalXp = v;
  }
  if ('credits' in body) {
    const v = num(body.credits);
    if (v === null || v > 100_000_000) {
      res.status(400).json({ error: 'bad_value', field: 'credits' });
      return;
    }
    patch.credits = v;
  }
  if ('totalKills' in body) {
    const v = num(body.totalKills);
    if (v === null || v > 10_000_000) {
      res.status(400).json({ error: 'bad_value', field: 'totalKills' });
      return;
    }
    patch.totalKills = v;
  }
  if ('totalDeaths' in body) {
    const v = num(body.totalDeaths);
    if (v === null || v > 10_000_000) {
      res.status(400).json({ error: 'bad_value', field: 'totalDeaths' });
      return;
    }
    patch.totalDeaths = v;
  }
  if ('totalGames' in body) {
    const v = num(body.totalGames);
    if (v === null || v > 1_000_000) {
      res.status(400).json({ error: 'bad_value', field: 'totalGames' });
      return;
    }
    patch.totalGames = v;
  }
  if (Object.keys(patch).length === 0) {
    res.status(400).json({ error: 'no_fields' });
    return;
  }

  const result = applyAdminProgressionPatch(target.id, patch);
  if (!result) {
    res.status(404).json({ error: 'no_progression' });
    return;
  }
  const admin = (req as unknown as AdminRequest).admin;
  logEvent({
    event: 'admin.player_edit',
    actorId: admin.id,
    actorName: admin.username,
    targetId: target.id,
    detail: { target: target.username, patch, before: result.before },
    ip: req.ip,
  });
  res.json({ ok: true, username: target.username, ...result.after });
});

// Grant (or revoke) credits/XP as a DELTA rather than an absolute set — the
// friendlier action for rewards/compensation. Audit-logged with the delta.
adminRouter.post('/player/:username/grant', (req, res) => {
  if (denyToken(req, res)) return;
  const target = findAccountByName(cleanUsername(req.params.username).toLowerCase());
  if (!target) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const xp = Math.floor(Number(body.xp));
  const credits = Math.floor(Number(body.credits));
  if (!Number.isFinite(xp) && !Number.isFinite(credits)) {
    res.status(400).json({ error: 'no_fields' });
    return;
  }
  const clampDelta = (n: number, max: number) => Math.max(-max, Math.min(max, Math.floor(n)));
  const result = applyAdminProgressionDelta(target.id, {
    xp: Number.isFinite(xp) ? clampDelta(xp, 1_000_000_000) : 0,
    credits: Number.isFinite(credits) ? clampDelta(credits, 100_000_000) : 0,
  });
  if (!result) {
    res.status(404).json({ error: 'no_progression' });
    return;
  }
  const admin = (req as unknown as AdminRequest).admin;
  logEvent({
    event: 'admin.player_grant',
    actorId: admin.id,
    actorName: admin.username,
    targetId: target.id,
    detail: { target: target.username, xp, credits },
    ip: req.ip,
  });
  res.json({ ok: true, username: target.username, ...result.after });
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
  //
  // Backend-origin stamp: the bundle must know where accounts / multiplayer /
  // leaderboards live when it is NOT served from the backend's own origin
  // (itch, Poki, any portal CDN). APP_BASE_URL is authoritative; otherwise
  // fall back to the request's own scheme+host (trust proxy is on, so the
  // reverse proxy's X-Forwarded-Proto/Host are honored). The stamp rides in
  // the shell as a meta tag, applied in-memory by the zip writer.
  let backendOrigin = '';
  const cfgBase = (process.env.APP_BASE_URL ?? '').trim();
  if (cfgBase) {
    try {
      backendOrigin = new URL(cfgBase).origin;
    } catch {
      backendOrigin = '';
    }
  }
  if (!backendOrigin) {
    const host = req.get('host') ?? '';
    if (host) {
      // Behind the local proxy in dev the request may be plain http; anything
      // else is treated as public https.
      const proto = req.protocol === 'http' && /^(localhost|127\.)/.test(host) ? 'http' : 'https';
      backendOrigin = `${proto}://${host}`;
    }
  }
  const indexHtmlTransform = backendOrigin
    ? (html: string) =>
        html.replace(
          '</head>',
          `    <meta name="elyxion-backend" content="${backendOrigin}">\n</head>`,
        )
    : undefined;
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
    '  · Works at any hosting depth: a domain root OR a subdirectory (itch.io',
    '    style per-game paths). Assets are referenced relatively.',
    '  · HTTPS is required. Serve index.html for all unknown paths (SPA).',
    '  · No server-side code is needed to serve the game itself.',
    '',
    '  · Accounts, progression, leaderboards, chat and multiplayer run on the',
    `  developer backend${backendOrigin ? ` (${backendOrigin})` : ''}. The bundle`,
    '  works standalone (offline play vs bots) and automatically connects to',
    '  the backend for online play — no manual configuration needed.',
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
    indexHtmlTransform,
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


// ── Anticheat & bans ──────────────────────────────────────────────────────
// Read: recent violation feed + ban list/history (token or session).
// Mutate: ban / unban / auto-metrics (session-only, audit-logged).

adminRouter.get('/anticheat/violations', requireRole('mod'), (req, res) => {
  const limit = intParam(req.query.limit, 100);
  res.json({ violations: listRecentViolations(limit) });
});

adminRouter.get('/anticheat/violations/:username', requireRole('mod'), (req, res) => {
  const target = findAccountByName(cleanUsername(req.params.username).toLowerCase());
  if (!target) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  res.json({ playerId: target.id, username: target.username, violations: listPlayerViolations(target.id) });
});

adminRouter.get('/bans', requireRole('mod'), (_req, res) => {
  res.json({ active: listActiveBans(200), history: listBanHistory(200) });
});

// ── Ban appeals (staff queue) ─────────────────────────────────────────────
// Overturning an appeal lifts the underlying ban; upholding keeps it. Decisions
// are terminal (one appeal per ban) and audit-logged.

adminRouter.get('/appeals', requireRole('mod'), (req, res) => {
  const status = String((req.query.status ?? 'open'));
  res.json({ appeals: status === 'all' ? listAllAppeals(200) : listOpenAppeals(200) });
});

adminRouter.post('/appeals/:id/decide', requireRole('mod'), (req, res) => {
  const id = Number(req.params.id);
  const decision = String((req.body as Record<string, unknown>)?.decision);
  if (!Number.isFinite(id) || (decision !== 'upheld' && decision !== 'overturned')) {
    res.status(400).json({ error: 'bad_request' });
    return;
  }
  const appeal = getAppealById(id);
  if (!appeal || appeal.status !== 'open') {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const staffId = accountId(req) ?? 'staff';
  const result = decideAppeal({ appealId: id, decision, handledBy: staffId });
  if (!result.ok) {
    res.status(409).json({ error: 'already_decided' });
    return;
  }
  logEvent({
    event: 'appeal.decided',
    actorId: staffId,
    targetId: String(id),
    detail: { appealId: id, decision, banId: appeal.banId, lifted: result.lifted ?? false },
  });
  res.json({ ok: true, lifted: result.lifted ?? false });
});

// Issue a ban. Body: { username, reason, duration } where duration is one of
// '1h' | '6h' | '1d' | '7d' | '30d' | 'permanent' (default 'permanent').
adminRouter.post('/bans', requireRole('mod'), (req, res) => {
  if (denyToken(req, res)) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const target = findAccountByName(cleanUsername(body.username).toLowerCase());
  if (!target) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const DURATIONS: Record<string, number | null> = {
    '1h': 60 * 60_000,
    '6h': 6 * 60 * 60_000,
    '1d': 24 * 60 * 60_000,
    '7d': 7 * 24 * 60 * 60_000,
    '30d': 30 * 24 * 60 * 60_000,
    permanent: null,
  };
  const durKey = typeof body.duration === 'string' && body.duration in DURATIONS ? body.duration : 'permanent';
  const reason = typeof body.reason === 'string' ? body.reason.slice(0, 500) : '';
  const admin = (req as unknown as AdminRequest).admin;
  const ban = issueBan({
    playerId: target.id,
    playerName: target.username,
    reason: reason || `Banned by ${admin.username}`,
    durationMs: DURATIONS[durKey],
    source: 'admin',
    issuedBy: admin.id,
  });
  logEvent({
    event: 'admin.ban',
    actorId: admin.id,
    actorName: admin.username,
    targetId: target.id,
    detail: { target: target.username, duration: durKey, reason, banId: ban.id },
    ip: req.ip,
  });
  // If the banned player is connected right now, drop their socket(s) immediately.
  dropPlayerSockets?.(target.id, `Banned: ${ban.reason}`);
  res.json({ ok: true, ban });
});

adminRouter.post('/bans/:id/lift', requireRole('mod'), (req, res) => {
  if (denyToken(req, res)) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'bad_id' });
    return;
  }
  const admin = (req as unknown as AdminRequest).admin;
  const lifted = liftBan(id, admin.id);
  if (!lifted) {
    res.status(404).json({ error: 'not_found_or_already_lifted' });
    return;
  }
  logEvent({
    event: 'admin.unban',
    actorId: admin.id,
    actorName: admin.username,
    detail: { banId: id },
    ip: req.ip,
  });
  res.json({ ok: true });
});

// Check a player's ban status (used by the dashboard player editor).
adminRouter.get('/bans/status/:username', requireRole('mod'), (req, res) => {
  const target = findAccountByName(cleanUsername(req.params.username).toLowerCase());
  if (!target) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  res.json({ ban: getActiveBan(target.id) });
});

// Attach a replay "clip" to a ban: the dashboard records which replay belongs
// to the evidence trail. Body: { note? }. The replay locator is the player's
// stored weekly replay (the rewatchable run nearest the ban).
adminRouter.post('/bans/:id/evidence', requireRole('mod'), (req, res) => {
  if (denyToken(req, res)) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'bad_id' });
    return;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const note = typeof body.note === 'string' ? body.note.slice(0, 300) : '';
  // Resolve the banned player from the ban id via the history list.
  const ban = listBanHistory(500).find((b) => b.id === id);
  if (!ban) {
    res.status(404).json({ error: 'ban_not_found' });
    return;
  }
  attachBanEvidence(id, `weekly:${ban.playerId}`, note || `Replay attached by admin`);
  const admin = (req as unknown as AdminRequest).admin;
  logEvent({
    event: 'admin.ban_evidence',
    actorId: admin.id,
    actorName: admin.username,
    targetId: ban.playerId,
    detail: { banId: id, note },
    ip: req.ip,
  });
  res.json({ ok: true });
});

// Fetch the evidence clips for a ban (locator + availability check).
adminRouter.get('/bans/:id/evidence', requireRole('mod'), (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'bad_id' });
    return;
  }
  const ban = listBanHistory(500).find((b) => b.id === id);
  if (!ban) {
    res.status(404).json({ error: 'ban_not_found' });
    return;
  }
  const evidence = getBanEvidence(id).map((e) => {
    const m = /^weekly:(.+)$/.exec(e.replayKey);
    const available = m ? !!getWeeklyReplayGz(m[1]) : false;
    return { ...e, playerId: m?.[1] ?? '', available };
  });
  res.json({ evidence });
});

// ── Moderation panel (role-scoped) ───────────────────────────────────────────
// Separate from anticheat: player reports from the in-game report action,
// role management, and the quick player-action toolkit. Anticheat/bans stay on
// their own tab; these routes serve the "Moderation" tab.
//   jrmod → view reports + resolve/dismiss; mod → + bans & verified flag;
//   admin → + role management.

// Staff roster with roles (admin only — only admins may change roles).
adminRouter.get('/moderation/staff', requireRole('admin'), (_req, res) => {
  res.json({ staff: listStaff() });
});

// Promote/demote a staff member's role. Body: { username, role }. An admin
// cannot demote themselves (avoids locking out the last admin).
adminRouter.post('/moderation/staff/role', requireRole('admin'), (req, res) => {
  if (denyToken(req, res)) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const target = findAccountByName(cleanUsername(body.username).toLowerCase());
  if (!target) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const role = body.role as StaffRole;
  if (role !== 'admin' && role !== 'mod' && role !== 'jrmod' && role !== 'player') {
    res.status(400).json({ error: 'bad_role' });
    return;
  }
  const admin = (req as unknown as AdminRequest).admin;
  if (target.id === admin.id && role !== 'admin') {
    res.status(400).json({ error: 'cannot_demote_self' });
    return;
  }
  setRole(target.id, role);
  logEvent({
    event: 'admin.set_role',
    actorId: admin.id,
    actorName: admin.username,
    targetId: target.id,
    detail: { username: target.username, role },
    ip: req.ip,
  });
  res.json({ ok: true, username: target.username, role });
});

// Player reports queue. Query: ?status=open|resolved|dismissed|all &target= &limit= &before=
adminRouter.get('/moderation/reports', requireRole('jrmod'), (req, res) => {
  const before = intParam(req.query.before, 0);
  const status = typeof req.query.status === 'string' ? req.query.status : 'open';
  const target = typeof req.query.target === 'string' ? req.query.target.toLowerCase() : '';
  res.json({
    reports: listPlayerReports({
      limit: intParam(req.query.limit, 50),
      beforeId: before > 0 ? before : undefined,
      status,
      targetLower: target || undefined,
    }),
    counts: playerReportCounts(),
  });
});

// Resolve or dismiss a report. Body: { status: 'resolved' | 'dismissed' }.
adminRouter.post('/moderation/reports/:id/status', requireRole('jrmod'), (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'bad_id' });
    return;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const status = body.status as ReportStatus;
  if (status !== 'resolved' && status !== 'dismissed') {
    res.status(400).json({ error: 'bad_status' });
    return;
  }
  const admin = (req as unknown as AdminRequest).admin;
  const ok = setPlayerReportStatus(id, status, admin.username);
  if (!ok) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  logEvent({
    event: 'mod.report_' + status,
    actorId: admin.id,
    actorName: admin.username,
    detail: { reportId: id, status },
    ip: req.ip,
  });
  res.json({ ok: true });
});

// Quick player action: issue a ban straight from the reports queue (mod+).
// Thin wrapper over the existing ban logic — same durations, same audit trail.
adminRouter.post('/moderation/ban', requireRole('mod'), (req, res) => {
  if (denyToken(req, res)) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const target = findAccountByName(cleanUsername(body.username).toLowerCase());
  if (!target) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const DURATIONS: Record<string, number | null> = {
    '1h': 60 * 60_000,
    '6h': 6 * 60 * 60_000,
    '1d': 24 * 60 * 60_000,
    '7d': 7 * 24 * 60 * 60_000,
    '30d': 30 * 24 * 60 * 60_000,
    permanent: null,
  };
  const durKey = typeof body.duration === 'string' && body.duration in DURATIONS ? body.duration : '1d';
  const reason = typeof body.reason === 'string' ? body.reason.slice(0, 500) : '';
  const admin = (req as unknown as AdminRequest).admin;
  // jrmods can't be banned by other staff; admins can't be banned except by admins.
  const targetStaff = roleRank(target.role);
  if (targetStaff >= roleRank(callerRole(req)) && callerRole(req) !== 'admin') {
    res.status(403).json({ error: 'insufficient_role' });
    return;
  }
  const ban = issueBan({
    playerId: target.id,
    playerName: target.username,
    reason: reason || `Banned by ${admin.username} (moderation)`,
    durationMs: DURATIONS[durKey],
    source: 'moderation',
    issuedBy: admin.id,
  });
  logEvent({
    event: 'mod.ban',
    actorId: admin.id,
    actorName: admin.username,
    targetId: target.id,
    detail: { target: target.username, duration: durKey, reason, banId: ban.id },
    ip: req.ip,
  });
  dropPlayerSockets?.(target.id, `Banned: ${ban.reason}`);
  res.json({ ok: true, ban });
});

// Toggle the verified blue-check from the moderation panel (mod+).
adminRouter.post('/moderation/verify', requireRole('mod'), (req, res) => {
  if (denyToken(req, res)) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const target = findAccountByName(cleanUsername(body.username).toLowerCase());
  if (!target) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const value = body.verified !== false;
  setVerified(target.id, value);
  const admin = (req as unknown as AdminRequest).admin;
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
