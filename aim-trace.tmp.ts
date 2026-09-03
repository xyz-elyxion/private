// Trace the per-duel aimX-bias gradient to see which rows push which way.
const F = 13;
const MOVE_SIG = 0.85;
const AIM_SPAN = 2.5, AIM_SPAN_V = 1.5;
const MISS_PEN = 0.08, MISS_REF = 0.5;
const DECIDE = 0.35, GAMMA = 0.8, HORIZON = 12;
const TGT_LAT = 0.45, TGT_V = 0.55, RAIL_CD = 1.2;
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
  let zaX = 0;
  for (let f = 0; f < F; f++) zaX += w.mov[2 * F + f] * feat[f];
  return { muX: Math.tanh(zaX) };
}
function duel(w: { mov: number[]; buttons: number[] }, r: () => number, aimSig: number, muXTarget: number) {
  const base = [0.48, 1, 0, 0, 1, 0.05, 0.2, 0, 0, 0, 0, 0, 1];
  const ev: { t: number; r: number }[] = [];
  let ep = 0, fireCd = 0;
  while (ep < 45) {
    const feat = base.slice(); feat[7] = Math.min(1, Math.abs(muXTarget * AIM_SPAN) / 12);
    // sample aimX around the TARGET mean (ignore policy mean) so we can see the
    // pure reward-shape pull on the gradient replay
    const a = Math.max(-1, Math.min(1, muXTarget + gauss(r) * aimSig));
    const allow = fireCd <= 0 ? 1 : 0;
    const fired = allow === 1 && r() < 0.23 ? 1 : 0;
    if (fired) fireCd = RAIL_CD; else fireCd = Math.max(0, fireCd - DECIDE);
    if (fired) {
      const lat = a * AIM_SPAN;
      if (Math.abs(lat) <= TGT_LAT) ev.push({ t: ep, r: 1 });
      else { const missM = Math.max(0, Math.abs(lat) - TGT_LAT); ev.push({ t: ep, r: -MISS_PEN * Math.min(4, missM / MISS_REF) }); }
    }
    ep += DECIDE;
  }
  // Now replay: compute the gradient the real code would apply if its mean were
  // muXTarget, using this duel's rewards, and see the sign on the aimX bias row.
  // We reuse the rows implicitly: for the bias feature (φ=1), each fired row's
  // contribution to d(aimX bias) is ∝ (a−μ)/σ²·(1−μ²)·(G−bl).
  const n = Math.floor(45 / DECIDE);
  const times = Array.from({ length: n }, (_, i) => i * DECIDE);
  const G = times.map((ti) => { let g = 0; for (const e of ev) { const dt = e.t - ti; if (dt <= 0 || dt > HORIZON) continue; g += e.r * Math.pow(GAMMA, dt); } return g; });
  return { ev, G };
}
for (const muTarget of [0.45, 0.3, 0.15]) {
  const r = mulberry32(42);
  const { ev, G } = duel(seedWeights(), r, 0.5, muTarget);
  const mu = Math.tanh(muTarget);
  const dMu = 1 - mu * mu;
  const contribs: number[] = [];
  const n = G.length;
  for (let i = 0; i < n; i++) {
    if (G[i] === 0) continue;
    // replay the sampled action for this row: we can't recover it after the
    // fact, so approximate the expected pull instead — recompute per fired row.
  }
  console.log(`muTarget=${muTarget}: shots=${ev.length} hits=${ev.filter(e=>e.r===1).length} meanG(active)=${(G.filter(g=>g!==0).reduce((a,b)=>a+b,0)/Math.max(1,G.filter(g=>g!==0).length)).toFixed(4)}`);
  // Expected pull on aimX bias for a Gaussian with the observed reward fn:
  // E[(a−μ)/σ²·(1−μ²)·adv] approximated by sampling:
  const rr = mulberry32(7);
  let sum = 0, cnt = 0;
  for (let s = 0; s < 200000; s++) {
    const a = Math.max(-1, Math.min(1, mu + gauss(rr) * 0.5));
    let rew = 0;
    const lat = a * AIM_SPAN;
    if (Math.abs(lat) <= TGT_LAT) rew = 1;
    else { const missM = Math.max(0, Math.abs(lat) - TGT_LAT); rew = -MISS_PEN * Math.min(4, missM / MISS_REF); }
    sum += (a - mu) * rew; cnt++;
  }
  console.log(`  E[(a−μ)·R(a)] ≈ ${(sum / cnt).toFixed(5)}  (negative ⇒ mean pulled toward target)`);
}
