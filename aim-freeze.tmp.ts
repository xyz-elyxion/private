// Freeze the exact cfg1 trajectory at duel 20 (aimXb≈0.31) and measure the
// per-duel summed gradient the sim would apply — does it actually point to 0?
const F = 13;
const MOVE_SIG = 0.85, AIM_SPAN = 2.5, AIM_SPAN_V = 1.5;
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
  let zf = 0, zs = 0, zaX = 0, zaY = 0;
  for (let f = 0; f < F; f++) { zf += w.mov[f] * feat[f]; zs += w.mov[F + f] * feat[f]; zaX += w.mov[2 * F + f] * feat[f]; zaY += w.mov[3 * F + f] * feat[f]; }
  let pJ = 0, pF = 0, pD = 0, pB = 0;
  for (let f = 0; f < F; f++) { const x = feat[f]; pJ += w.buttons[f] * x; pF += w.buttons[F + f] * x; pD += w.buttons[2 * F + f] * x; pB += w.buttons[3 * F + f] * x; }
  return { muF: Math.tanh(zf), muS: Math.tanh(zs), muX: Math.tanh(zaX), muY: Math.tanh(zaY), pJ: SIG(pJ), pF: SIG(pF), pD: SIG(pD), pB: SIG(pB) };
}
function decide(w: { mov: number[]; buttons: number[] }, feat: number[], r: () => number) {
  const o = outputs(w, feat);
  const clip = (v: number) => Math.max(-1, Math.min(1, v));
  return { ...o, f: clip(o.muF + gauss(r) * MOVE_SIG), s: clip(o.muS + gauss(r) * MOVE_SIG), x: clip(o.muX + gauss(r) * 0.3), y: clip(o.muY + gauss(r) * 0.3) };
}
// replay one duel and accumulate ONLY the aimX-bias-column gradient component
function duelPull(w: { mov: number[]; buttons: number[] }, r: () => number) {
  const base = [0.48, 1, 0, 0, 1, 0.05, 0.2, 0, 0, 0, 0, 0, 1];
  let fireCd = 0, ep = 0;
  let o = outputs(w, base);
  const rows: { x: number[]; y: number[]; feat: number[][]; t: number[] } = { x: [], y: [], feat: [], t: [] };
  const ev: { t: number; r: number }[] = [];
  while (ep < 45) {
    const feat = base.slice();
    const d = decide(w, feat, r);
    const allow = fireCd <= 0 ? 1 : 0;
    const fired = allow === 1 && r() < d.pF ? 1 : 0;
    if (fired) fireCd = RAIL_CD; else fireCd = Math.max(0, fireCd - DECIDE);
    if (fired) {
      const lat = d.x * AIM_SPAN, vert = d.y * AIM_SPAN_V;
      if (Math.abs(lat) <= TGT_LAT && Math.abs(vert) <= TGT_V) ev.push({ t: ep, r: 1 });
      else { const missM = Math.hypot(Math.max(0, Math.abs(lat) - TGT_LAT), Math.max(0, Math.abs(vert) - TGT_V)); ev.push({ t: ep, r: -0.08 * Math.min(4, missM / 0.5) }); }
    }
    rows.x.push(d.x); rows.y.push(d.y); rows.feat.push(feat); rows.t.push(ep);
    o = outputs(w, feat);
    ep += DECIDE;
  }
  // accumulated aimX-bias gradient (col 2F+12) from per-shot rewards
  let pull = 0; let hits = 0;
  for (let i = 0; i < rows.x.length; i++) {
    const evIdx = ev.findIndex((e) => Math.abs(e.t - rows.t[i]) < 1e-6);
    if (evIdx < 0) continue;
    const rr = ev[evIdx].r;
    if (rr === 1) hits++;
    const oo = outputs(w, rows.feat[i]);
    const m = oo.muX;
    pull += ((rows.x[i] - m) / 0.09) * (1 - m * m) * rr;
  }
  return { pull, hits, shots: ev.length };
}
// reproduce cfg1 up to duel 20
let w = seedWeights();
for (let n = 0; n < 20; n++) {
  // actually apply cfg1 updates to get the same weights at duel 20
  const r = mulberry32(0xbeef + n * 7);
  const base = [0.48, 1, 0, 0, 1, 0.05, 0.2, 0, 0, 0, 0, 0, 1];
  const rows = { f: [] as number[], s: [] as number[], x: [] as number[], y: [] as number[], jump: [] as number[], fire: [] as number[], dash: [] as number[], boost: [] as number[], allowFire: [] as number[], feat: [] as number[][], t: [] as number[] };
  const ev: { t: number; r: number }[] = [];
  let fireCd = 0, ep = 0, o = outputs(w, base);
  while (ep < 45) {
    const feat = base.slice();
    const d = decide(w, feat, r);
    const allow = fireCd <= 0 ? 1 : 0;
    const fired = allow === 1 && r() < d.pF ? 1 : 0;
    if (fired) fireCd = RAIL_CD; else fireCd = Math.max(0, fireCd - DECIDE);
    if (fired) {
      const lat = d.x * AIM_SPAN, vert = d.y * AIM_SPAN_V;
      if (Math.abs(lat) <= TGT_LAT && Math.abs(vert) <= TGT_V) ev.push({ t: ep, r: 1 });
      else { const missM = Math.hypot(Math.max(0, Math.abs(lat) - TGT_LAT), Math.max(0, Math.abs(vert) - TGT_V)); ev.push({ t: ep, r: -0.08 * Math.min(4, missM / 0.5) }); }
    }
    rows.f.push(d.f); rows.s.push(d.s); rows.x.push(d.x); rows.y.push(d.y);
    rows.jump.push(d.pJ > 0 && r() < d.pJ ? 1 : 0); rows.fire.push(fired);
    rows.dash.push(r() < d.pD ? 1 : 0); rows.boost.push(r() < d.pB ? 1 : 0);
    rows.allowFire.push(allow); rows.feat.push(feat); rows.t.push(ep);
    o = outputs(w, feat);
    ep += DECIDE;
  }
  const shotRewards: number[] = [];
  for (let i = 0; i < rows.fire.length; i++) if (rows.fire[i] === 1) {
    const evIdx = ev.findIndex((e) => Math.abs(e.t - rows.t[i]) < 1e-6);
    shotRewards.push(evIdx >= 0 ? ev[evIdx].r : 0);
  }
  const meanR = shotRewards.length ? shotRewards.reduce((a, b) => a + b, 0) / shotRewards.length : 0;
  let si = 0;
  const mg = new Array<number>(4 * F).fill(0), bg = new Array<number>(4 * F).fill(0);
  for (let i = 0; i < rows.fire.length; i++) {
    if (rows.fire[i] !== 1) continue;
    const oo = outputs(w, rows.feat[i]);
    const rr = shotRewards[si++];
    const advF = rr - meanR;
    if (advF !== 0 && rows.allowFire[i] === 1) { const dd = 1 - oo.pF; for (let f = 0; f < F; f++) bg[F + f] += dd * rows.feat[i][f] * advF; }
    if (rr === 0) continue;
    for (const [a, mu, off, sg, gs] of [[rows.x[i], oo.muX, 2 * F, 0.3, 0.2], [rows.y[i], oo.muY, 3 * F, 0.3, 0.2]] as const) {
      const deriv = ((a - mu) / (sg * sg)) * gs; const dMu = 1 - mu * mu;
      for (let f = 0; f < F; f++) mg[off + f] += deriv * dMu * rows.feat[i][f] * rr;
    }
  }
  const mov = w.mov.slice();
  for (let i = 0; i < 4 * F; i++) mov[i] = Math.max(-20, Math.min(20, mov[i] + 0.05 * mg[i]));
  const buttons = w.buttons.slice();
  for (let i = 0; i < 4 * F; i++) buttons[i] = Math.max(-20, Math.min(20, buttons[i] + 0.05 * bg[i]));
  w = { mov, buttons };
}
console.log('weights at duel 20: aimXb =', w.mov[2 * F + 12].toFixed(3), ' aimYb =', w.mov[3 * F + 12].toFixed(3));
for (const seed of [1, 2, 3, 4, 5]) {
  const { pull, hits, shots } = duelPull(w, mulberry32(0xfeed + seed));
  console.log(`seed ${seed}: aimXb pull (pre-lr, pre-gscale×? raw incl 1/σ²) = ${pull.toFixed(3)}  hits=${hits}/${shots}`);
}
