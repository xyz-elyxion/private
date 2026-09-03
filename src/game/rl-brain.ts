// The brain behind "Duel the AI" — a 1v1 duel against a reinforcement-learning
// bot. Pure logic only (no THREE/DOM), so the SAME module drives inference in
// the browser (Game/LearningBot) and the server-side store (which persists one
// shared global brain per difficulty tier in data/*.sqlite and applies the
// per-duel gradient update).
//
// The agent does NOT choose from premade behaviours (no "approach"/"retreat"/
// "strafe" actions). Instead it outputs LOW-LEVEL control — the same inputs a
// player has — and learns to use them purely from experience:
//   • continuous forward axis  f ∈ [−1,1]  (how hard to press W/S)
//   • continuous strafe axis   s ∈ [−1,1]  (how hard to press A/D)
//   • continuous aim point    aimX/aimY ∈ [−1,1]  (WHERE to point — a lateral /
//     vertical offset from the enemy's chest in metres, clamped to AIM_SPAN).
//     The bot turns toward that point, so aiming is LEARNED, not an aimbot: a
//     fresh brain points in the wrong place and misses until the gradient pulls
//     the aim onto the enemy. Shots resolve along where the bot is actually
//     looking.
//   • jump / fire / dash / boost  ∈ {0,1}  (whether to press the button this
//     decision) — each only does something when the game lets it (grounded for
//     a hop, off cooldown for dash/boost/rail), exactly like a player's keypress
//     is ignored when the game state forbids it.
// Retreating, circle-strafing, dodging, chasing, aiming — all of that has to
// EMERGE from the gradient, never being wired in.
//
// How it learns: each duel is one training episode of a REINFORCE
// (policy-gradient) agent. While the duel runs the bot logs the compact state
// features + the low-level inputs it sampled at a fixed decision cadence.
// Frags/deaths become sparse rewards (+1 the bot scores, −1 when it dies) with
// an exponential time discount so only decisions near the event get credited.
// At match end the episode gradient is computed (REINFORCE with a per-episode
// mean return as baseline) and POSTed; the server folds it into the stored
// brain. A shared global brain per tier means every player's duels train the
// same agent — it genuinely gets stronger the more it is dueled.
//
// The policy:
//   movement  — four independent tanh-mean Gaussians (σ fixed):
//               f ~ N(μf, σm), s ~ N(μs, σm), aimX ~ N(μaX, σa), aimY ~ N(μaY, σa)
//               all samples clipped to [−1,1] for execution
//   triggers  — four independent sigmoid heads over the same features,
//               one per button (jump / fire / dash / boost)

// State features (per decision): a compact, normalized snapshot of the duel
// from the bot's perspective. Order must never change once duels are being
// recorded (feature meanings are baked into stored weights).
export const RL_FEATURE_COUNT = 13;
export const RL_FEATURE_NAMES = [
  'dist', // horizontal distance to target, ÷25, clamped 0..1
  'cosB', // cos of bearing to the target in the bot's local frame (1 = ahead)
  'sinB', // sin of bearing to the target in the bot's local frame (±1 = to a side)
  'elev', // target height delta (bot-relative), ÷8, clamped −1..1
  'grounded', // 1 when the bot is on the ground
  'speed', // bot horizontal speed ÷20
  'enemySpeed', // target lateral speed ÷15
  'aimErr', // |facing − yaw-to-target| ÷ π (0 = looking straight at it)
  'recentDeath', // decays from 1 over ~1s after the bot dies
  'fireCd', // rail cooldown remaining ÷ RAIL_COOLDOWN (0 = ready)
  'dashCd', // dash cooldown remaining ÷ DASH_COOLDOWN (0 = ready)
  'boostCd', // boost cooldown remaining ÷ tier boost cooldown (0 = ready)
  'bias', // constant 1
] as const;

// The movement head is four continuous axes (forward, strafe, aimX, aimY); the
// trigger head is four buttons. Stored weights:
//   mov     = [μf (F), μs (F), μaimX (F), μaimY (F)]
//   buttons = [jump (F), fire (F), dash (F), boost (F)]
export const RL_MOV_LEN = 4 * RL_FEATURE_COUNT;
export const RL_BUTTON_LEN = 4 * RL_FEATURE_COUNT;
// Gaussian exploration σ on the movement axes. 1.0 is "pretty much whatever
// direction, plus the learned mean" — a strong exploration floor so the agent
// keeps trying new steering even after a mean has formed.
export const RL_MOVE_SIGMA = 0.85;
// Aim exploration σ — much tighter than movement: the agent samples where to
// point with a ±0.2 wobble (vs ±0.85 on the legs), so early aim is wobbly but
// not drunk, and the gradient visibly tightens it onto the enemy.
export const RL_AIM_SIGMA = 0.2;
// The exact Gaussian policy-gradient divides by σ², which would amplify the
// tight-σ aim axes ~18× over the movement axes and swamp every update. Because
// σ is fixed per axis, 1/σ² is effectively a per-axis learning-rate constant,
// so the aim axes' contribution is damped to movement-parity strength
// (multiply their gradient rows by RL_AIM_GRAD_SCALE in computeRlGradient).
export const RL_AIM_GRAD_SCALE = RL_AIM_SIGMA / RL_MOVE_SIGMA; // ≈ 0.235
// Per-SHOT reward shaping: every rail shot the learning bot fires resolves as a
// hit (+1, the frag) or a miss. A miss is NOT a flat penalty — it is scaled by
// how far the shot actually was from the target's chest (r = −RL_MISS_PENALTY ·
// min(4, missM / RL_MISS_DIST_REF)), timed right at the shot. The distance
// scaling is what makes the AIM head learnable: a flat miss penalty gives the
// aim no direction (samples on both sides of an off-centre mean miss equally
// and their gradients cancel), but penalizing far misses more than near ones
// creates a directional pull that drags the aim onto the chest over duels.
export const RL_MISS_PENALTY = 0.08;
// A miss this far from the target's chest (metres, perpendicular to the
// sightline) costs one full RL_MISS_PENALTY unit. Typical early-duel misses are
// 1–3 m → 2–6 units, vs +1 for an actual frag.
export const RL_MISS_DIST_REF = 0.5;
// Where an aim sample points: aimX/aimY ∈ [−1,1] map to these metres of lateral
// (perpendicular to the sightline) / vertical offset from the enemy's chest.
export const AIM_SPAN = 2.5; // ±2.5 m lateral (perpendicular to the sightline)
export const AIM_SPAN_V = 1.5; // ±1.5 m vertical offset from the chest

// Episode / learning hyper-parameters. These live here (shared) so the client
// gradient and the server-side apply step can never drift apart.
export const RL_DECIDE_INTERVAL = 0.35; // s between decisions (the policy cadence)
export const RL_GAMMA = 0.8; // reward discount per SECOND (time-based)
export const RL_CREDIT_HORIZON = 12; // s — how far back an event credits decisions
export const RL_LEARNING_RATE = 0.05; // gradient step applied per recorded duel
export const RL_WEIGHT_MAX = 20; // weight magnitude clamp (server + client)
export const RL_GRAD_NORM_MAX = 4000; // raw per-episode gradient L2 clamp (server)
export const RL_TRAJ_MAX = 2600; // client-side trajectory ring-buffer cap

type BotDifficultyLike = 'easy' | 'medium' | 'hard';
export type RlDifficulty = BotDifficultyLike;
export const RL_DIFFICULTIES: readonly RlDifficulty[] = ['easy', 'medium', 'hard'];
export const RL_DIFFICULTY_LABEL: Record<RlDifficulty, string> = {
  easy: 'Novice',
  medium: 'Learner',
  hard: 'Contender',
};
// Player-facing bot names per tier (shown in the killfeed/scoreboard/nameplate).
export const RL_BOT_NAMES: Record<RlDifficulty, string> = {
  easy: 'Mote',
  medium: 'Cinder',
  hard: 'Onyx',
};

export type RlBrainWeights = {
  mov: number[]; // length RL_MOV_LEN: [μf (F), μs (F), μaimX (F), μaimY (F)]
  buttons: number[]; // length RL_BUTTON_LEN: [jump, fire, dash, boost] columns of F
};
export type RlBrain = {
  difficulty: RlDifficulty;
  gen: number; // gradient updates applied (≈ recorded duels)
  duels: number; // duels folded into the brain
  botFrags: number; // cumulative frags the bot scored in recorded duels
  humanFrags: number; // cumulative frags humans scored in recorded duels
  updatedAt: number; // epoch ms of the last update (0 for a never-trained seed)
  weights: RlBrainWeights;
};

// What a bot logs per decision (features + the low-level inputs it sampled).
// Each trigger has an EXECUTED bit (jump/fire/dash/boost: 1 = the press did
// something that decision) plus an ALLOWED flag (could the press have worked at
// all? grounded for a hop, off cooldown for dash/boost/rail). The gradient uses
// both: a button press that the game state blocked was never a real choice, so
// it contributes NO gradient (action masking) instead of teaching the policy to
// never press.
export type RlTrajectory = {
  feats: number[][]; // rows × FEATURE_COUNT
  f: number[]; // sampled forward axis per row (clipped to [−1,1])
  s: number[]; // sampled strafe axis per row
  aimX: number[]; // sampled aim-point lateral offset per row
  aimY: number[]; // sampled aim-point vertical offset per row
  jump: number[]; // 1 = jump press executed
  fire: number[]; // 1 = rail fired
  dash: number[]; // 1 = dash executed
  boost: number[]; // 1 = boost executed
  allowJump: number[];
  allowFire: number[];
  allowDash: number[];
  allowBoost: number[];
  times: number[]; // seconds since duel start per row
};
// Reward events (+1 the bot fragged the human, −1 it died). Sorted ascending.
export type RlEvents = { t: number; r: number }[];

// Payload the client POSTs after a duel (the server applies + persists it).
export type RlReport = {
  difficulty: RlDifficulty;
  movGrad: number[]; // raw gradient (NOT lr-scaled — the server applies lr)
  buttonsGrad: number[];
  decided: number; // decision rows counted into the gradient
  fired: number; // shots the bot fired
  botFrags: number; // the bot's frags this duel
  botDeaths: number; // times the bot died
  humanFrags: number; // the human's frags this duel
  durationSec: number; // sim seconds the episode lasted
};

// The policy's deterministic outputs for a feature vector (no sampling) — used
// both at decision time (to sample) and at episode end (to replay the exact
// probabilities the actions were drawn from).
export type RlOutputs = {
  muF: number;
  muS: number;
  muAimX: number;
  muAimY: number;
  pJump: number;
  pFire: number;
  pDash: number;
  pBoost: number;
};
export function rlOutputs(w: RlBrainWeights, feat: number[]): RlOutputs {
  let zf = 0;
  let zs = 0;
  let zaX = 0;
  let zaY = 0;
  for (let f = 0; f < RL_FEATURE_COUNT; f++) {
    zf += w.mov[f] * feat[f];
    zs += w.mov[RL_FEATURE_COUNT + f] * feat[f];
    zaX += w.mov[2 * RL_FEATURE_COUNT + f] * feat[f];
    zaY += w.mov[3 * RL_FEATURE_COUNT + f] * feat[f];
  }
  let pJ = 0;
  let pF = 0;
  let pD = 0;
  let pB = 0;
  for (let f = 0; f < RL_FEATURE_COUNT; f++) {
    const x = feat[f];
    pJ += w.buttons[f] * x;
    pF += w.buttons[RL_FEATURE_COUNT + f] * x;
    pD += w.buttons[2 * RL_FEATURE_COUNT + f] * x;
    pB += w.buttons[3 * RL_FEATURE_COUNT + f] * x;
  }
  return {
    muF: Math.tanh(zf),
    muS: Math.tanh(zs),
    muAimX: Math.tanh(zaX),
    muAimY: Math.tanh(zaY),
    pJump: rlSigmoid(pJ),
    pFire: rlSigmoid(pF),
    pDash: rlSigmoid(pD),
    pBoost: rlSigmoid(pB),
  };
}

export function rlSigmoid(z: number): number {
  if (z >= 0) {
    const e = Math.exp(-z);
    return 1 / (1 + e);
  }
  const e = Math.exp(z);
  return e / (1 + e);
}

// Box–Muller standard normal from the RNG.
function gauss(rand: () => number): number {
  const u1 = Math.max(rand(), 1e-9);
  const u2 = rand();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

// One policy decision: sample the low-level inputs from the current policy.
// Movement axes are continuous Gaussians (clipped to [−1,1] for execution);
// each trigger button is an independent Bernoulli. Everything returned is what
// the episode row must log (the gradient replays these same distributions).
export function rlDecide(
  w: RlBrainWeights,
  feat: number[],
  rand: () => number,
): {
  f: number;
  s: number;
  aimX: number;
  aimY: number;
  jump: boolean;
  fire: boolean;
  dash: boolean;
  boost: boolean;
  out: RlOutputs;
} {
  const out = rlOutputs(w, feat);
  const clip = (v: number) => Math.max(-1, Math.min(1, v));
  return {
    f: clip(out.muF + gauss(rand) * RL_MOVE_SIGMA),
    s: clip(out.muS + gauss(rand) * RL_MOVE_SIGMA),
    aimX: clip(out.muAimX + gauss(rand) * RL_AIM_SIGMA),
    aimY: clip(out.muAimY + gauss(rand) * RL_AIM_SIGMA),
    jump: rand() < out.pJump,
    fire: rand() < out.pFire,
    dash: rand() < out.pDash,
    boost: rand() < out.pBoost,
    out,
  };
}

// Deterministic string hash (FNV-1a over a 32-bit state) → seed for the tier's
// initial weights, so client seeds and server seeds can never disagree.
function hashSeed(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function clampWeight(x: number): number {
  return Math.max(-RL_WEIGHT_MAX, Math.min(RL_WEIGHT_MAX, x));
}

// ── Initial (never-trained) policy per tier ──────────────────────────────────
// Priors here are deliberately weak heuristics, NOT canned behaviours — they
// only shape where the fresh brain starts:
//   • movement means point at the target when it's in view (μf ≈ cosB,
//     μs ≈ sinB, softened by tier) so a fresh bot walks toward the fight
//     instead of milling about; every other weight is small noise.
//   • the AIM starts OFF the enemy (aimOffset = AIM_SPAN fraction, tier-gated)
//     and the gradient pulls it onto the chest as duels are won/lost — aiming
//     is genuinely learned, and harder tiers start closer to on-target.
//   • fire has only a base cadence (tier bias): WHEN shooting is worthwhile
//     (i.e. only once the aim is on the enemy) is learned from the dense
//     per-shot hit/miss rewards, not wired in.
//   • jump/dash/boost start rare (negative bias) and must be DISCOVERED.
const SEED = {
  easy: { fireBias: -2.6, chase: 0.55, noise: 0.1, aimOffset: 0.95 },
  medium: { fireBias: -1.9, chase: 0.65, noise: 0.08, aimOffset: 0.7 },
  hard: { fireBias: -1.2, chase: 0.75, noise: 0.06, aimOffset: 0.45 },
} as const;
const F = RL_FEATURE_COUNT;
const COL = {
  cosB: 1,
  sinB: 2,
  aimErr: 7,
  bias: 12,
} as const;
function seedWeights(difficulty: RlDifficulty): RlBrainWeights {
  const rng = mulberry32(hashSeed(`elyxion-rl-v3:${difficulty}`));
  const s = SEED[difficulty];
  const noise = () => gauss(rng) * s.noise;
  const mov: number[] = [];
  for (let i = 0; i < RL_MOV_LEN; i++) mov.push(noise());
  mov[COL.cosB] = s.chase; // f axis: walk toward a visible target
  mov[F + COL.sinB] = s.chase * 0.6; // s axis: drift toward its bearing
  // Aim head: starts aiming AIM_SPAN·aimOffset off to the side (and slightly
  // low) — the gradient has to drag the aim onto the chest before shots land.
  mov[2 * F + COL.bias] = s.aimOffset; // aimX mean → +lateral offset
  mov[3 * F + COL.bias] = -0.25; // aimY mean → a touch low
  const buttons: number[] = [];
  for (let i = 0; i < RL_BUTTON_LEN; i++) buttons.push(noise());
  // Jump (segment 0), fire (1), dash (2), boost (3). No aimErr gate: when to
  // shoot is learned from the dense per-shot hit/miss rewards, not pre-wired.
  buttons[0 * F + COL.bias] = -1.6; // jump starts rare
  buttons[1 * F + COL.bias] = s.fireBias; // base fire cadence
  buttons[2 * F + COL.bias] = -1.5; // dash starts rare
  buttons[3 * F + COL.bias] = -1.9; // boost starts rare
  return { mov, buttons };
}

// A never-trained brain record (for an offline client with no server reach, or
// a server row before its first duel).
export function seedRlBrain(difficulty: RlDifficulty): RlBrain {
  return {
    difficulty,
    gen: 0,
    duels: 0,
    botFrags: 0,
    humanFrags: 0,
    updatedAt: 0,
    weights: seedWeights(difficulty),
  };
}

// Fresh brain per tier, as a map — used by the client when the AI-brains API
// is unreachable, so "Duel the AI" still works fully offline.
export function seedRlBrains(): Record<RlDifficulty, RlBrain> {
  return {
    easy: seedRlBrain('easy'),
    medium: seedRlBrain('medium'),
    hard: seedRlBrain('hard'),
  };
}

// Pure input validation for a client-supplied gradient (server uses it before
// touching the stored brain; a forged/truncated array is rejected, never
// trusted by length).
export function saneGradient(v: unknown): v is { mov: number[]; buttons: number[] } {
  if (!v || typeof v !== 'object') return false;
  const g = v as { mov?: unknown; buttons?: unknown };
  if (!Array.isArray(g.mov) || g.mov.length !== RL_MOV_LEN) return false;
  if (!Array.isArray(g.buttons) || g.buttons.length !== RL_BUTTON_LEN) return false;
  for (let i = 0; i < RL_MOV_LEN; i++) {
    if (typeof g.mov[i] !== 'number' || !Number.isFinite(g.mov[i])) return false;
  }
  for (let i = 0; i < RL_BUTTON_LEN; i++) {
    if (typeof g.buttons[i] !== 'number' || !Number.isFinite(g.buttons[i])) return false;
  }
  return true;
}

export function rlGradL2(grad: number[]): number {
  let sum = 0;
  for (const g of grad) sum += g * g;
  return Math.sqrt(sum);
}

// REINFORCE episode gradient: for each logged decision, credit the discounted
// sum of later rewards within RL_CREDIT_HORIZON (centred on the episode-mean
// return as a baseline), then push the sampled inputs' log-probabilities up
// along that advantage. Movement axes get the Gaussian gradient
//   ∇ log N(a; μ, σ²) = (a − μ)/σ² · dμ/dw,  with μ = tanh(w·φ) so dμ/dw = (1−μ²)φ
// and each trigger button gets the Bernoulli gradient (y − p)φ, replaying the
// exact probabilities the agent acted with during the duel.
export function computeRlGradient(
  w: RlBrainWeights,
  traj: RlTrajectory,
  events: RlEvents,
): { movGrad: number[]; buttonsGrad: number[] } {
  const movGrad = new Array<number>(RL_MOV_LEN).fill(0);
  const buttonsGrad = new Array<number>(RL_BUTTON_LEN).fill(0);
  const n = traj.feats.length;
  if (n === 0 || events.length === 0) return { movGrad, buttonsGrad };
  // Discounted return per decision.
  const G = new Array<number>(n).fill(0);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const ti = traj.times[i];
    let g = 0;
    for (const e of events) {
      const dt = e.t - ti;
      if (dt <= 0 || dt > RL_CREDIT_HORIZON) continue;
      g += e.r * Math.pow(RL_GAMMA, dt);
    }
    G[i] = g;
    sum += g;
  }
  const baseline = sum / n;
  for (let i = 0; i < n; i++) {
    const adv = G[i] - baseline;
    if (adv === 0) continue;
    const feat = traj.feats[i];
    const out = rlOutputs(w, feat);
    // Continuous movement axes: ∇ log N(a; μ, σ²) = ((a−μ)/σ²) · dμ/dw with
    // μ = tanh(z), dμ/dz = 1 − μ². The aim axes explore with their own (tighter)
    // σ so the gradient credits an aligned shot to the aim that produced it.
    const AXES = [
      // [sampled action a, policy mean μ, weight-column offset, σ, grad scale]
      [traj.f[i], out.muF, 0, RL_MOVE_SIGMA, 1],
      [traj.s[i], out.muS, F, RL_MOVE_SIGMA, 1],
      [traj.aimX[i], out.muAimX, 2 * F, RL_AIM_SIGMA, RL_AIM_GRAD_SCALE],
      [traj.aimY[i], out.muAimY, 3 * F, RL_AIM_SIGMA, RL_AIM_GRAD_SCALE],
    ] as const;
    for (const [a, mu, offset, sigma, gscale] of AXES) {
      const deriv = ((a - mu) / (sigma * sigma)) * gscale;
      const dMu = 1 - mu * mu;
      for (let f = 0; f < F; f++) {
        movGrad[offset + f] += deriv * dMu * feat[f] * adv;
      }
    }
    // Trigger buttons: jump/fire/dash/boost — (y − p)φ, but ONLY on rows where
    // the button was actually usable (a press the physics/cooldown blocked was
    // not a choice the policy made, so it teaches nothing).
    const y = [traj.jump[i], traj.fire[i], traj.dash[i], traj.boost[i]];
    const p = [out.pJump, out.pFire, out.pDash, out.pBoost];
    const allow = [traj.allowJump[i], traj.allowFire[i], traj.allowDash[i], traj.allowBoost[i]];
    for (let b = 0; b < 4; b++) {
      if (allow[b] === 0) continue; // action masking
      const d = y[b] - p[b];
      if (d === 0) continue;
      for (let f = 0; f < F; f++) {
        buttonsGrad[b * F + f] += d * feat[f] * adv;
      }
    }
  }
  return { movGrad, buttonsGrad };
}

// Server-side apply step: fold a duel's (client-computed, already validated)
// raw gradient into the stored weights — w += lr · grad, clamped. Returns the
// updated weights. Never throws on bad input (callers validate first).
export function applyRlGradient(
  w: RlBrainWeights,
  movGrad: number[],
  buttonsGrad: number[],
  maxNorm = RL_GRAD_NORM_MAX,
): RlBrainWeights {
  let scale = 1;
  for (const g of [movGrad, buttonsGrad]) {
    const n = rlGradL2(g);
    if (n > maxNorm) scale = Math.min(scale, maxNorm / n);
  }
  const mov = w.mov.slice();
  const buttons = w.buttons.slice();
  for (let i = 0; i < RL_MOV_LEN; i++) mov[i] = clampWeight(mov[i] + RL_LEARNING_RATE * movGrad[i] * scale);
  for (let i = 0; i < RL_BUTTON_LEN; i++) buttons[i] = clampWeight(buttons[i] + RL_LEARNING_RATE * buttonsGrad[i] * scale);
  return { mov, buttons };
}

// Plausibility clamps for a client-reported duel outcome (server-side), so a
// forged report can't move a brain with a "10000-frag duel" that never happened.
export function clampRlOutcome(v: unknown): {
  difficulty: RlDifficulty | null;
  movGrad: number[];
  buttonsGrad: number[];
  decided: number;
  fired: number;
  botFrags: number;
  botDeaths: number;
  humanFrags: number;
  durationSec: number;
} {
  const out = {
    difficulty: null as RlDifficulty | null,
    movGrad: [] as number[],
    buttonsGrad: [] as number[],
    decided: 0,
    fired: 0,
    botFrags: 0,
    botDeaths: 0,
    humanFrags: 0,
    durationSec: 0,
  };
  if (!v || typeof v !== 'object') return out;
  const b = v as Record<string, unknown>;
  if (typeof b.difficulty === 'string' && (RL_DIFFICULTIES as readonly string[]).includes(b.difficulty)) {
    out.difficulty = b.difficulty as RlDifficulty;
  }
  const gradOk =
    b.movGrad != null || b.buttonsGrad != null
      ? saneGradient({ mov: b.movGrad, buttons: b.buttonsGrad })
      : false;
  if (gradOk) {
    out.movGrad = b.movGrad as number[];
    out.buttonsGrad = b.buttonsGrad as number[];
  }
  const n = (x: unknown, cap: number): number =>
    typeof x === 'number' && Number.isFinite(x) ? Math.max(0, Math.min(cap, Math.floor(x))) : 0;
  out.decided = n(b.decided, 50_000);
  out.fired = n(b.fired, 20_000);
  out.botFrags = n(b.botFrags, 300);
  out.botDeaths = n(b.botDeaths, 500);
  out.humanFrags = n(b.humanFrags, 300);
  out.durationSec =
    typeof b.durationSec === 'number' && Number.isFinite(b.durationSec)
      ? Math.max(0, Math.min(3600, b.durationSec))
      : 0;
  return out;
}
