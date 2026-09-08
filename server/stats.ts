// Account-bound player stats API.
//
// Progression is tied to a registered account (see server/auth.ts). A guest (no
// session) resolves to an empty id, so the DB layer saves nothing for them. The
// display name is still cosmetic (sent by the client), but the *identity* — what
// the leaderboard and progression key off — is the authenticated account.

import { Router, type Request } from 'express';
import {
  addFriend,
  buyCosmetic,
  claimChallenge,
  findAccountByName,
  findUserById,
  findPlayerByUsername,
  getChallenges,
  getFriendsList,
  getProfile,
  getPlayerRecentMatches,
  getStats,
  issueRecoveryCode,
  logEvent,
  openCase,
  recordMatch,
  redeemRecoveryCode,
  recoveryIdByCode,
  removeFriend,
  setEquipped,
  type MatchMode,
  type RecoveryCodeIssueResult,
  type RecoveryCodeVerifyResult,
  verifyRecoveryCode,
  getRecoveryCodes,
} from './db';
import { accountId } from './auth';

// The progression identity for a request: the logged-in account, or '' (guest).
function playerId(req: Request): string {
  return accountId(req);
}

// Rate-limit key: the account when logged in, else the client IP.
function rateKeyFor(req: Request): string {
  return accountId(req) || req.ip || 'unknown';
}

// Clamp client-reported integers into a sane range — these are unranked,
// best-effort stats from a client-authoritative game (no anti-cheat).
function clampInt(value: unknown, max: number): number {
  const n =
    typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : 0;
  return Math.max(0, Math.min(max, n));
}

function cleanName(value: unknown): string {
  if (typeof value !== 'string') return 'Player';
  const trimmed = value.trim().slice(0, 24);
  return trimmed || 'Player';
}

// --- POST rate limiter ------------------------------------------------------
//
// Dependency-free, in-memory sliding window. Keyed by the player cookie id when
// present, else the request IP, so a single browser (or IP) can't spam match
// submissions. We keep recent POST timestamps per identity, drop ones older
// than the window before counting, and reject once the count hits the cap.
// State is process-local (fine for a single Node process); pruning on each call
// keeps the map from growing without bound.
const RATE_WINDOW_MS = 60_000; // rolling 60s window
const RATE_MAX_POSTS = 30; // at most 30 POSTs per identity per window
const postHits = new Map<string, number[]>();

// Returns true if this POST is allowed; records the hit when so.
function allowPost(identity: string, now: number): boolean {
  const cutoff = now - RATE_WINDOW_MS;
  const recent = (postHits.get(identity) ?? []).filter((ts) => ts > cutoff);
  if (recent.length >= RATE_MAX_POSTS) {
    // Keep the pruned list so it can't grow, but don't add this rejected hit.
    postHits.set(identity, recent);
    return false;
  }
  recent.push(now);
  postHits.set(identity, recent);
  return true;
}

// allowPost only prunes a key when that key is hit again, so identities that
// stop posting (rotated cookies / transient IPs) would linger forever. Sweep
// the whole map periodically and drop fully-expired entries so it can't leak.
const rateSweep = setInterval(() => {
  const cutoff = Date.now() - RATE_WINDOW_MS;
  for (const [id, hits] of postHits) {
    if (hits.length === 0 || hits[hits.length - 1] <= cutoff) postHits.delete(id);
  }
}, RATE_WINDOW_MS);
rateSweep.unref?.();

export const statsRouter = Router();

statsRouter.get('/stats', (req, res) => {
  const id = playerId(req);
  res.json({ stats: getStats(id) });
});

statsRouter.post('/stats', (req, res) => {
  // Rate-limit before doing any work. Prefer the existing cookie id (read
  // directly, before playerId() may mint a fresh one) and fall back to the
  // request IP for cookie-less callers. On exceed, reject without recording.
  const rateKey = rateKeyFor(req);
  if (!allowPost(rateKey, Date.now())) {
    res.status(429).json({ error: 'rate_limited' });
    return;
  }

  const id = playerId(req);
  const body = (req.body ?? {}) as Record<string, unknown>;

  // Clamp to PLAUSIBLE per-match values, then cross-validate so a forged body
  // can't manufacture an impossible match (e.g. 100k headshots / 0 kills) to
  // farm cosmetic XP. This is a client-authoritative game with no in-match
  // anti-cheat, so these caps — plus the per-match XP cap and rate limit — are
  // what bound progression abuse. Stakes are low (cosmetic-only, self-affecting).
  const kills = clampInt(body.kills, 200);
  const deaths = clampInt(body.deaths, 500);
  const shotsFired = clampInt(body.shotsFired, 5_000);
  const shotsHit = Math.min(clampInt(body.shotsHit, 5_000), shotsFired);
  // You can't headshot or streak more times than you have kills.
  const headshots = Math.min(clampInt(body.headshots, 200), kills);
  const bestStreak = Math.min(clampInt(body.bestStreak, 200), kills);
  const wins = body.won === true ? 1 : 0;
  const offline = body.offline === true;
  const accuracy = shotsFired > 0 ? (shotsHit / shotsFired) * 100 : 0;
  // Game mode is persisted in mode-specific leaderboard buckets and the audit row.
  // Whitelisted so a forged body can't pollute either breakdown.
  const mode: MatchMode | undefined =
    typeof body.mode === 'string' && ['ffa', 'duel', 'tdm', 'ctf', 'lms', 'gun-game', 'ranked'].includes(body.mode)
      ? (body.mode as MatchMode)
      : undefined;

  // Leaderboard name is the account username (moderated at registration), never
  // the client-supplied display name — so the standings can't show a forged
  // slur. Guests (id === '') don't record a row at all; the fallback is defensive.
  const account = id ? findUserById(id) : undefined;
  const result = recordMatch({
    playerId: id,
    userName: account?.username ?? cleanName(body.name),
    kills,
    deaths,
    wins,
    bestStreak,
    headshots,
    shotsFired,
    shotsHit,
    accuracy,
    offline,
    mode,
    now: Date.now(),
  });

  // Audit every recorded match (account + guest) for moderation + future metrics.
  logEvent({
    event: 'match',
    actorId: id,
    actorName: account?.username ?? cleanName(body.name),
    detail: { kills, deaths, won: wins === 1, headshots, accuracy: Math.round(accuracy), offline, xp: result.xpGained, mode },
    ip: req.ip,
  });

  // Stats (legacy shape) plus the progression delta so the client can show the
  // end-of-match XP bar / LEVEL UP / new-unlock moment immediately.
  res.json({
    stats: result.stats,
    xpGained: result.xpGained,
    creditsGained: result.creditsGained,
    leveledUp: result.leveledUp,
    newUnlocks: result.newUnlocks,
    progression: result.progression,
  });
});

// Full profile for the lobby (level/XP/credits/unlocked/equipped + career stats).
statsRouter.get('/profile', (req, res) => {
  const id = playerId(req);
  res.json({ profile: getProfile(id) });
});

// Equip an owned cosmetic. Rate-limited + server-validated.
statsRouter.post('/equip', (req, res) => {
  const rateKey = rateKeyFor(req);
  if (!allowPost(rateKey, Date.now())) {
    res.status(429).json({ error: 'rate_limited' });
    return;
  }
  const id = playerId(req);
  const body = (req.body ?? {}) as Record<string, unknown>;
  const slot = typeof body.slot === 'string' ? body.slot : '';
  const cosmeticId = typeof body.id === 'string' ? body.id : '';
  const result = setEquipped(id, slot, cosmeticId);
  res.status(result.ok ? 200 : 400).json(result);
});

// Buy a credits-priced cosmetic. Rate-limited + server-validated.
statsRouter.post('/shop/buy', (req, res) => {
  const rateKey = rateKeyFor(req);
  if (!allowPost(rateKey, Date.now())) {
    res.status(429).json({ error: 'rate_limited' });
    return;
  }
  const id = playerId(req);
  const body = (req.body ?? {}) as Record<string, unknown>;
  const cosmeticId = typeof body.id === 'string' ? body.id : '';
  const result = buyCosmetic(id, cosmeticId);
  res.status(result.ok ? 200 : 400).json(result);
});

// Open a hat case (credits-funded, server-authoritative roll). Rate-limited.
statsRouter.post('/shop/open-case', (req, res) => {
  const rateKey = rateKeyFor(req);
  if (!allowPost(rateKey, Date.now())) {
    res.status(429).json({ error: 'rate_limited' });
    return;
  }
  const id = playerId(req);
  res.status(200).json(openCase(id));
});

// Current daily/weekly challenges with progress + claim state.
statsRouter.get('/challenges', (req, res) => {
  const id = playerId(req);
  res.json({ challenges: getChallenges(id, Date.now()) });
});

// Claim a completed challenge's reward. Rate-limited + server-validated.
statsRouter.post('/challenges/claim', (req, res) => {
  const rateKey = rateKeyFor(req);
  if (!allowPost(rateKey, Date.now())) {
    res.status(429).json({ error: 'rate_limited' });
    return;
  }
  const id = playerId(req);
  const body = (req.body ?? {}) as Record<string, unknown>;
  const challengeId = typeof body.id === 'string' ? body.id : '';
  const result = claimChallenge(id, challengeId, Date.now());
  res.status(result.ok ? 200 : 400).json(result);
});

// ── Recovery codes (Phase 4) ────────────────────────────────────────────────
// Optional, account-less recovery. Issue a secret code that re-binds a new
// browser's session to an existing player_id. No email/password.

statsRouter.post('/recovery/issue', (req, res) => {
  const id = playerId(req);
  if (!id) {
    res.status(400).json({ error: 'no_account' });
    return;
  }
  const rateKey = rateKeyFor(req);
  if (!allowPost(rateKey, Date.now())) {
    res.status(429).json({ error: 'rate_limited' });
    return;
  }
  const result = issueRecoveryCode(id, Date.now());
  if (!result.ok) {
    res.status(500).json(result);
    return;
  }
  logEvent({
    event: 'recovery.issue',
    actorId: id,
    actorName: findUserById(id)?.username ?? 'Player',
    detail: { expiresAt: result.expiresAt },
    ip: req.ip,
  });
  res.json(result);
});

statsRouter.post('/recovery/verify', (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const code = typeof body.code === 'string' ? body.code.trim().toLowerCase() : '';
  if (!code) {
    res.status(400).json({ error: 'bad_code' });
    return;
  }
  const result = verifyRecoveryCode(code, Date.now());
  if (!result.ok) {
    res.status(400).json(result);
    return;
  }
  res.json(result);
});

statsRouter.post('/recovery/redeem', (req, res) => {
  const id = playerId(req);
  if (!id) {
    res.status(400).json({ error: 'no_session' });
    return;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const code = typeof body.code === 'string' ? body.code.trim().toLowerCase() : '';
  if (!code) {
    res.status(400).json({ error: 'bad_code' });
    return;
  }
  // Verify first, then redeem.
  const verify = verifyRecoveryCode(code, Date.now());
  if (!verify.ok) {
    res.status(400).json(verify);
    return;
  }
  // The code must map to THIS account (the one holding the session we're rebinding).
  if (verify.playerId !== id) {
    res.status(403).json({ error: 'wrong_account' });
    return;
  }
  const codeId = recoveryIdByCode(code);
  if (!codeId || !redeemRecoveryCode(codeId, Date.now())) {
    res.status(500).json({ error: 'internal' });
    return;
  }
  logEvent({
    event: 'recovery.redeem',
    actorId: id,
    actorName: findUserById(id)?.username ?? 'Player',
    ip: req.ip,
  });
  res.json({ ok: true });
});

// Public profile: look up a player by username (no auth required).
statsRouter.get('/players/:username', (req, res) => {
  const username = (typeof req.params.username === 'string' ? req.params.username : '').toLowerCase().trim();
  if (!username) {
    res.status(400).json({ error: 'bad_username' });
    return;
  }
  const player = findPlayerByUsername(username);
  if (!player) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const profile = getProfile(player.id);
  const recent = getPlayerRecentMatches(player.id, 10);
  res.json({
    profile,
    recentMatches: recent,
    username: player.username,
    isAdmin: player.isAdmin,
    isVerified: player.isVerified,
  });
});

statsRouter.get('/recovery/codes', (req, res) => {
  const id = playerId(req);
  if (!id) {
    res.status(400).json({ error: 'no_account' });
    return;
  }
  res.json({ codes: getRecoveryCodes(id, 10) });
});

// ── Friends / parties (Phase 4) ─────────────────────────────────────────────

statsRouter.get('/friends', (req, res) => {
  const id = playerId(req);
  if (!id) {
    res.status(400).json({ error: 'no_account' });
    return;
  }
  res.json({ friends: getFriendsList(id, 100) });
});

statsRouter.post('/friends/add', (req, res) => {
  const id = playerId(req);
  if (!id) {
    res.status(400).json({ error: 'no_account' });
    return;
  }
  const rateKey = rateKeyFor(req);
  if (!allowPost(rateKey, Date.now())) {
    res.status(429).json({ error: 'rate_limited' });
    return;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const friendUsername = typeof body.username === 'string' ? body.username.trim().toLowerCase() : '';
  if (!friendUsername) {
    res.status(400).json({ error: 'bad_username' });
    return;
  }
  const target = findUserById(id);
  if (!target) {
    res.status(400).json({ error: 'no_account' });
    return;
  }
  // Resolve the friend username to an account id.
  const friend = findAccountByName(friendUsername);
  if (!friend) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  if (friend.id === id) {
    res.status(400).json({ error: 'self_friend' });
    return;
  }
  const added = addFriend(id, friend.id, Date.now());
  if (!added) {
    res.status(409).json({ error: 'already_friends' });
    return;
  }
  logEvent({
    event: 'friend.add',
    actorId: id,
    actorName: target.username,
    targetId: friend.id,
    ip: req.ip,
  });
  res.json({ ok: true, friend: { id: friend.id, username: friend.username } });
});

statsRouter.post('/friends/remove', (req, res) => {
  const id = playerId(req);
  if (!id) {
    res.status(400).json({ error: 'no_account' });
    return;
  }
  const rateKey = rateKeyFor(req);
  if (!allowPost(rateKey, Date.now())) {
    res.status(429).json({ error: 'rate_limited' });
    return;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const friendUsername = typeof body.username === 'string' ? body.username.trim().toLowerCase() : '';
  if (!friendUsername) {
    res.status(400).json({ error: 'bad_username' });
    return;
  }
  const target = findUserById(id);
  if (!target) {
    res.status(400).json({ error: 'no_account' });
    return;
  }
  const friend = findAccountByName(friendUsername);
  if (!friend) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const removed = removeFriend(id, friend.id);
  if (!removed) {
    res.status(404).json({ error: 'not_friends' });
    return;
  }
  logEvent({
    event: 'friend.remove',
    actorId: id,
    actorName: target.username,
    targetId: friend.id,
    ip: req.ip,
  });
  res.json({ ok: true });
});


