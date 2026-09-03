// Diagnose the ~0.3 plateau: does the aim keep drifting toward 0 over more
// duels, or is the pull genuinely vanishing? Also test stronger aim LR / miss
// penalty / narrower sigma.
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
function decide(w: { mov: number[]; buttons: number[] }, feat: number[], r: () => number, aimSig: number) {
  const o = outputs(w, feat);
  const clip = (v: number) => Math.max(-1, Math.min(1, v));
  return { ...o, f: clip(o.muF + gauss(r) * MOVE_SIG), s: clip(o.muS + gauss(r) * MOVE_SIG), x: clip(o.muX + gauss(r) * aimSig), y: clip(o.muY + gauss(r) * aimSig) };
}
function gradPerShot(w: { mov: number[]; buttons: number[] }, rows: { f: number[]; s: number[]; x: number[]; y: number[]; jump: number[]; fire: number[]; dash: number[]; boost: number[]; allowFire: number[]; feat: number[][]; t: number[] }, ev: { t: number; r: number }[], aimSig: number, gscale: number, penScale: number) {
  const mg = new Array<number>(4 * F).fill(0), bg = new Array<number>(4 * F).fill(0);
  const n = rows.feat.length;
  const shotRewards: number[] = [];
  for (let i = 0; i < n; i++) if (rows.fire[i] === 1) {
    const evIdx = ev.findIndex((e) => Math.abs(e.t - rows.t[i]) < 1e-6);
    shotRewards.push(evIdx >= 0 ? ev[evIdx].r : 0);
  }
  const meanR = shotRewards.length ? shotRewards.reduce((a, b) => a + b, 0) / shotRewards.length : 0;
  let si = 0;
  for (let i = 0; i < n; i++) {
    if (rows.fire[i] !== 1) continue;
    const o = outputs(w, rows.feat[i]);
    const r = shotRewards[si++] * penScale;
    const advF = r - meanR;
    if (advF !== 0 && rows.allowFire[i] === 1) {
      const d = 1 - o.pF;
      for (let f = 0; f < F; f++) bg[F + f] += d * rows.feat[i][f] * advF;
    }
    if (r === 0) continue;
    for (const [a, mu, off, sg, gs] of [[rows.x[i], o.muX, 2 * F, aimSig, gscale], [rows.y[i], o.muY, 3 * F, aimSig, gscale]] as const) {
      const deriv = ((a - mu) / (sg * sg)) * gs; const dMu = 1 - mu * mu;
      for (let f = 0; f < F; f++) mg[off + f] += deriv * dMu * rows.feat[i][f] * r;
    }
  }
  return { mg, bg };
}
function apply(w: { mov: number[]; buttons: number[] }, mg: number[], bg: number[], aimLr: number, lr: number) {
  const mov = w.mov.slice(), buttons = w.buttons.slice();
  for (let i = 0; i < 4 * F; i++) {
    const l = i >= 2 * F ? aimLr : lr;
    mov[i] = Math.max(-20, Math.min(20, mov[i] + l * mg[i]));
  }
  for (let i = 0; i < 4 * F; i++) buttons[i] = Math.max(-20, Math.min(20, buttons[i] + lr * bg[i]));
  return { mov, buttons };
}
function duel(w: { mov: number[]; buttons: number[] }, r: () => number, aimSig: number) {
  const base = [0.48, 1, 0, 0, 1, 0.05, 0.2, 0, 0, 0, 0, 0, 1];
  const rows = { f: [] as number[], s: [] as number[], x: [] as number[], y: [] as number[], jump: [] as number[], fire: [] as number[], dash: [] as number[], boost: [] as number[], allowFire: [] as number[], feat: [] as number[][], t: [] as number[] };
  const ev: { t: number; r: number }[] = [];
  let fireCd = 0, ep = 0;
  let o = outputs(w, base);
  while (ep < 45) {
    const aimErr = Math.min(1, Math.abs(o.muX * AIM_SPAN) / 12);
    const feat = base.slice(); feat[7] = aimErr;
    const d = decide(w, feat, r, aimSig);
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
  return { rows, ev };
}
function run(cfg: { aimSig: number; gscale: number; lr: number; aimLr: number; pen: number }) {
  let w = seedWeights();
  console.log(`\ncfg aimSig=${cfg.aimSig} gscale=${cfg.gscale} aimLr=${cfg.aimLr} pen=${cfg.pen}`);
  let cumH = 0, cumS = 0;
  let probe = [1, 20, 60, 120, 200, 300, 500, 800];
  for (let n = 0; n < 800; n++) {
    const r = mulberry32(0xbeef + n * 7);
    const { rows, ev } = duel(w, r, cfg.aimSig);
    const { mg, bg } = gradPerShot(w, rows, ev, cfg.aimSig, cfg.gscale, cfg.pen);
    w = apply(w, mg, bg, cfg.aimLr, cfg.lr);
    cumH += ev.filter((e) => e.r === 1).length; cumS += ev.length;
    if (probe.includes(n + 1)) console.log(`  duel ${String(n + 1).padStart(3)}: aimXb=${w.mov[2*F+12].toFixed(3)} aimYb=${w.mov[3*F+12].toFixed(3)} cum=${cumH}/${cumS} (${(100*cumH/cumS).toFixed(0)}%)`);
  }
}
run({ aimSig: 0.3, gscale: 0.2, lr: 0.05, aimLr: 0.05, pen: 1 });
run({ aimSig: 0.3, gscale: 0.2, lr: 0.05, aimLr: 0.15, pen: 1 });
run({ aimSig: 0.3, gscale: 0.3, lr: 0.05, aimLr: 0.3, pen: 1 });
run({ aimSig: 0.3, gscale: 0.2, lr: 0.05, aimLr: 0.1, pen: 3 });
run({ aimSig: 0.25, gscale: 0.25, lr: 0.05, aimLr: 0.1, pen: 2 });
