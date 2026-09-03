// Self-contained sweep: reimplements the policy math with sweepable
// RL_AIM_SIGMA / RL_AIM_GRAD_SCALE / RL_LEARNING_RATE to find a configuration
// where a seed that starts aiming off-target LEARNS to center (and keeps
// firing) instead of diverging to saturation.
const F = 13;
const MOVE_SIG = 0.85;
const AIM_SPAN = 2.5, AIM_SPAN_V = 1.5;
const MISS_PEN = 0.08, MISS_REF = 0.5;
const DECIDE = 0.35, GAMMA = 0.8, HORIZON = 12;
const TGT_LAT = 0.45, TGT_V = 0.55, RAIL_CD = 1.2;
const SIG = (z: number) => (z >= 0 ? 1 / (1 + Math.exp(-z)) : (() => { const e = Math.exp(z); return e / (1 + e); })());

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gauss(r: () => number) {
  const u1 = Math.max(r(), 1e-9);
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * r());
}
function hashSeed(s: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
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
  let zf = 0, zs = 0, zaX = 0, zaY = 0;
  for (let f = 0; f < F; f++) { zf += w.mov[f] * feat[f]; zs += w.mov[F + f] * feat[f]; zaX += w.mov[2 * F + f] * feat[f]; zaY += w.mov[3 * F + f] * feat[f]; }
  let pJ = 0, pF = 0, pD = 0, pB = 0;
  for (let f = 0; f < F; f++) { const x = feat[f]; pJ += w.buttons[f] * x; pF += w.buttons[F + f] * x; pD += w.buttons[2 * F + f] * x; pB += w.buttons[3 * F + f] * x; }
  return { muF: Math.tanh(zf), muS: Math.tanh(zs), muX: Math.tanh(zaX), muY: Math.tanh(zaY), pJ: SIG(pJ), pF: SIG(pF), pD: SIG(pD), pB: SIG(pB) };
}
function decide(w: { mov: number[]; buttons: number[] }, feat: number[], r: () => number, aimSig: number) {
  const o = outputs(w, feat);
  const clip = (v: number) => Math.max(-1, Math.min(1, v));
  return { ...o, f: clip(o.muF + gauss(r) * MOVE_SIG), s: clip(o.muS + gauss(r) * MOVE_SIG), x: clip(o.muX + gauss(r) * aimSig), y: clip(o.muY + gauss(r) * aimSig) };
}
function grad(w: { mov: number[]; buttons: number[] }, rows: { f: number[]; s: number[]; x: number[]; y: number[]; fire: number[]; allow: number[]; feat: number[][]; t: number[] }, ev: { t: number; r: number }[], aimSig: number, gscale: number) {
  const mg = new Array<number>(4 * F).fill(0), bg = new Array<number>(4 * F).fill(0);
  const n = rows.feat.length;
  const G = new Array<number>(n).fill(0);
  let sum = 0;
  for (let i = 0; i < n; i++) { let g = 0; for (const e of ev) { const dt = e.t - rows.t[i]; if (dt <= 0 || dt > HORIZON) continue; g += e.r * Math.pow(GAMMA, dt); } G[i] = g; sum += g; }
  const bl = sum / n;
  for (let i = 0; i < n; i++) {
    const adv = G[i] - bl;
    if (adv === 0) continue;
    const o = outputs(w, rows.feat[i]);
    const ax = [ [rows.f[i], o.muF, 0, MOVE_SIG, 1], [rows.s[i], o.muS, F, MOVE_SIG, 1], [rows.x[i], o.muX, 2 * F, aimSig, gscale], [rows.y[i], o.muY, 3 * F, aimSig, gscale] ] as const;
    for (const [a, mu, off, sg, gs] of ax) { const deriv = ((a - mu) / (sg * sg)) * gs; const dMu = 1 - mu * mu; for (let f = 0; f < F; f++) mg[off + f] += deriv * dMu * rows.feat[i][f] * adv; }
    const yv = [rows.fire[i], 0, 0, 0];
    const pv = [o.pF, o.pJ, o.pD, o.pB];
    const av = [rows.allow[i], 1, 1, 1];
    for (let b = 0; b < 4; b++) { if (av[b] === 0) continue; const d = yv[b] - pv[b]; if (d === 0) continue; for (let f = 0; f < F; f++) bg[b * F + f] += d * rows.feat[i][f] * adv; }
  }
  return { mg, bg };
}
function apply(w: { mov: number[]; buttons: number[] }, mg: number[], bg: number[], lr: number) {
  const mov = w.mov.slice(), buttons = w.buttons.slice();
  for (let i = 0; i < 4 * F; i++) { mov[i] = Math.max(-20, Math.min(20, mov[i] + lr * mg[i])); buttons[i] = Math.max(-20, Math.min(20, buttons[i] + lr * bg[i])); }
  return { mov, buttons };
}
function duel(w: { mov: number[]; buttons: number[] }, r: () => number, aimSig: number) {
  const base = [0.48, 1, 0, 0, 1, 0.05, 0.2, 0, 0, 0, 0, 0, 1];
  const rows = { f: [] as number[], s: [] as number[], x: [] as number[], y: [] as number[], fire: [] as number[], allow: [] as number[], feat: [] as number[][], t: [] as number[] };
  const ev: { t: number; r: number }[] = [];
  let fireCd = 0, ep = 0, o = outputs(w, base);
  while (ep < 45) {
    const aimErr = Math.min(1, Math.abs(o.muX * AIM_SPAN) / 12);
    const feat = base.slice(); feat[7] = aimErr;
    const d = decide(w, feat, r, aimSig);
    const allow = fireCd <= 0 ? 1 : 0;
    const fire = d.pF > 0 && r() < d.pF && allow === 1 ? 1 : 0; // use sampled later
    // resample cleanly: decide() already gave bernoulli via p; do it here:
    const fired = allow === 1 && r() < d.pF ? 1 : 0;
    if (fired) fireCd = RAIL_CD; else fireCd = Math.max(0, fireCd - DECIDE);
    if (fired) {
      const lat = d.x * AIM_SPAN, vert = d.y * AIM_SPAN_V;
      if (Math.abs(lat) <= TGT_LAT && Math.abs(vert) <= TGT_V) ev.push({ t: ep, r: 1 });
      else { const missM = Math.hypot(Math.max(0, Math.abs(lat) - TGT_LAT), Math.max(0, Math.abs(vert) - TGT_V)); ev.push({ t: ep, r: -MISS_PEN * Math.min(4, missM / MISS_REF) }); }
    }
    rows.f.push(d.f); rows.s.push(d.s); rows.x.push(d.x); rows.y.push(d.y);
    rows.fire.push(fired); rows.allow.push(allow); rows.feat.push(feat); rows.t.push(ep);
    o = outputs(w, feat);
    ep += DECIDE;
  }
  return { rows, ev };
}
function run(cfg: { aimSig: number; gscale: number; lr: number }) {
  let w = seedWeights();
  let hit = 0, shots = 0, lastHits = 0, lastShots = 0;
  for (let n = 0; n < 300; n++) {
    const r = mulberry32(0xbeef + n * 7);
    const { rows, ev } = duel(w, r, cfg.aimSig);
    for (const e of ev) { shots++; if (e.r === 1) hit++; }
    if (n >= 250) { for (const e of ev) { lastShots++; if (e.r === 1) lastHits++; } }
    const { mg, bg } = grad(w, rows, ev, cfg.aimSig, cfg.gscale);
    w = apply(w, mg, bg, cfg.lr);
  }
  const ax = w.mov[2 * F + 12], ay = w.mov[3 * F + 12];
  const pF = SIG(w.buttons[F + 12]);
  console.log(`aimSig=${cfg.aimSig} gscale=${cfg.gscale} lr=${cfg.lr}  → aimXw=${ax.toFixed(2)} aimYw=${ay.toFixed(2)} pF=${pF.toFixed(2)} hits/shots all=${hit}/${shots} last50=${lastHits}/${lastShots}`);
}
run({ aimSig: 0.35, gscale: 0.235, lr: 0.05 });
run({ aimSig: 0.5, gscale: 0.235, lr: 0.05 });
run({ aimSig: 0.5, gscale: 0.3, lr: 0.02 });
run({ aimSig: 0.6, gscale: 0.4, lr: 0.01 });
run({ aimSig: 0.5, gscale: 0.5, lr: 0.008 });
