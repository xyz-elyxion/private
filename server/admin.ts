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

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { Router, type Request, type Response, type NextFunction } from 'express';
import { accountId } from './auth';
import type { OnlinePlayer } from './elyxion-game';
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
  setPasswordHash,
  grantCredits,
  setFeedbackStatus,
  setTicketStatus,
  setVerified,
  ticketCounts,
  TICKET_STATUSES,
  addTicketReply,
  getTicket,
  issueViolation,
  listViolations,
  reviewViolationAppeal,
  setViolationStatus,
  violationCounts,
  type AccountInfo,
  type FeedbackStatus,
  type TicketStatus,
  type ViolationAppealStatus,
  type ViolationSeverity,
  type ViolationStatus,
} from './db';
import { WEEKLY_CHALLENGE_FRAG_LIMIT, WEEKLY_CHALLENGE_MAP } from '../src/game/constants';
import {
  ANNOUNCEMENT_MAX_LEN,
  createAnnouncement,
  deleteAnnouncement,
  listAnnouncements,
} from './db';

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
type BanListEntry = {
  kind: 'name' | 'ip' | 'guest';
  name: string; // display name ('', for direct IP / guest bans)
  ip?: string; // set for IP bans
  guestId?: string; // set for guest-uuid bans
  reason: string;
  bannedBy: string;
  createdAt: number;
  bannedUntil: number; // epoch ms the ban lifts; 0 = permanent
};
type ModerationActions = {
  kick: (name: string, reason: string, actorName: string) => { found: boolean; names: string[] };
  // Kick a guest by their anonymous uuid (the igpid cookie) — targets every
  // live connection carrying that identity.
  kickGuest: (guestId: string, reason: string, actorName: string) => { found: boolean; names: string[] };
  // Name ban — auto-captures the online target's IP AND guest uuid so a
  // reconnecting guest can't dodge it by renumbering their "Guest N" name.
  // `bannedUntil`: epoch ms the ban lifts (0 = permanent).
  ban: (name: string, reason: string, actorName: string, bannedUntil?: number) => {
    found: boolean;
    names: string[];
  };
  // Guest-uuid ban — persists (refused at the guest's next connect even with a
  // fresh name/IP), auto-captures the online guest's IP, and boots them now.
  banGuest: (guestId: string, reason: string, actorName: string, bannedUntil?: number) => {
    found: boolean;
    names: string[];
  };
  // Direct IP ban — blocks every connection from that address, now + future.
  banIp: (ip: string, reason: string, actorName: string, bannedUntil?: number) => {
    found: boolean;
    names: string[];
  };
  unban: (name: string, actorName: string) => boolean;
  unbanGuest: (guestId: string, actorName: string) => boolean;
  unbanIp: (ip: string, actorName: string) => boolean;
  list: () => BanListEntry[];
  // Live players + guests (guests carry their uuid/IP for moderation).
  online: () => OnlinePlayer[];
};
let moderation: ModerationActions = {
  kick: () => ({ found: false, names: [] }),
  kickGuest: () => ({ found: false, names: [] }),
  ban: () => ({ found: false, names: [] }),
  banGuest: () => ({ found: false, names: [] }),
  banIp: () => ({ found: false, names: [] }),
  unban: () => false,
  unbanGuest: () => false,
  unbanIp: () => false,
  list: () => [],
  online: () => [],
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
const ACCOUNT_PASSWORD_MIN = 6;
const ACCOUNT_PASSWORD_MAX = 200;
const CREDITS_GRANT_MAX = 1_000_000;

// A guest target is the anonymous igpid uuid (an RFC 4122 lowercase hex-uuid
// minted into the igpid cookie). Validate the shape so junk can't land in the
// guest-ban table (a non-uuid row would sit inert forever); lowercased for the
// ban store.
const GUEST_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const cleanGuestId = (v: unknown): string => {
  if (typeof v !== 'string') return '';
  const g = v.trim().toLowerCase();
  return GUEST_ID_RE.test(g) ? g : '';
};


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

// Replace an account password. Passwords never enter the database or audit log in
// plaintext; revoking all sessions also signs the account out everywhere.
adminRouter.post('/password', (req, res) => {
  if (denyToken(req, res)) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const username = cleanUsername(body.username);
  const password = typeof body.password === 'string' ? body.password : '';
  if (password.length < ACCOUNT_PASSWORD_MIN || password.length > ACCOUNT_PASSWORD_MAX) {
    res.status(400).json({ error: 'bad_password' });
    return;
  }
  const target = findAccountByName(username.toLowerCase());
  if (!target) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  if (!setPasswordHash(target.id, hash, salt)) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const admin = (req as AdminRequest).admin;
  logEvent({
    event: 'admin.password_reset',
    actorId: admin.id,
    actorName: admin.username,
    targetId: target.id,
    detail: { username: target.username, sessionsRevoked: true },
    ip: req.ip,
  });
  res.json({ ok: true, username: target.username, sessionsRevoked: true });
});

// Add credits to an account's existing balance. This is deliberately additive,
// bounded, and whole-number-only so an admin action cannot accidentally replace
// or create a negative balance.
adminRouter.post('/credits', (req, res) => {
  if (denyToken(req, res)) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const username = cleanUsername(body.username);
  const amount = typeof body.amount === 'number' ? body.amount : NaN;
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > CREDITS_GRANT_MAX) {
    res.status(400).json({ error: 'bad_amount' });
    return;
  }
  const target = findAccountByName(username.toLowerCase());
  if (!target) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const credits = grantCredits(target.id, amount);
  if (credits == null) {
    res.status(500).json({ error: 'server_error' });
    return;
  }
  const admin = (req as AdminRequest).admin;
  logEvent({
    event: 'admin.credits_grant',
    actorId: admin.id,
    actorName: admin.username,
    targetId: target.id,
    detail: { username: target.username, amount, credits },
    ip: req.ip,
  });
  res.json({ ok: true, username: target.username, amount, credits });
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

// ── Violations / warnings (admin side) ─────────────────────────────────────
// The list is readable with either admin session or read-only API token. Issuing,
// dismissing, and reviewing appeals require a real admin session.
adminRouter.get('/violations', (req, res) => {
  const limit = parseInt(String(req.query.limit ?? ''), 10);
  const rows = listViolations({ limit: Number.isFinite(limit) && limit > 0 ? limit : 100 });
  res.json({ violations: rows, counts: violationCounts() });
});

adminRouter.post('/violations', (req, res) => {
  if (denyToken(req, res)) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const username = cleanUsername(body.username);
  const guest = cleanGuestId(body.guest);
  const playerId = cleanUsername(body.playerId);
  const reason = cleanUsername(body.reason).slice(0, 500);
  const severity = body.severity === 'strike' ? 'strike' : body.severity === 'warning' ? 'warning' : '';
  const durationMs =
    typeof body.durationMs === 'number' && Number.isFinite(body.durationMs) && body.durationMs > 0
      ? Math.min(Math.floor(body.durationMs), 10 * 365 * 86_400_000)
      : 0;
  if ((!username && !guest && !playerId) || !reason || !severity) {
    res.status(400).json({ error: 'bad_violation' });
    return;
  }
  let targetId = playerId;
  let targetName = username || 'Guest';
  if (username) {
    const target = findAccountByName(username.toLowerCase());
    if (!target) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    targetId = target.id;
    targetName = target.username;
  } else if (guest) {
    targetId = guest;
  }
  if (!targetId) {
    res.status(400).json({ error: 'bad_target' });
    return;
  }
  const admin = (req as AdminRequest).admin;
  const now = Date.now();
  const id = issueViolation({
    playerId: targetId,
    playerName: targetName,
    severity: severity as ViolationSeverity,
    reason,
    issuedBy: admin.username,
    expiresAt: durationMs > 0 ? now + durationMs : 0,
    now,
  });
  if (!id) {
    res.status(500).json({ error: 'server_error' });
    return;
  }
  logEvent({
    event: 'admin.violation_issue',
    actorId: admin.id,
    actorName: admin.username,
    targetId,
    detail: { violationId: id, playerName: targetName, severity, reason, durationMs },
    ip: req.ip,
  });
  res.json({ ok: true, id, severity, playerId: targetId, playerName: targetName });
});

adminRouter.post('/violations/:id/status', (req, res) => {
  if (denyToken(req, res)) return;
  const id = parseInt(req.params.id, 10);
  const status = (req.body as Record<string, unknown> | undefined)?.status;
  if (!Number.isFinite(id) || id <= 0 || (status !== 'active' && status !== 'dismissed')) {
    res.status(400).json({ error: 'bad_status' });
    return;
  }
  if (!setViolationStatus(id, status as ViolationStatus)) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const admin = (req as unknown as AdminRequest).admin;
  logEvent({ event: 'admin.violation_status', actorId: admin.id, actorName: admin.username, targetId: String(id), detail: { status }, ip: req.ip });
  res.json({ ok: true, id, status });
});

adminRouter.post('/violations/:id/appeal', (req, res) => {
  if (denyToken(req, res)) return;
  const id = parseInt(req.params.id, 10);
  const appealStatus = (req.body as Record<string, unknown> | undefined)?.status;
  if (!Number.isFinite(id) || id <= 0 || (appealStatus !== 'approved' && appealStatus !== 'denied')) {
    res.status(400).json({ error: 'bad_appeal_status' });
    return;
  }
  const admin = (req as unknown as AdminRequest).admin;
  if (!reviewViolationAppeal(id, appealStatus as Exclude<ViolationAppealStatus, 'none' | 'pending'>, admin.username)) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  logEvent({ event: `admin.violation_appeal_${appealStatus}`, actorId: admin.id, actorName: admin.username, targetId: String(id), detail: { status: appealStatus }, ip: req.ip });
  res.json({ ok: true, id, appealStatus });
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

// ── Server announcements ────────────────────────────────────────────────────
// Site-wide notices shown on the landing page (public read at /api/
// announcements). The management list is read-only → token-readable; posting
// and deleting mutate → session-only (denyToken) + audit-logged, mirroring the
// other moderation mutations.
adminRouter.get('/announcements', (_req, res) => {
  res.json({ announcements: listAnnouncements(100) });
});

// Post a new announcement: { text, durationMs? }. durationMs 0/absent = stays
// until manually deleted; otherwise it auto-expires (hidden from players) after
// that long. Appears on the landing page immediately.
adminRouter.post('/announcements', (req, res) => {
  if (denyToken(req, res)) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text || text.length > ANNOUNCEMENT_MAX_LEN) {
    res.status(400).json({ error: 'bad_text' });
    return;
  }
  const durationMs =
    typeof body.durationMs === 'number' && Number.isFinite(body.durationMs) && body.durationMs > 0
      ? Math.min(Math.floor(body.durationMs), 10 * 365 * 86_400_000) // cap: ~10y
      : 0;
  const admin = (req as AdminRequest).admin;
  const now = Date.now();
  const id = createAnnouncement({
    text,
    author: admin.username,
    now,
    expiresAt: durationMs > 0 ? now + durationMs : 0,
  });
  if (!id) {
    res.status(500).json({ error: 'server_error' });
    return;
  }
  logEvent({
    event: 'admin.announce',
    actorId: admin.id,
    actorName: admin.username,
    targetId: String(id),
    detail: { text: text.slice(0, 120), durationMs },
    ip: req.ip,
  });
  res.json({ ok: true, id });
});

// Remove an announcement (hidden from the landing page immediately; the row is
// soft-deleted and stays in the audit trail). Session-only + audit-logged.
adminRouter.delete('/announcements/:id', (req, res) => {
  if (denyToken(req, res)) return;
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) {
    res.status(400).json({ error: 'bad_id' });
    return;
  }
  if (!deleteAnnouncement(id)) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const admin = (req as unknown as AdminRequest).admin;
  logEvent({
    event: 'admin.announce_delete',
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
// ban, resume slot released. Target a display NAME ({ name }, case-insensitive)
// or a guest by their uuid ({ guest }). Unknown/offline target → 404
// 'not_online'.
adminRouter.post('/kick', (req, res) => {
  if (denyToken(req, res)) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const name = cleanUsername(body.name);
  const guest = cleanGuestId(body.guest);
  const reason = cleanUsername(body.reason).slice(0, 200);
  const admin = (req as AdminRequest).admin;
  if (guest) {
    const r = moderation.kickGuest(guest, reason, admin.username);
    logEvent({
      event: 'admin.kick_guest',
      actorId: admin.id,
      actorName: admin.username,
      targetId: guest,
      detail: { guest, reason, names: r.names },
      ip: req.ip,
    });
    if (!r.found) {
      res.status(404).json({ error: 'not_online', guest });
      return;
    }
    res.json({ ok: true, guest, names: r.names, reason });
    return;
  }
  if (!name) {
    res.status(400).json({ error: 'bad_target' });
    return;
  }
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

// Ban a display name (case-insensitive, persisted), a guest uuid ({ guest }), OR
// an IP address directly ({ ip }). A name ban kicks everyone live under that
// name and auto-captures their IPs + guest uuids (a reconnecting guest can't
// dodge it by renumbering). A guest ban persists against the uuid (refused at
// the guest's next connect) and boots them now. An IP ban blocks the address at
// the door and boots whoever is on it now. Optional { durationMs } makes it a
// timed ban (0/absent = permanent).
adminRouter.post('/ban', (req, res) => {
  if (denyToken(req, res)) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const name = cleanUsername(body.name);
  const guest = cleanGuestId(body.guest);
  const ip = cleanUsername(body.ip);
  const reason = cleanUsername(body.reason).slice(0, 200);
  const durationMs =
    typeof body.durationMs === 'number' && Number.isFinite(body.durationMs) && body.durationMs > 0
      ? Math.min(Math.floor(body.durationMs), 10 * 365 * 86_400_000) // cap: ~10y
      : 0;
  const bannedUntil = durationMs > 0 ? Date.now() + durationMs : 0;
  if (!name && !guest && !ip) {
    res.status(400).json({ error: 'bad_target' });
    return;
  }
  const admin = (req as AdminRequest).admin;
  if (guest) {
    const r = moderation.banGuest(guest, reason, admin.username, bannedUntil);
    logEvent({
      event: 'admin.ban_guest',
      actorId: admin.id,
      actorName: admin.username,
      targetId: guest,
      detail: { guest, reason, durationMs, bannedUntil, names: r.names },
      ip: req.ip,
    });
    res.json({ ok: true, guest, names: r.names, reason, bannedUntil });
    return;
  }
  if (ip) {
    const r = moderation.banIp(ip, reason, admin.username, bannedUntil);
    logEvent({
      event: 'admin.ban_ip',
      actorId: admin.id,
      actorName: admin.username,
      detail: { ip, reason, durationMs, bannedUntil },
      ip: req.ip,
    });
    res.json({ ok: true, ip, names: r.names, reason, bannedUntil });
    return;
  }
  const r = moderation.ban(name, reason, admin.username, bannedUntil);
  logEvent({
    event: 'admin.ban',
    actorId: admin.id,
    actorName: admin.username,
    detail: { name, reason, durationMs, bannedUntil },
    ip: req.ip,
  });
  res.json({ ok: true, names: r.names, name, reason, bannedUntil });
});

// Lift a ban — by name ({ name }, also lifts the IPs + guest uuids that ban
// captured), by guest uuid ({ guest }, also lifts the IP it captured), or by IP
// ({ ip }). No-op (404) when nothing matched.
adminRouter.post('/unban', (req, res) => {
  if (denyToken(req, res)) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const name = cleanUsername(body.name);
  const guest = cleanGuestId(body.guest);
  const ip = cleanUsername(body.ip);
  if (!name && !guest && !ip) {
    res.status(400).json({ error: 'bad_target' });
    return;
  }
  const admin = (req as AdminRequest).admin;
  if (guest) {
    const ok = moderation.unbanGuest(guest, admin.username);
    logEvent({
      event: 'admin.unban_guest',
      actorId: admin.id,
      actorName: admin.username,
      targetId: guest,
      detail: { guest },
      ip: req.ip,
    });
    if (!ok) {
      res.status(404).json({ error: 'not_banned', guest });
      return;
    }
    res.json({ ok: true, guest });
    return;
  }
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

// Live players right now — accounts AND each online guest (uuid + IP + where
// they are) — for the admin online list + per-guest kick/ban. Read-only, so a
// bearer token may view it too (unlike the mutations above).
adminRouter.get('/online', (_req, res) => {
  res.json({ online: moderation.online() });
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
