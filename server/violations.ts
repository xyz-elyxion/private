// Player-facing moderation violations. Accounts are keyed by their session id;
// guests are keyed by the stable igpid cookie. Appeals are private to the
// violation owner and are reviewed from the admin dashboard.

import { Router } from 'express';
import { accountId, ensureGuestId, guestId } from './auth';
import {
  findUserById,
  getViolation,
  listViolations,
  logEvent,
  submitViolationAppeal,
} from './db';

export const violationsRouter = Router();

const APPEAL_MIN = 10;
const APPEAL_MAX = 2000;

function identity(req: Parameters<typeof accountId>[0]): string {
  return accountId(req) || guestId(req);
}

// The caller's own warnings/strikes. A guest receives an igpid cookie on the
// first request, so violations issued against that browser remain visible.
violationsRouter.get('/violations', (req, res) => {
  const id = identity(req);
  if (!id) {
    ensureGuestId(req, res);
    res.json({ violations: [] });
    return;
  }
  res.json({ violations: listViolations({ playerId: id, limit: 100 }) });
});

// Submit or replace an appeal for an active violation owned by this caller.
violationsRouter.post('/violations/:id/appeal', (req, res) => {
  const id = identity(req);
  if (!id) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  const violationId = parseInt(req.params.id, 10);
  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
  if (!Number.isFinite(violationId) || violationId <= 0) {
    res.status(400).json({ error: 'bad_id' });
    return;
  }
  if (text.length < APPEAL_MIN || text.length > APPEAL_MAX) {
    res.status(400).json({ error: 'bad_appeal' });
    return;
  }
  const violation = getViolation(violationId);
  if (!violation || violation.playerId !== id) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  if (violation.status !== 'active') {
    res.status(409).json({ error: 'not_active' });
    return;
  }
  if (!submitViolationAppeal(violationId, id, text)) {
    res.status(409).json({ error: 'appeal_unavailable' });
    return;
  }
  const account = accountId(req) ? findUserById(id) : undefined;
  logEvent({
    event: 'violation.appeal',
    actorId: id,
    actorName: account?.username || violation.playerName,
    targetId: String(violationId),
    detail: { text: text.slice(0, 200) },
    ip: req.ip,
  });
  res.json({ ok: true, id: violationId, appealStatus: 'pending' });
});
