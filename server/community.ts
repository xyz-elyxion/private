// Discord-style community chat for the /community page. Multi-channel, persisted
// (unlike match/lobby chat), profanity-filtered, spam rate-limited, and admin-
// moderatable (soft-delete via /api/admin/community/*). Guests may post as
// "Guest"; logged-in accounts post as their username with admin/verified snapshots.

import { Router } from 'express';
import { accountId, ensureGuestId } from './auth';
import { containsProfanity } from './profanity';
import {
  COMMUNITY_CHANNELS,
  findUserById,
  listCommunityMessages,
  postCommunityMessage,
  type CommunityChannel,
} from './db';

export const communityRouter = Router();

// --- POST rate limiter ---------------------------------------------------------
// Chat is higher-volume than feedback, but still gets a tight per-identity cap
// so a single spammer can't bury a channel: 20 messages per minute (a typist's
// worth), keyed by the cookie account when present, else the client IP.
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_POSTS = 20;
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

const rateSweep = setInterval(() => {
  const cutoff = Date.now() - RATE_WINDOW_MS;
  for (const [id, hits] of postHits) {
    if (hits.length === 0 || hits[hits.length - 1] <= cutoff) postHits.delete(id);
  }
}, RATE_WINDOW_MS);
rateSweep.unref?.();

const TEXT_MAX = 500;

function asChannel(v: unknown): CommunityChannel | null {
  return typeof v === 'string' && (COMMUNITY_CHANNELS as readonly string[]).includes(v)
    ? (v as CommunityChannel)
    : null;
}

// Public channel list (labels + rough activity counts live on the client via the
// messages endpoint; this is just the canonical set).
communityRouter.get('/community/channels', (_req, res) => {
  res.json({ channels: COMMUNITY_CHANNELS });
});

// Recent messages in a channel, newest first (the client reverses for display).
communityRouter.get('/community/messages', (req, res) => {
  const channel = asChannel(req.query.channel);
  if (!channel) {
    res.status(400).json({ error: 'bad_channel' });
    return;
  }
  const before = parseInt(String(req.query.before ?? ''), 10);
  const limit = parseInt(String(req.query.limit ?? ''), 10);
  const messages = listCommunityMessages({
    channel,
    limit: Number.isFinite(limit) && limit > 0 ? limit : 50,
    beforeId: Number.isFinite(before) && before > 0 ? before : 0,
  });
  res.json({ messages });
});

// Send a chat message. Identity is server-authoritative: the account username
// when logged in, else "Guest". Content is length-capped and run through the
// same profanity filter as account registration + in-game chat.
communityRouter.post('/community/messages', (req, res) => {
  const now = Date.now();
  const id = accountId(req);
  const rateKey = id || req.ip || 'unknown';
  if (!allowPost(rateKey, now)) {
    res.status(429).json({ error: 'rate_limited' });
    return;
  }

  const channel = asChannel((req.body as Record<string, unknown>)?.channel);
  const text = typeof (req.body as Record<string, unknown>)?.text === 'string'
    ? ((req.body as Record<string, unknown>).text as string).trim()
    : '';

  if (!channel) {
    res.status(400).json({ error: 'bad_channel' });
    return;
  }
  if (text.length < 1 || text.length > TEXT_MAX) {
    res.status(400).json({ error: 'bad_text' });
    return;
  }
  if (containsProfanity(text)) {
    // Same stance as in-game chat: profane content is refused with a specific
    // code so the UI can tell the player why (rather than silently dropping).
    res.status(400).json({ error: 'profanity' });
    return;
  }

  const account = id ? findUserById(id) : null;
  const playerName = account?.username || 'Guest';
  // Attribution: accounts by their account id; guests by their stable igpid
  // uuid (minted here on first guest post) so all of one guest's content ties
  // to a single identity an admin can moderate (soft-delete + ban-by-uuid).
  const playerId = id || ensureGuestId(req, res);

  const newId = postCommunityMessage({
    channel,
    playerId,
    playerName,
    text,
    admin: account?.isAdmin ?? false,
    verified: account?.isVerified ?? false,
    ip: req.ip,
    userAgent: (req.get('user-agent') ?? '').slice(0, 256),
    now,
  });
  if (!newId) {
    res.status(500).json({ error: 'server_error' });
    return;
  }

  res.json({
    ok: true,
    message: {
      id: newId,
      channel,
      ts: now,
      playerId,
      playerName,
      text,
      deleted: false,
      admin: account?.isAdmin ?? false,
      verified: account?.isVerified ?? false,
    },
  });
});