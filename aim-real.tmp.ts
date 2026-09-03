// Instrument the REAL rl-brain module: per-duel aim bias trajectory + raw
// gradient magnitudes, to find where the divergence enters.
import {
  seedRlBrain, rlDecide, computeRlGradient, applyRlGradient, rlGradL2,
  AIM_SPAN, AIM_SPAN_V, RL_MISS_PENALTY, RL_MISS_DIST_REF,
  RL_DECIDE_INTERVAL, RL_FEATURE_COUNT,
} from './src/game/rl-brain';
const F = RL_FEATURE_COUNT;
const TGT_LAT = 0.45, TGT_V = 0.55, RAIL_CD = 1.2;
function mulberry32(seed: number) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const brain = seedRlBrain('hard');
console.log('seed aimX bias', brain.weights.mov[2*F+12].toFixed(3), 'aimY bias', brain.weights.mov[3*F+12].toFixed(3));
for (let duelN = 0; duelN < 12; duelN++) {
  const rand = mulberry32(0xabc + duelN * 7);
  const base = [0.48, 1, 0, 0, 1, 0.05, 0.2, 0, 0, 0, 0, 0, 1];
  const traj = { feats: [] as number[][], f: [] as number[], s: [] as number[], aimX: [] as number[], aimY: [] as number[], jump: [] as number[], fire: [] as number[], dash: [] as number[], boost: [] as number[], allowJump: [] as number[], allowFire: [] as number[], allowDash: [] as number[], allowBoost: [] as number[], times: [] as number[] };
  const events: { t: number; r: number }[] = [];
  let fireCd = 0, ep = 0, hits = 0, shots = 0;
  while (ep < 45) {
    const feat = base.slice();
    const d = rlDecide(brain.weights, feat, rand);
    const allow = fireCd <= 0 ? 1 : 0;
    const fired = allow === 1 && d.fire ? 1 : 0;
    if (fired) fireCd = RAIL_CD; else fireCd = Math.max(0, fireCd - RL_DECIDE_INTERVAL);
    if (fired) {
      shots++;
      const lat = d.aimX * AIM_SPAN, vert = d.aimY * AIM_SPAN_V;
      if (Math.abs(lat) <= TGT_LAT && Math.abs(vert) <= TGT_V) { events.push({ t: ep, r: 1 }); hits++; }
      else { const missM = Math.hypot(Math.max(0, Math.abs(lat) - TGT_LAT), Math.max(0, Math.abs(vert) - TGT_V)); events.push({ t: ep, r: -RL_MISS_PENALTY * Math.min(4, missM / RL_MISS_DIST_REF) }); }
    }
    traj.feats.push(feat); traj.f.push(d.f); traj.s.push(d.s);
    traj.aimX.push(d.aimX); traj.aimY.push(d.aimY);
    traj.jump.push(d.jump ? 1 : 0); traj.fire.push(fired);
    traj.dash.push(d.dash ? 1 : 0); traj.boost.push(d.boost ? 1 : 0);
    traj.allowJump.push(1); traj.allowFire.push(allow); traj.allowDash.push(1); traj.allowBoost.push(1);
    traj.times.push(ep);
    ep += RL_DECIDE_INTERVAL;
  }
  const g = computeRlGradient(brain.weights, traj, events);
  const before = { ax: brain.weights.mov[2*F+12], ay: brain.weights.mov[3*F+12] };
  brain.weights = applyRlGradient(brain.weights, g.movGrad, g.buttonsGrad);
  const mag = rlGradL2(g.movGrad);
  console.log(`duel ${duelN}: shots=${shots} hits=${hits} | aimX bias ${before.ax.toFixed(3)}→${brain.weights.mov[2*F+12].toFixed(3)} (Δ${(brain.weights.mov[2*F+12]-before.ax).toFixed(3)}) aimY ${before.ay.toFixed(3)}→${brain.weights.mov[3*F+12].toFixed(3)} | |movGrad|=${mag.toFixed(1)} fireW=${brain.weights.buttons[F+12].toFixed(3)}`);
}
