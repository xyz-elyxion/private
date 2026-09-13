// In-game "Donate credits" — players give credits from their OWN balance; the
// amount is split EQUALLY among every player present on the Donate page
// (presence heartbeat within 60s, donor included). No real money anywhere —
// no Stripe, no payment processing, purely an in-game credits economy feature.
//
// Endpoints (mounted at /api/donate):
//   POST /heartbeat  — "I'm on the Donate page" (20s client cadence, 60s TTL)
//   POST /leave      — explicit remove on page unmount
//   POST /donate     — atomic debit + equal split, returns the outcome
//   GET  /state      — recent splits + live presence + caller balance

import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import { accountId } from './auth';
import { findUserById as findAccountById } from './db';
import {
  DONATE_MAX,
  DONATE_MIN,
  creditsBalance,
  donateCredits,
  donationState,
  presenceHeartbeat,
  presenceList,
  presenceRemove,
} from './donations-db';

export const donateRouter = Router();

function nameOf(req: { body?: unknown }, id: string): string {
  const fromBody = typeof (req.body as { name?: unknown } | undefined)?.name === 'string'
    ? String((req.body as { name?: unknown }).name).slice(0, 32)
    : '';
  return fromBody || findAccountById(id)?.username || 'Player';
}

donateRouter.post('/heartbeat', (req, res) => {
  const id = accountId(req);
  if (!id) {
    res.status(401).json({ error: 'login_required' });
    return;
  }
  presenceHeartbeat({ playerId: id, name: nameOf(req, id) });
  res.json({ ok: true });
});

donateRouter.post('/leave', (req, res) => {
  const id = accountId(req);
  if (id) presenceRemove(id);
  res.json({ ok: true });
});

donateRouter.post('/donate', (req, res) => {
  const id = accountId(req);
  if (!id) {
    res.status(401).json({ error: 'login_required' });
    return;
  }
  const amount = Math.floor(Number((req.body as { amount?: unknown }).amount));
  const result = donateCredits({
    playerId: id,
    donorName: nameOf(req, id),
    amount,
    sessionId: randomBytes(16).toString('hex'),
  });
  if (!result.ok) {
    res.status(result.reason === 'insufficient' ? 402 : 400).json(result);
    return;
  }
  res.json(result);
});

// Public state: recent splits (names + credit amounts), presence, and the
// caller's own balance when logged in.
donateRouter.get('/state', (req, res) => {
  const id = accountId(req);
  res.json({
    ...donationState(),
    presence: presenceList(),
    balance: id ? creditsBalance(id) : null,
    min: DONATE_MIN,
    max: DONATE_MAX,
    loggedIn: !!id,
  });
});
