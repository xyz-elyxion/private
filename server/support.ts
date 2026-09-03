// Player-facing support tickets. The /support page POSTs here; the admin panel
// reads + replies via /api/admin/support/* (see server/admin.ts). Anyone may
// open a ticket; only a logged-in account can list their own (tickets are keyed
// to the account, exactly like feedback). Free-text here is shown only to admins
// and the ticket's own author — never broadcast — so the guard rails are length
// caps + a tight rate limit, mirroring server/feedback.ts.

import { Router, type Request } from 'express';
import { accountId } from './auth';
import {
  TICKET_CATEGORIES,
  addPlayerTicketReply,
  findUserById,
  getTicket,
  listReplies,
  listTickets,
  logEvent,
  submitTicket,
  type TicketCategory,
} from './db';

export const supportRouter = Router();

// --- POST rate limiter (mirrors server/feedback.ts) --------------------------
// Tickets are low-volume, so the cap is tight: a handful per window per identity
// (the cookie account when present, else the client IP).
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

const SUBJECT_MIN = 3;
const SUBJECT_MAX = 120;
const BODY_MIN = 10;
const BODY_MAX = 4000;

function asCategory(v: unknown): TicketCategory | null {
  return typeof v === 'string' && (TICKET_CATEGORIES as readonly string[]).includes(v)
    ? (v as TicketCategory)
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

supportRouter.post('/support/tickets', (req, res) => {
  const now = Date.now();
  const id = accountId(req);
  const rateKey = id || req.ip || 'unknown';
  if (!allowPost(rateKey, now)) {
    res.status(429).json({ error: 'rate_limited' });
    return;
  }

  const category = asCategory((req.body as Record<string, unknown>)?.category);
  const subject = str(req, 'subject', 'title');
  const text = str(req, 'message', 'body', 'description');

  if (!category) {
    res.status(400).json({ error: 'bad_category' });
    return;
  }
  if (subject.length < SUBJECT_MIN || subject.length > SUBJECT_MAX) {
    res.status(400).json({ error: 'bad_subject' });
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

  const newId = submitTicket({
    playerId: id,
    playerName,
    category,
    subject,
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
    event: 'support.ticket',
    actorId: id,
    actorName: playerName,
    targetId: String(newId),
    detail: { category, subject },
    ip: req.ip,
    now,
  });

  res.json({ ok: true, id: newId });
});

// A logged-in player's own tickets, newest first, with the full thread attached
// (replies are cheap and capped at 200 per ticket). Guests have no stable
// identity to key tickets to, so they get an empty list — the form still works.
supportRouter.get('/support/tickets', (req, res) => {
  const id = accountId(req);
  if (!id) {
    res.json({ tickets: [] });
    return;
  }
  const tickets = listTickets({ limit: 20, playerId: id });
  const withReplies = tickets.map((t) => ({ ...t, replies: listReplies(t.id) }));
  res.json({ tickets: withReplies });
});

const REPLY_MIN = 1;
const REPLY_MAX = 2000;

// The ticket's author replying back (the admin replies via /api/admin/support).
// Keeps the thread alive for the admin and reopens a resolved/closed ticket.
// Session-only (a reply must be attributable to an account), rate-limited like
// submissions, audit-logged.
supportRouter.post('/support/tickets/:id/replies', (req, res) => {
  const accountIdVal = accountId(req);
  if (!accountIdVal) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) {
    res.status(400).json({ error: 'bad_id' });
    return;
  }
  const text = str(req, 'message', 'body', 'text');
  if (text.length < REPLY_MIN || text.length > REPLY_MAX) {
    res.status(400).json({ error: 'bad_body' });
    return;
  }

  const now = Date.now();
  if (!allowPost(accountIdVal, now)) {
    res.status(429).json({ error: 'rate_limited' });
    return;
  }

  const ticket = getTicket(id);
  if (!ticket) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  // Ownership: you can only reply to your OWN ticket.
  if (ticket.playerId !== accountIdVal) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }

  const account = findUserById(accountIdVal);
  const replyId = addPlayerTicketReply(id, account?.username || 'Guest', text, now);
  if (!replyId) {
    res.status(500).json({ error: 'server_error' });
    return;
  }
  logEvent({
    event: 'support.reply',
    actorId: accountIdVal,
    actorName: account?.username || 'Guest',
    targetId: String(id),
    detail: { subject: ticket.subject },
    ip: req.ip,
    now,
  });
  res.json({ ok: true, id, replyId });
});