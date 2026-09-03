// "Duel the AI" brain store + REST API.
//
// One shared global brain per difficulty tier lives in data/*.sqlite (the game's
// data dir). Inference runs in the browser (Game → LearningBot runs the stored
// policy); every finished duel POSTs its policy-gradient episode here, and this
// module folds the gradient into the stored weights with the SAME learning math
// the client used to produce it (both import src/game/rl-brain.ts, so nothing
// can drift). Because the brain is a shared global object, every player's duels
// train it — it genuinely gets stronger over time, and the state survives
// restarts, exactly like the other data/ tables.

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { Router, type Request } from 'express';
import {
  applyRlGradient,
  clampRlOutcome,
  RL_DIFFICULTIES,
  seedRlBrain,
  type RlBrain,
  type RlDifficulty,
} from '../src/game/rl-brain';

const dataDir = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(process.cwd(), 'data');
fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const databasePath = process.env.DATABASE_PATH
  ? path.resolve(process.env.DATABASE_PATH)
  : path.join(dataDir, 'elyxion.sqlite');

const sqlite = new Database(databasePath);
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('busy_timeout = 5000');
sqlite.pragma('synchronous = NORMAL');

sqlite.exec(`
CREATE TABLE IF NOT EXISTS elyxion_ai_brain (
  difficulty   TEXT PRIMARY KEY,
  mov_w        TEXT NOT NULL, -- JSON number[] (RL_MOV_LEN: forward-axis weights, then strafe-axis)
  fire_w       TEXT NOT NULL, -- JSON number[] (RL_BUTTON_LEN: jump/fire/dash/boost heads)
  gen          INTEGER NOT NULL DEFAULT 0, -- gradient updates applied (≈ recorded duels)
  duels        INTEGER NOT NULL DEFAULT 0, -- duels that contributed to the brain
  bot_frags    INTEGER NOT NULL DEFAULT 0, -- cumulative frags the bot scored
  human_frags  INTEGER NOT NULL DEFAULT 0, -- cumulative frags humans scored
  updated_at   INTEGER NOT NULL DEFAULT 0
);`);

type BrainRow = {
  difficulty: string;
  mov_w: string;
  fire_w: string;
  gen: number;
  duels: number;
  bot_frags: number;
  human_frags: number;
  updated_at: number;
};

function parseJson(s: string, len: number, fallback: number[] | null): number[] | null {
  try {
    const v = JSON.parse(s) as unknown;
    if (!Array.isArray(v) || v.length !== len) return fallback;
    if (!v.every((x) => typeof x === 'number' && Number.isFinite(x))) return fallback;
    return v;
  } catch {
    return fallback;
  }
}

const seedSql = (seed: RlBrain): [string, string] => [
  JSON.stringify(seed.weights.mov),
  JSON.stringify(seed.weights.buttons),
];

const rowToBrain = (r: BrainRow | undefined, difficulty: RlDifficulty): RlBrain | null => {
  const seed = seedRlBrain(difficulty);
  if (!r) return seed;
  const mov = parseJson(r.mov_w, seed.weights.mov.length, null);
  const buttons = parseJson(r.fire_w, seed.weights.buttons.length, null);
  if (!mov || !buttons) return null; // stale/corrupt format → caller re-seeds
  return {
    difficulty,
    gen: Math.max(0, Math.floor(r.gen) || 0),
    duels: Math.max(0, Math.floor(r.duels) || 0),
    botFrags: Math.max(0, Math.floor(r.bot_frags) || 0),
    humanFrags: Math.max(0, Math.floor(r.human_frags) || 0),
    updatedAt: Math.max(0, Math.floor(r.updated_at) || 0),
    weights: { mov, buttons },
  };
};

// Read one tier (seeding the row on first access). A row stored in an OLDER
// action-format (wrong array lengths — e.g. the earlier macro-action space) is
// re-seeded on read with its tallies wiped: a fresh brain beats a lying one.
// Public — the client needs the weights to run the bot, so this endpoint is
// unauthenticated like the rest of the /api read surface.
export function getRlBrain(difficulty: RlDifficulty): RlBrain {
  const seed = seedRlBrain(difficulty);
  const row = sqlite
    .prepare(`SELECT * FROM elyxion_ai_brain WHERE difficulty = ?`)
    .get(difficulty) as BrainRow | undefined;
  if (row) {
    const brain = rowToBrain(row, difficulty);
    if (brain) return brain;
    // Stale shape — reseed in place (weights + tallies) to the current format.
    const [movW, buttonsW] = seedSql(seed);
    sqlite
      .prepare(
        `UPDATE elyxion_ai_brain
            SET mov_w = ?, fire_w = ?, gen = 0, duels = 0, bot_frags = 0,
                human_frags = 0, updated_at = 0
          WHERE difficulty = ?`,
      )
      .run(movW, buttonsW, difficulty);
    return seed;
  }
  const [movW, buttonsW] = seedSql(seed);
  sqlite
    .prepare(
      `INSERT OR IGNORE INTO elyxion_ai_brain (difficulty, mov_w, fire_w, gen, duels, bot_frags, human_frags, updated_at)
       VALUES (?, ?, ?, 0, 0, 0, 0, 0)`,
    )
    .run(difficulty, movW, buttonsW);
  return seed;
}

export function listRlBrains(): RlBrain[] {
  return RL_DIFFICULTIES.map((d) => getRlBrain(d));
}

// Fold one finished duel's validated gradient into the stored brain (w += lr·g,
// clamped) and update the running frag counters. Returns the fresh brain, or
// null when the report was malformed (caller replies 400).
export function recordRlDuel(report: unknown): RlBrain | null {
  const r = clampRlOutcome(report);
  if (!r.difficulty || r.movGrad.length === 0 || r.buttonsGrad.length === 0) {
    return null; // no brain / gradient to apply
  }

  const cur = getRlBrain(r.difficulty);
  const nextWeights = applyRlGradient(cur.weights, r.movGrad, r.buttonsGrad);
  const now = Date.now();
  sqlite
    .prepare(
      `UPDATE elyxion_ai_brain
         SET mov_w = @movW, fire_w = @buttonsW, gen = gen + 1, duels = duels + 1,
             bot_frags = bot_frags + @botFrags, human_frags = human_frags + @humanFrags,
             updated_at = @now
       WHERE difficulty = @difficulty`,
    )
    .run({
      movW: JSON.stringify(nextWeights.mov),
      buttonsW: JSON.stringify(nextWeights.buttons),
      botFrags: r.botFrags,
      humanFrags: r.humanFrags,
      now,
      difficulty: r.difficulty,
    });
  return getRlBrain(r.difficulty);
}

// Reseed a tier's shared brain to its never-trained policy: weights back to the
// deterministic seed, gen/duels/cumulative frags wiped. Admin-only (the /api/admin
// reset route is session-gated + audit-logged — see server/admin.ts). Returns the
// fresh brain with updatedAt stamped so the dashboard shows when it was reset.
export function resetRlBrain(difficulty: RlDifficulty): RlBrain {
  const seed = seedRlBrain(difficulty);
  const now = Date.now();
  const [movW, buttonsW] = seedSql(seed);
  sqlite
    .prepare(
      `UPDATE elyxion_ai_brain
          SET mov_w = @movW, fire_w = @buttonsW, gen = 0, duels = 0,
              bot_frags = 0, human_frags = 0, updated_at = @now
        WHERE difficulty = @difficulty`,
    )
    .run({ movW, buttonsW, now, difficulty });
  return { ...seed, updatedAt: now };
}

// ── Rate limiting (mirror server/stats.ts: process-local sliding window) ─────
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 20; // a duel every ~3s per identity is already abusive
const hits = new Map<string, number[]>();
function allowReport(identity: string, now: number): boolean {
  const cutoff = now - RATE_WINDOW_MS;
  const recent = (hits.get(identity) ?? []).filter((ts) => ts > cutoff);
  if (recent.length >= RATE_MAX) {
    hits.set(identity, recent);
    return false;
  }
  recent.push(now);
  hits.set(identity, recent);
  return true;
}
const sweep = setInterval(() => {
  const cutoff = Date.now() - RATE_WINDOW_MS;
  for (const [id, list] of hits) {
    if (list.length === 0 || list[list.length - 1] <= cutoff) hits.delete(id);
  }
}, RATE_WINDOW_MS);
sweep.unref?.();

export const aiBrainRouter = Router();

// All three persisted brains (+ per-tier training stats) for the Duel-the-AI
// lobby modal. Weights power the in-match bot; gen/duels/frags power the
// "how much it has trained" readout.
aiBrainRouter.get('/ai/brain', (_req: Request, res) => {
  res.json({ brains: listRlBrains() });
});

// A duel finished: fold its training episode (the client-computed REINFORCE
// gradient, validated below) into the shared brain for that tier. Returns the
// updated brain so the client could re-render training stats immediately.
aiBrainRouter.post('/ai/report', (req: Request, res) => {
  const identity =
    (req.headers.cookie ?? '').length > 0 ? (req.headers.cookie ?? '') : req.ip ?? 'unknown';
  if (!allowReport(identity, Date.now())) {
    res.status(429).json({ error: 'rate_limited' });
    return;
  }
  const brain = recordRlDuel(req.body);
  if (!brain) {
    res.status(400).json({ error: 'bad_report' });
    return;
  }
  res.json({ brain });
});
