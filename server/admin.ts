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
import { Router, type Request, type Response, type NextFunction } from 'express';
import { accountId } from './auth';
import { acCounts, acRecent, type AcKind } from './anticheat';
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
  listAllCommunityMessages,
  listFeedback,
  listReplies,
  listTickets,
  logEvent,
  deleteCommunityMessage,
  setAdmin,
  setFeedbackStatus,
  setTicketStatus,
  setVerified,
  ticketCounts,
  TICKET_STATUSES,
  addTicketReply,
  getTicket,
  type AccountInfo,
  type FeedbackStatus,
  type TicketStatus,
} from './db';
import { WEEKLY_CHALLENGE_FRAG_LIMIT, WEEKLY_CHALLENGE_MAP } from '../src/game/constants';

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

// Live moderation handles, injected by index.ts from the WS layer (the only
// place live sockets + the ban table meet). Defaults are safe no-ops so the
// routes are well-formed even before the socket attaches.
export type BanListEntry = {
  kind: 'name' | 'ip';
  name: string; // display name ('', for direct IP bans)
  ip?: string; // set for IP bans
  reason: string;
  bannedBy: string;
  createdAt: number;
};
type ModerationActions = {
  kick: (name: string, reason: string, actorName: string) => { found: boolean; names: string[] };
  // Name ban — auto-captures the online target's IP so a reconnecting guest
  // can't dodge it by renumbering their "Guest N" name.
  ban: (name: string, reason: string, actorName: string) => { found: boolean; names: string[] };
  // Direct IP ban — blocks every connection from that address, now + future.
  banIp: (ip: string, reason: string, actorName: string) => { found: boolean; names: string[] };
  unban: (name: string, actorName: string) => boolean;
  unbanIp: (ip: string, actorName: string) => boolean;
  list: () => BanListEntry[];
};
let moderation: ModerationActions = {
  kick: () => ({ found: false, names: [] }),
  ban: () => ({ found: false, names: [] }),
  banIp: () => ({ found: false, names: [] }),
  unban: () => false,
  unbanIp: () => false,
  list: () => [],
};
export function setModerationActions(m: ModerationActions): void {
  moderation = m;
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

// ── Support tickets (admin side) ──────────────────────────────────────────
// The list is read-only → token-readable (like the ban list); status changes and
// replies mutate → session-only (denyToken). Everything is audit-logged.

// All tickets, newest first, keyset-paginated by id, optional status filter.
// Includes each ticket's reply thread so the admin UI renders full conversations.
adminRouter.get('/support/tickets', (req, res) => {
  const status = typeof req.query.status === 'string' ? req.query.status : '';
  const before = parseInt(String(req.query.before ?? ''), 10);
  const limit = parseInt(String(req.query.limit ?? ''), 10);
  const tickets = listTickets({
    limit: Number.isFinite(limit) && limit > 0 ? limit : 50,
    beforeId: Number.isFinite(before) && before > 0 ? before : 0,
    status,
  }).map((t) => ({ ...t, replies: listReplies(t.id) }));
  res.json({ tickets, counts: ticketCounts() });
});

// Update a ticket's moderation status (open → ack → resolved → closed).
// Session-only + audit-logged, mirroring the feedback status route.
adminRouter.post('/support/tickets/:id/status', (req, res) => {
  if (denyToken(req, res)) return;
  const id = parseInt(req.params.id, 10);
  const body = (req.body ?? {}) as Record<string, unknown>;
  const status = typeof body.status === 'string' ? body.status : '';
  if (!Number.isFinite(id) || id <= 0) {
    res.status(400).json({ error: 'bad_id' });
    return;
  }
  if (!(TICKET_STATUSES as readonly string[]).includes(status)) {
    res.status(400).json({ error: 'bad_status' });
    return;
  }
  if (!setTicketStatus(id, status as TicketStatus)) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const admin = (req as unknown as AdminRequest).admin;
  logEvent({
    event: 'admin.support_status',
    actorId: admin.id,
    actorName: admin.username,
    targetId: String(id),
    detail: { status },
    ip: req.ip,
  });
  res.json({ ok: true, id, status });
});

// Reply to a ticket (the player sees it on /support). An 'open' ticket is
// implicitly acked by the first reply. Session-only + audit-logged.
adminRouter.post('/support/tickets/:id/reply', (req, res) => {
  if (denyToken(req, res)) return;
  const id = parseInt(req.params.id, 10);
  const body = typeof (req.body ?? {}).text === 'string' ? (req.body as { text: string }).text.trim() : '';
  if (!Number.isFinite(id) || id <= 0) {
    res.status(400).json({ error: 'bad_id' });
    return;
  }
  if (body.length < 1 || body.length > 2000) {
    res.status(400).json({ error: 'bad_body' });
    return;
  }
  const ticket = getTicket(id);
  if (!ticket) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const admin = (req as unknown as AdminRequest).admin;
  const replyId = addTicketReply(id, admin.username, body);
  if (!replyId) {
    res.status(500).json({ error: 'server_error' });
    return;
  }
  logEvent({
    event: 'admin.support_reply',
    actorId: admin.id,
    actorName: admin.username,
    targetId: String(id),
    detail: { subject: ticket.subject },
    ip: req.ip,
  });
  res.json({ ok: true, id, replyId });
});

// ── Community chat (admin side) ────────────────────────────────────────────
// Recent messages across all channels, newest first, keyset-paginated — plus
// soft-delete. The list is read-only → token-readable; deletes mutate →
// session-only (denyToken) + audit-logged.
adminRouter.get('/community/messages', (req, res) => {
  const before = parseInt(String(req.query.before ?? ''), 10);
  const limit = parseInt(String(req.query.limit ?? ''), 10);
  const messages = listAllCommunityMessages({
    limit: Number.isFinite(limit) && limit > 0 ? limit : 50,
    beforeId: Number.isFinite(before) && before > 0 ? before : 0,
  });
  res.json({ messages });
});

// Soft-delete a community message (hidden everywhere; kept for audit).
// Session-only + audit-logged, mirroring the other moderation mutations.
adminRouter.post('/community/messages/:id/delete', (req, res) => {
  if (denyToken(req, res)) return;
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) {
    res.status(400).json({ error: 'bad_id' });
    return;
  }
  if (!deleteCommunityMessage(id)) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const admin = (req as unknown as AdminRequest).admin;
  logEvent({
    event: 'admin.chat_delete',
    actorId: admin.id,
    actorName: admin.username,
    targetId: String(id),
    ip: req.ip,
  });
  res.json({ ok: true, id });
});

// ── Moderation: kick / ban / unban ─────────────────────────────────────────
// All mutations — they boot live players and persist bans — so (like
// verify/grant) they require a real admin session: a read-only API token may
// never moderate. The ban list (GET) is read-only, so it stays token-readable.

// Kick a player out of a live match / the lobby: disconnected immediately, no
// ban, resume slot released. Unknown/offline name → 404 'not_online'.
adminRouter.post('/kick', (req, res) => {
  if (denyToken(req, res)) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const name = cleanUsername(body.name);
  const reason = cleanUsername(body.reason).slice(0, 200);
  if (!name) {
    res.status(400).json({ error: 'bad_name' });
    return;
  }
  const admin = (req as AdminRequest).admin;
  const r = moderation.kick(name, reason, admin.username);
  logEvent({
    event: 'admin.kick',
    actorId: admin.id,
    actorName: admin.username,
    detail: { name, reason },
    ip: req.ip,
  });
  if (!r.found) {
    res.status(404).json({ error: 'not_online', name });
    return;
  }
  res.json({ ok: true, names: r.names, reason });
});

// Ban a display name (case-insensitive, persisted) OR an IP address directly
// ({ ip } body). A name ban kicks everyone live under that name and auto-
// captures their IPs (a reconnecting guest can't dodge it by renumbering). An
// IP ban blocks the address at the door and boots whoever is on it now.
adminRouter.post('/ban', (req, res) => {
  if (denyToken(req, res)) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const name = cleanUsername(body.name);
  const ip = cleanUsername(body.ip);
  const reason = cleanUsername(body.reason).slice(0, 200);
  if (!name && !ip) {
    res.status(400).json({ error: 'bad_target' });
    return;
  }
  const admin = (req as AdminRequest).admin;
  if (ip) {
    const r = moderation.banIp(ip, reason, admin.username);
    logEvent({
      event: 'admin.ban_ip',
      actorId: admin.id,
      actorName: admin.username,
      detail: { ip, reason },
      ip: req.ip,
    });
    res.json({ ok: true, ip, names: r.names, reason });
    return;
  }
  const r = moderation.ban(name, reason, admin.username);
  logEvent({
    event: 'admin.ban',
    actorId: admin.id,
    actorName: admin.username,
    detail: { name, reason },
    ip: req.ip,
  });
  res.json({ ok: true, names: r.names, name, reason });
});

// Lift a ban — by name ({ name }, also lifts the IPs that ban captured) or by
// IP ({ ip }). No-op (404) when nothing matched.
adminRouter.post('/unban', (req, res) => {
  if (denyToken(req, res)) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const name = cleanUsername(body.name);
  const ip = cleanUsername(body.ip);
  if (!name && !ip) {
    res.status(400).json({ error: 'bad_target' });
    return;
  }
  const admin = (req as AdminRequest).admin;
  if (ip) {
    const ok = moderation.unbanIp(ip, admin.username);
    logEvent({
      event: 'admin.unban_ip',
      actorId: admin.id,
      actorName: admin.username,
      detail: { ip },
      ip: req.ip,
    });
    if (!ok) {
      res.status(404).json({ error: 'not_banned', ip });
      return;
    }
    res.json({ ok: true, ip });
    return;
  }
  const ok = moderation.unban(name, admin.username);
  logEvent({
    event: 'admin.unban',
    actorId: admin.id,
    actorName: admin.username,
    detail: { name },
    ip: req.ip,
  });
  if (!ok) {
    res.status(404).json({ error: 'not_banned', name });
    return;
  }
  res.json({ ok: true, name });
});

// Current ban list, newest first (for review / the dashboard). Read-only.
adminRouter.get('/bans', (_req, res) => {
  res.json({ bans: moderation.list() });
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
    // What the anticheat caught (counts over its retained window).
    anticheat: acCounts(),
  });
});

// ── Anticheat feed ─────────────────────────────────────────────────────────
// What the defensive layer caught and did, newest first: rejected hacks
// (speed / fire-rate / shot-origin / aimbot), kicked (afk / flood), blocked
// (banned at the door / profanity), timeouts (chat rate limit), and bans
// applied or lifted. Read-only → a bearer token may view this too.
adminRouter.get('/anticheat', (req, res) => {
  const kind = typeof req.query.kind === 'string' && req.query.kind ? (req.query.kind as AcKind) : undefined;
  res.json({
    events: acRecent(intParam(req.query.limit, 100), kind),
    counts: acCounts(),
  });
});
