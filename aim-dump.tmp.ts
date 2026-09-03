// Dump per-shot contributions to the aimX-bias pull at a frozen off-center mean,
// to expose why the net pull is positive (away from the target) in the duel
// loop while the analytic E[(a−μ)r/σ²] probe said negative.
const F = 13;
const AIM_SPAN = 2.5, AIM_SPAN_V = 1.5;
const TGT_LAT = 0.45, TGT_V = 0.55;
function mulberry32(seed: number) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function gauss(r: () => number) { const u1 = Math.max(r(), 1e-9); return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * r()); }
const SIG_X = 0.3;
const MU = 0.31; // tanh(0.324)
const SIG_Y = 0.3;
const MU_Y = -0.235;
const r = mulberry32(7);
let sumScore = 0, n = 0;
for (let i = 0; i < 30000; i++) {
  // Emulate fired-row sampling as in the duel loop: aimX & aimY sampled from
  // their own Gaussian means each decision; but is there ANY coupling?
  const a = Math.max(-1, Math.min(1, MU + gauss(r) * SIG_X));
  const y = Math.max(-1, Math.min(1, MU_Y + gauss(r) * SIG_Y));
  const lat = a * AIM_SPAN, vert = y * AIM_SPAN_V;
  let rew: number;
  if (Math.abs(lat) <= TGT_LAT && Math.abs(vert) <= TGT_V) rew = 1;
  else { const missM = Math.hypot(Math.max(0, Math.abs(lat) - TGT_LAT), Math.max(0, Math.abs(vert) - TGT_V)); rew = -0.08 * Math.min(4, missM / 0.5); }
  const m = Math.tanh(MU);
  const contrib = ((a - m) / (SIG_X * SIG_X)) * (1 - m * m) * rew;
  sumScore += contrib; n++;
  if (i < 12) console.log(`a=${a.toFixed(2)} lat=${lat.toFixed(2)} vert=${vert.toFixed(2)} rew=${rew.toFixed(3)} contrib=${contrib.toFixed(3)}`);
}
console.log('mean contrib (aimX bias, includes 1/σ²):', (sumScore / n).toFixed(4), ' over', n);
