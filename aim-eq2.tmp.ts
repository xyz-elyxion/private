// Numerically probe E[(a−μ)r] (the per-shot REINFORCE score direction) with the
// SEPARABLE quadratic reward at various means — with realistic vertical aim.
const AIM_SPAN = 2.5, AIM_SPAN_V = 1.5;
const REF = 0.5;
function mulberry32(seed: number) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function gauss(r: () => number) { const u1 = Math.max(r(), 1e-9); return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * r()); }
function reward(lat: number, vert: number) {
  if (Math.abs(lat) <= 0.45 && Math.abs(vert) <= 0.55) return 1;
  const h = Math.min(1, Math.pow(Math.max(0, Math.abs(lat) - 0.45) / REF, 2));
  const v = Math.min(1, Math.pow(Math.max(0, Math.abs(vert) - 0.55) / REF, 2));
  return -(h + v);
}
const SIG = 0.3;
for (const [mu, muY] of [[0.45, -0.25], [0.3, -0.25], [0.0, -0.25], [-0.3, -0.25], [-0.45, -0.25], [0.0, 0.0], [-0.3, -0.5], [-0.6, -0.8]] as const) {
  const r = mulberry32(1234);
  let acc = 0, accY = 0, hit = 0, n = 400000;
  for (let i = 0; i < n; i++) {
    const a = Math.max(-1, Math.min(1, mu + gauss(r) * SIG));
    const y = Math.max(-1, Math.min(1, muY + gauss(r) * SIG));
    const rew = reward(a * AIM_SPAN, y * AIM_SPAN_V);
    if (rew === 1) hit++;
    acc += (a - mu) * rew;
    accY += (y - muY) * rew;
  }
  console.log(`mu=${mu.toFixed(2)} muY=${muY.toFixed(2)}: E[(aX−μ)·r]=${(acc/n).toFixed(4)}  E[(aY−μY)·r]=${(accY/n).toFixed(4)}  hitP=${(hit/n*100).toFixed(1)}%`);
}
