// At a FROZEN aim mean, compute the expected per-shot pull on the aimX bias
// weight: E[(a−μ)·(1−μ²)·r]. If strongly negative at μ≈0.35, training should
// keep pulling to 0 — meaning the plateau has another cause. If ~0, the reward
// shape genuinely can't center the aim past this point.
const AIM_SPAN = 2.5, AIM_SPAN_V = 1.5;
const TGT_LAT = 0.45, TGT_V = 0.55;
function mulberry32(seed: number) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function gauss(r: () => number) { const u1 = Math.max(r(), 1e-9); return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * r()); }
const r = mulberry32(99);
for (const mu of [0.45, 0.35, 0.25, 0.15, 0.05, -0.05]) {
  const sig = 0.3;
  let acc = 0, accRaw = 0, n = 200000;
  for (let i = 0; i < n; i++) {
    const a = Math.max(-1, Math.min(1, mu + gauss(r) * sig));
    const lat = a * AIM_SPAN;
    const vert = 0; // vertical perfect for this probe
    let rew: number;
    if (Math.abs(lat) <= TGT_LAT && Math.abs(vert) <= TGT_V) rew = 1;
    else { const missM = Math.hypot(Math.max(0, Math.abs(lat) - TGT_LAT), Math.max(0, Math.abs(vert) - TGT_V)); rew = -0.08 * Math.min(4, missM / 0.5); }
    const m = Math.tanh(mu);
    acc += ((a - m) / (sig * sig)) * (1 - m * m) * rew; // full score-fn incl 1/σ²
    accRaw += (a - m) * rew;
  }
  console.log(`mu=${mu.toFixed(2)} (tanh ${Math.tanh(mu).toFixed(2)}): E[score] = ${(acc / n).toFixed(5)}  E[(a−μ)r] = ${(accRaw / n).toFixed(5)}  hitP=${(() => { let h = 0; const rr = mulberry32(5); for (let i = 0; i < 100000; i++) { const x = Math.max(-1, Math.min(1, mu + gauss(rr) * sig)); const v = 0; if (Math.abs(x * AIM_SPAN) <= TGT_LAT && Math.abs(v) <= TGT_V) h++; } return (h / 100000).toFixed(3); })()}`);
}
