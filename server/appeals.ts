// Ban appeals — player-facing routes.
//
// POST /api/appeal            — submit an appeal against a SPECIFIC ban (banId required;
//                               the ban must belong to the caller; one appeal per ban).
// GET  /api/appeal/mine       — the caller's appeals (+ joined ban context).
// GET  /api/appeal/eligible   — the caller's appealable bans (active or expired; lifted
//                               bans stay appealable so a mistake can be revisited).
//
// The core rule: an appeal must reference a ban. No ban selected → 400
// `ban_required`; wrong owner → 403; already appealed → 409.

import { Router } from 'express';
import { accountId } from './auth';
import { findUserById } from './db';
import { logEvent } from './db';
import {
  banHasAppeal,
  listAppealsForPlayer,
  listBanHistory,
  submitAppeal,
} from './bans';

export const appealRouter = Router();

const MESSAGE_MIN = 20;
const MESSAGE_MAX = 4000;
// One appeal per 30 minutes per account — appeals are deliberate, not chatty.
const RATE_WINDOW_MS = 30 * 60_000;
const rateHits = new Map<string, number[]>();

function allowSubmit(identity: string, now: number): boolean {
  const cutoff = now - RATE_WINDOW_MS;
  const recent = (rateHits.get(identity) ?? []).filter((ts) => ts > cutoff);
  if (recent.length >= 1) {
    rateHits.set(identity, recent);
    return false;
  }
  recent.push(now);
  rateHits.set(identity, recent);
  return true;
}
const rateSweep = setInterval(() => {
  const cutoff = Date.now() - RATE_WINDOW_MS;
  for (const [id, hits] of rateHits) {
    if (hits.length === 0 || hits[hits.length - 1] <= cutoff) rateHits.delete(id);
  }
}, RATE_WINDOW_MS);
rateSweep.unref?.();

appealRouter.get('/appeal/eligible', (req, res) => {
  const id = accountId(req);
  if (!id) {
    res.status(401).json({ error: 'login_required' });
    return;
  }
  // Appealable: every ban on this account that hasn't been appealed yet.
  const bans = listBanHistory(200).filter((b) => b.playerId === id && !banHasAppeal(b.id));
  res.json({ bans });
});

appealRouter.get('/appeal/mine', (req, res) => {
  const id = accountId(req);
  if (!id) {
    res.status(401).json({ error: 'login_required' });
    return;
  }
  res.json({ appeals: listAppealsForPlayer(id) });
});

appealRouter.post('/appeal', (req, res) => {
  const now = Date.now();
  const id = accountId(req);
  if (!id) {
    res.status(401).json({ error: 'login_required' });
    return;
  }
  const account = findUserById(id);
  if (!account) {
    res.status(401).json({ error: 'login_required' });
    return;
  }
  if (!allowSubmit(id, now)) {
    res.status(429).json({ error: 'rate_limited' });
    return;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  // THE RULE: you must select the ban you're appealing. A bare appeal with no
  // banId is rejected outright.
  const banId = Number(body.banId);
  if (!Number.isFinite(banId) || banId <= 0) {
    res.status(400).json({ error: 'ban_required' });
    return;
  }
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (message.length < MESSAGE_MIN || message.length > MESSAGE_MAX) {
    res.status(400).json({ error: 'bad_message' });
    return;
  }
  const result = submitAppeal({ banId, playerId: id, playerName: account.username, message });
  if (!result.ok) {
    res.status(
      result.reason === 'not_your_ban' ? 403 :
      result.reason === 'already_appealed' ? 409 : 404,
    ).json({ error: result.reason });
    return;
  }
  logEvent({
    event: 'appeal.submit',
    actorId: id,
    actorName: account.username,
    targetId: String(result.id),
    detail: { appealId: result.id, banId },
    ip: req.ip,
    now,
  });
  res.json({ ok: true, id: result.id });
});
