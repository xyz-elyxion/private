import { Router, type Request } from 'express';
import { accountId } from './auth';
import { claimSeasonReward, getSeasonProgress } from './db';

export const seasonRouter = Router();

seasonRouter.get('/season', (req: Request, res) => {
  res.json({ season: getSeasonProgress(accountId(req)) });
});

seasonRouter.post('/season/claim', (req: Request, res) => {
  const tier = typeof req.body?.tier === 'number' ? Math.floor(req.body.tier) : 0;
  const result = claimSeasonReward(accountId(req), tier);
  res.status(result.ok ? 200 : 400).json(result);
});