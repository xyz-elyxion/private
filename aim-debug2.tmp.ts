// Instrument the failing sweep8 config (separable, pen=0.5, aimSig=0.3,
// gscale=0.25, lr=0.05) to find where divergence enters after duel 1.
const F = 13;
const MOVE_SIG = 0.85, AIM_SPAN = 2.5, AIM_SPAN_V = 1.5;
const DECIDE = 0.35, RAIL_CD = 1.2;
const REF = 0.5;
const SIG = (z: number) => (z >= 0 ? 1 / (1 + Math.exp(-z)) : (() => { const e = Math.exp(z); return e / (1 + e); })());
function mulberry32(seed: number) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function gauss(r: () => number) { const u1 = Math.max(r(), 1e-9); return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * r()); }
function hashSeed(s: string) { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h >>> 0; }
function seedWeights() {
  const rng = mulberry32(hashSeed('elyxion-rl-v3:hard'));
  const s = { fireBias: -1.2, chase: 0.75, noise: 0.06, aimOffset: 0.45 };
  const noise = () => gauss(rng) * s.noise;
  const mov: number[] = [], buttons: number[] = [];
  for (let i = 0; i < 4 * F; i++) mov.push(noise());
  mov[1] = s.chase; mov[F + 2] = s.chase * 0.6;
  mov[2 * F + 12] = s.aimOffset; mov[3 * F + 12] = -0.25;
  for (let i = 0; i < 4 * F; i++) buttons.push(noise());
  buttons[12] = -1.6; buttons[F + 12] = s.fireBias; buttons[2 * F + 12] = -1.5; buttons[3 * F + 12] = -1.9;
  return { mov, buttons };
}
function outputs(w: { mov: number[]; buttons: number[] }, feat: number[]) {
  let zaX = 0, zaY = 0;
  for (let f = 0; f < F; f++) { zaX += w.mov[2 * F + f] * feat[f]; zaY += w.mov[3 * F + f] * feat[f]; }
  return { muX: Math.tanh(zaX), muY: Math.tanh(zaY) };
}
function rewardOf(lat: number, vert: number) {
  if (Math.abs(lat) <= 0.45 && Math.abs(vert) <= 0.55) return 1;
  const h = Math.min(1, Math.pow(Math.max(0, Math.abs(lat) - 0.45) / REF, 2));
  const v = Math.min(1, Math.pow(Math.max(0, Math.abs(vert) - 0.55) / REF, 2));
  return -(h + v);
}
// One duel; returns per-shot (a, muX_at_row, r) triples for the aimX axis
function duelShots(w: { mov: number[]; buttons: number[] }, r: () => number, aimSig: number) {
  const base = [0.48, 1, 0, 0, 1, 0.05, 0.2, 0, 0, 0, 0, 0, 1];
  let fireCd = 0, ep = 0;
  let o = outputs(w, base);
  const shots: { a: number; mu: number; rew: number }[] = [];
  while (ep < 45) {
    const feat = base.slice();
    const gx = gauss(r), gy = gauss(r), gf = gauss(r), gs2 = gauss(r);
    const a = Math.max(-1, Math.min(1, o.muX + gx * aimSig));
    const y = Math.max(-1, Math.min(1, o.muY + gy * aimSig));
    const pF = 0.23; // fixed for this debug
    const allow = fireCd <= 0 ? 1 : 0;
    const fired = allow === 1 && r() < pF ? 1 : 0;
    if (fired) fireCd = RAIL_CD; else fireCd = Math.max(0, fireCd - DECIDE);
    if (fired) shots.push({ a, mu: o.muX, rew: rewardOf(a * AIM_SPAN, y * AIM_SPAN_V) });
    o = outputs(w, feat);
    ep += DECIDE;
  }
  return shots;
}
let w = seedWeights();
for (let duelN = 0; duelN < 15; duelN++) {
  const rr = mulberry32(0xbeef + duelN * 7);
  const shots = duelShots(w, rr, 0.3);
  let pull = 0;
  for (const s of shots) {
    const deriv = ((s.a - s.mu) / 0.09) * 0.25;
    const dMu = 1 - s.mu * s.mu;
    pull += deriv * dMu * s.rew;
  }
  const hits = shots.filter((s) => s.rew === 1).length;
  // The applied bias-column update = lr * pull (feat[12]=1)
  const biasBefore = w.mov[2 * F + 12];
  w.mov[2 * F + 12] = Math.max(-20, Math.min(20, w.mov[2 * F + 12] + 0.05 * pull));
  console.log(`duel ${duelN}: shots=${shots.length} hits=${hits} pull(aimXb)=${pull.toFixed(2)} aimXb ${biasBefore.toFixed(3)}→${w.mov[2*F+12].toFixed(3)} muX=${Math.tanh(w.mov[2*F+12]).toFixed(3)}`);
}
