import {
  seedRlBrain, rlDecide, computeRlGradient, applyRlGradient,
  AIM_SPAN, AIM_SPAN_V, RL_MISS_PENALTY, RL_MISS_DIST_REF,
  RL_DECIDE_INTERVAL, RL_FEATURE_COUNT, RL_BUTTON_LEN, type RlBrain,
} from './src/game/rl-brain';

const TGT_LAT_HALF = 0.45;
const TGT_V_HALF = 0.55;
const RAIL_CD = 1.2;
const F = RL_FEATURE_COUNT;

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function muAt(w: { mov: number[] }, col: number): number {
  return Math.tanh(w.mov[col + 12]); // bias column
}

function duel(brain: RlBrain, rand: () => number) {
  const featsBase = [0.48, 1, 0, 0, 1, 0.05, 0.2, 0, 0, 0, 0, 0, 1];
  const traj = {
    feats: [] as number[][], f: [] as number[], s: [] as number[],
    aimX: [] as number[], aimY: [] as number[], jump: [] as number[],
    fire: [] as number[], dash: [] as number[], boost: [] as number[],
    allowJump: [] as number[], allowFire: [] as number[],
    allowDash: [] as number[], allowBoost: [] as number[], times: [] as number[],
  };
  const events: { t: number; r: number }[] = [];
  let fireCd = 0;
  let ep = 0;
  const EPISODE = 45;
  while (ep < EPISODE) {
    // The bot's facing trails its aim point: aimErr ≈ lateral aim offset angle.
    const muX = muAt(brain.weights, 2 * F);
    const aimErr = Math.min(1, Math.abs(muX * AIM_SPAN) / 12);
    const feats = featsBase.slice();
    feats[7] = aimErr;
    const d = rlDecide(brain.weights, feats, rand);
    const allowFire = fireCd <= 0 ? 1 : 0;
    const fire = d.fire && allowFire === 1 ? 1 : 0;
    if (fire) fireCd = RAIL_CD;
    else fireCd = Math.max(0, fireCd - RL_DECIDE_INTERVAL);
    if (fire) {
      const lat = d.aimX * AIM_SPAN;
      const vert = d.aimY * AIM_SPAN_V;
      if (Math.abs(lat) <= TGT_LAT_HALF && Math.abs(vert) <= TGT_V_HALF) {
        events.push({ t: ep, r: 1 });
      } else {
        const missM = Math.hypot(
          Math.max(0, Math.abs(lat) - TGT_LAT_HALF),
          Math.max(0, Math.abs(vert) - TGT_V_HALF),
        );
        events.push({ t: ep, r: -RL_MISS_PENALTY * Math.min(4, missM / RL_MISS_DIST_REF) });
      }
    }
    traj.feats.push(feats); traj.f.push(d.f); traj.s.push(d.s);
    traj.aimX.push(d.aimX); traj.aimY.push(d.aimY);
    traj.jump.push(d.jump ? 1 : 0); traj.fire.push(fire);
    traj.dash.push(d.dash ? 1 : 0); traj.boost.push(d.boost ? 1 : 0);
    traj.allowJump.push(1); traj.allowFire.push(allowFire);
    traj.allowDash.push(1); traj.allowBoost.push(1);
    traj.times.push(ep);
    ep += RL_DECIDE_INTERVAL;
  }
  return { traj, events };
}

let brain = seedRlBrain('hard');
console.log('start aimX bias =', brain.weights.mov[2 * F + 12].toFixed(2), ' aimY bias =', brain.weights.mov[3 * F + 12].toFixed(2));

let totalShots = 0, totalHits = 0;
let winShots = 0, winHits = 0;
for (let duelN = 0; duelN < 400; duelN++) {
  const rand = mulberry32(0xabc123 + duelN * 7);
  const { traj, events } = duel(brain, rand);
  const nShots = events.length;
  const nHits = events.filter((e) => e.r === 1).length;
  totalShots += nShots; totalHits += nHits;
  if (duelN >= 350) { winShots += nShots; winHits += nHits; }
  const g = computeRlGradient(brain.weights, traj, events);
  brain.weights = applyRlGradient(brain.weights, g.movGrad, g.buttonsGrad);
}

const pFireNow = 1 / (1 + Math.exp(-brain.weights.buttons[F + 12]));
console.log('end   aimX bias =', brain.weights.mov[2 * F + 12].toFixed(3), ' aimY bias =', brain.weights.mov[3 * F + 12].toFixed(3));
console.log(`fire pFire@bias = ${pFireNow.toFixed(3)}  shots/hits 0-400: ${totalHits}/${totalShots}  last50: ${winHits}/${winShots}`);
