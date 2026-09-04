// Admin metrics dashboard (/admin). Read-only visualizations over data we
// already keep — career stats, registrations, and the per-event audit timeline.
// Gated on isAdmin both here (UX) and server-side (every /api/admin/* route runs
// requireAdmin). Charts are hand-rolled SVG: no charting dependency, and they
// match the game's cyan/zinc deck aesthetic.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from './auth';
import {
  RL_DIFFICULTIES,
  RL_DIFFICULTY_LABEL,
  seedRlBrain,
  type RlBrain,
} from './game/rl-brain';

// ── API shapes (mirror server/db.ts) ─────────────────────────────────────────
type MetricsWindow = { matches: number; activePlayers: number; newAccounts: number; logins: number };
type Overview = {
  totalAccounts: number;
  playersWithGames: number;
  totalMatches: number;
  onlineMatches: number;
  totalKills: number;
  totalDeaths: number;
  globalAccuracy: number;
  totalXp: number;
  avgLifetimeDays: number;
  stickiness: number;
  windows: { day: MetricsWindow; week: MetricsWindow; month: MetricsWindow };
};
type DayPoint = {
  date: string;
  matches: number;
  logins: number;
  registrations: number;
  activePlayers: number;
};
type Cohort = { date: string; size: number; d1: number; d7: number };
type MatchRow = {
  id: number;
  ts: number;
  playerId: string;
  playerName: string;
  kills: number;
  deaths: number;
  won: boolean;
  headshots: number;
  accuracy: number;
  offline: boolean;
  xp: number;
  mode: string | null;
};
// Moderation ban list entries (mirror server/db.ts): kind 'name' is a display-
// name ban, kind 'ip' an address ban (auto-captured from an online player, or
// set directly via /banip), kind 'guest' a guest-uuid ban (the anonymous igpid
// identity guests get — see server/auth.ts).
type BanEntry = {
  kind: 'name' | 'ip' | 'guest';
  name: string;
  ip?: string;
  guestId?: string;
  reason: string;
  bannedBy: string;
  createdAt: number;
  bannedUntil: number; // epoch ms the ban lifts; 0 = permanent
};
// One live connection as the server's moderation layer sees it (/api/admin/
// online) — mirrors server/elyxion-game.ts OnlinePlayer.
type OnlinePlayer = {
  id: string;
  name: string;
  kind: 'account' | 'guest';
  playerId?: string;
  guestId?: string;
  admin: boolean;
  verified: boolean;
  ip: string;
  connectedAt: number;
  location: 'lobby' | 'in-match' | 'spectating';
  room?: { id: string; name: string; mode: string; mapId: string; members: number };
};
// Guest identities are RFC 4122 uuids (lowercase hex + dashes) — account ids
// are 24-char hex with no dashes, so a dash test cleanly separates them. Used
// to spot guest-attributed rows (community/feedback/support) and shorten ids.
const GUEST_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const isGuestId = (v: string): boolean => GUEST_ID_RE.test(v.toLowerCase());
const shortGuest = (id: string | undefined): string => (id ? `${id.slice(0, 8)}…` : '');
type PlayerRow = {
  id: string;
  userName: string;
  level: number;
  totalGames: number;
  totalKills: number;
  totalDeaths: number;
  headshots: number;
  bestAccuracy: number;
  totalXp: number;
  credits: number;
  kd: number;
  lastSeen: number;
  createdAt: number;
  admin: boolean;
  verified: boolean;
};
type LiveCounts = { online: number; inMatch: number; rooms: number };

async function getJSON<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url, { credentials: 'same-origin' });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

// ── Formatting helpers ───────────────────────────────────────────────────────
const fmt = (n: number): string => n.toLocaleString('en-US');
const pct = (n: number): string => `${Math.round(n * 100)}%`;
// mm:ss.s clear time for the weekly speedrun (0 = no winning run).
const fmtClear = (ms: number): string => {
  if (ms <= 0) return '—';
  const s = ms / 1000;
  const m = Math.floor(s / 60);
  const rem = (s - m * 60).toFixed(1);
  return m > 0 ? `${m}:${rem.padStart(4, '0')}` : `${rem}s`;
};
const fmtBytes = (b: number): string =>
  b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : b >= 1e3 ? `${Math.round(b / 1e3)} KB` : `${b} B`;
function ago(ts: number): string {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  const m = s / 60;
  if (m < 60) return `${Math.floor(m)}m ago`;
  const h = m / 60;
  if (h < 24) return `${Math.floor(h)}h ago`;
  const d = h / 24;
  if (d < 30) return `${Math.floor(d)}d ago`;
  return new Date(ts).toLocaleDateString();
}
const dayLabel = (iso: string): string => iso.slice(5); // MM-DD

// ── Tiny SVG charts ──────────────────────────────────────────────────────────
type Series = { label: string; color: string; points: number[] };

// Multi-series line chart over a shared x-axis. Fixed viewBox, scales to width.
function LineChart({ series, labels }: { series: Series[]; labels: string[] }) {
  const W = 800;
  const H = 200;
  const padL = 6;
  const padR = 6;
  const padT = 12;
  const padB = 22;
  const n = labels.length;
  const max = Math.max(1, ...series.flatMap((s) => s.points));
  const x = (i: number) => padL + (n <= 1 ? 0 : (i / (n - 1)) * (W - padL - padR));
  const y = (v: number) => padT + (1 - v / max) * (H - padT - padB);
  const grid = [0, 0.25, 0.5, 0.75, 1];
  const xticks =
    n <= 1 ? [0] : [0, Math.floor((n - 1) / 2), n - 1].filter((v, i, a) => a.indexOf(v) === i);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="time series">
      {grid.map((g) => (
        <line
          key={g}
          x1={padL}
          x2={W - padR}
          y1={padT + g * (H - padT - padB)}
          y2={padT + g * (H - padT - padB)}
          stroke="rgba(255,255,255,0.07)"
          strokeWidth={1}
        />
      ))}
      <text x={padL} y={padT - 3} fill="rgba(255,255,255,0.4)" fontSize={11} fontFamily="monospace">
        {fmt(max)}
      </text>
      {series.map((s) => {
        const d = s.points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p).toFixed(1)}`).join(' ');
        const area = `${d} L${x(n - 1).toFixed(1)},${(H - padB).toFixed(1)} L${x(0).toFixed(1)},${(H - padB).toFixed(1)} Z`;
        return (
          <g key={s.label}>
            <path d={area} fill={s.color} opacity={0.08} />
            <path d={d} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            {n <= 30 &&
              s.points.map((p, i) => <circle key={i} cx={x(i)} cy={y(p)} r={1.8} fill={s.color} />)}
          </g>
        );
      })}
      {xticks.map((i) => (
        <text
          key={i}
          x={x(i)}
          y={H - 6}
          fill="rgba(255,255,255,0.4)"
          fontSize={11}
          fontFamily="monospace"
          textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}
        >
          {labels[i] ? dayLabel(labels[i]) : ''}
        </text>
      ))}
    </svg>
  );
}

// Simple vertical bar chart (one series).
function BarChart({ data, color }: { data: { label: string; value: number }[]; color: string }) {
  const W = 800;
  const H = 180;
  const padT = 12;
  const padB = 22;
  const n = data.length;
  const max = Math.max(1, ...data.map((d) => d.value));
  const bw = n > 0 ? (W / n) * 0.7 : 0;
  const gap = n > 0 ? (W / n) * 0.3 : 0;
  const xticks =
    n <= 1 ? [0] : [0, Math.floor((n - 1) / 2), n - 1].filter((v, i, a) => a.indexOf(v) === i);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="bar chart">
      <text x={2} y={padT - 3} fill="rgba(255,255,255,0.4)" fontSize={11} fontFamily="monospace">
        {fmt(max)}
      </text>
      {data.map((d, i) => {
        const h = (d.value / max) * (H - padT - padB);
        const xx = i * (bw + gap) + gap / 2;
        return (
          <rect
            key={i}
            x={xx}
            y={H - padB - h}
            width={bw}
            height={Math.max(0, h)}
            rx={2}
            fill={color}
            opacity={0.85}
          >
            <title>{`${d.label}: ${fmt(d.value)}`}</title>
          </rect>
        );
      })}
      {xticks.map((i) => (
        <text
          key={i}
          x={i * (bw + gap) + gap / 2 + bw / 2}
          y={H - 6}
          fill="rgba(255,255,255,0.4)"
          fontSize={11}
          fontFamily="monospace"
          textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}
        >
          {data[i] ? dayLabel(data[i].label) : ''}
        </text>
      ))}
    </svg>
  );
}

// ── Shared UI atoms (deck aesthetic) ─────────────────────────────────────────
function StatTile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-white/10 bg-black/30 px-4 py-3">
      <div className="text-[10px] uppercase tracking-[0.18em] text-white/45">{label}</div>
      <div className="mt-1 font-display text-2xl text-cyan-200 tabular-nums">{value}</div>
      {sub && <div className="mt-0.5 text-[11px] text-white/40">{sub}</div>}
    </div>
  );
}

function Panel({ title, children, right }: { title: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-white/10 bg-zinc-950/60 p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-[11px] font-bold uppercase tracking-[0.18em] text-white/55">{title}</h3>
        {right}
      </div>
      {children}
    </div>
  );
}

function Legend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <div className="flex flex-wrap gap-3">
      {items.map((it) => (
        <span key={it.label} className="flex items-center gap-1.5 text-[11px] text-white/55">
          <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: it.color }} />
          {it.label}
        </span>
      ))}
    </div>
  );
}

const COLORS = {
  cyan: '#22d3ee',
  emerald: '#34d399',
  amber: '#fbbf24',
  fuchsia: '#e879f9',
} as const;

type Tab = 'overview' | 'activity' | 'retention' | 'matches' | 'players' | 'feedback' | 'anticheat' | 'support' | 'community' | 'ai' | 'announcements';
const TABS: { id: Tab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'activity', label: 'Activity' },
  { id: 'retention', label: 'Retention' },
  { id: 'matches', label: 'Matches' },
  { id: 'players', label: 'Players' },
  { id: 'feedback', label: 'Feedback' },
  { id: 'anticheat', label: 'Anticheat' },
  { id: 'support', label: 'Support' },
  { id: 'community', label: 'Community' },
  { id: 'ai', label: 'AI brains' },
  { id: 'announcements', label: 'Announcements' },
];

// ── Tab: Overview ────────────────────────────────────────────────────────────
function OverviewTab({ overview, live }: { overview: Overview | null; live: LiveCounts | null }) {
  if (!overview) return <Loading />;
  const o = overview;
  const w = o.windows;
  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile label="Accounts" value={fmt(o.totalAccounts)} sub={`${fmt(o.playersWithGames)} have played`} />
        <StatTile label="Matches recorded" value={fmt(o.totalMatches)} sub={`${fmt(o.onlineMatches)} online`} />
        <StatTile label="Total kills" value={fmt(o.totalKills)} sub={`${fmt(o.totalDeaths)} deaths`} />
        <StatTile label="Global accuracy" value={`${o.globalAccuracy}%`} sub="rail hits / shots" />
        <StatTile label="XP awarded" value={fmt(o.totalXp)} />
        <StatTile label="Avg lifetime" value={`${o.avgLifetimeDays}d`} sub="first → last seen" />
        <StatTile label="Stickiness" value={pct(o.stickiness)} sub="DAU / MAU" />
        <StatTile
          label="Live now"
          value={live ? fmt(live.online) : '—'}
          sub={live ? `${fmt(live.inMatch)} in match · ${fmt(live.rooms)} rooms` : 'connecting…'}
        />
      </div>

      <Panel title="Activity windows">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-[12px] font-mono">
            <thead>
              <tr className="text-[10px] uppercase tracking-[0.16em] text-white/40">
                <th className="py-1.5 pr-4 font-medium">Window</th>
                <th className="py-1.5 pr-4 font-medium">Active players</th>
                <th className="py-1.5 pr-4 font-medium">Matches</th>
                <th className="py-1.5 pr-4 font-medium">New accounts</th>
                <th className="py-1.5 pr-4 font-medium">Logins</th>
              </tr>
            </thead>
            <tbody className="text-white/75">
              {([
                ['Last 24h', w.day],
                ['Last 7 days', w.week],
                ['Last 30 days', w.month],
              ] as const).map(([label, win]) => (
                <tr key={label} className="border-t border-white/8">
                  <td className="py-2 pr-4 text-white/55">{label}</td>
                  <td className="py-2 pr-4 tabular-nums text-cyan-200">{fmt(win.activePlayers)}</td>
                  <td className="py-2 pr-4 tabular-nums">{fmt(win.matches)}</td>
                  <td className="py-2 pr-4 tabular-nums text-emerald-300">{fmt(win.newAccounts)}</td>
                  <td className="py-2 pr-4 tabular-nums">{fmt(win.logins)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <WeeklyChallengePanel />
    </div>
  );
}

// This week's weekly-challenge participation (the solo FFA speedrun). Self-fetches
// /api/admin/metrics/weekly; renders nothing until it loads (overview stays clean).
type WeeklyChallengeStats = {
  week: string;
  participants: number;
  runs: number;
  winners: number;
  bestTimeMs: number;
  topKills: number;
  replaysStored: number;
  replayBytes: number;
  map: string;
  fragLimit: number;
};

function WeeklyChallengePanel() {
  const [w, setW] = useState<WeeklyChallengeStats | null>(null);
  useEffect(() => {
    let active = true;
    void getJSON<{ weekly: WeeklyChallengeStats }>('/api/admin/metrics/weekly').then((d) => {
      if (active && d?.weekly) setW(d.weekly);
    });
    return () => {
      active = false;
    };
  }, []);
  if (!w) return null;
  return (
    <Panel
      title="Weekly Challenge"
      right={<span className="text-[11px] text-white/40">{w.map} · first to {w.fragLimit}</span>}
    >
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile label="Participants" value={fmt(w.participants)} sub={`${fmt(w.runs)} runs`} />
        <StatTile label="Winners" value={fmt(w.winners)} sub="beat the bots" />
        <StatTile
          label="Fastest clear"
          value={fmtClear(w.bestTimeMs)}
          sub={w.winners ? 'this week' : 'no winner yet'}
        />
        <StatTile label="Replays stored" value={fmt(w.replaysStored)} sub={fmtBytes(w.replayBytes)} />
      </div>
    </Panel>
  );
}

// ── Tab: Activity ────────────────────────────────────────────────────────────
function ActivityTab() {
  const [days, setDays] = useState(30);
  const [series, setSeries] = useState<DayPoint[] | null>(null);
  useEffect(() => {
    let active = true;
    setSeries(null);
    void getJSON<{ series: DayPoint[] }>(`/api/admin/metrics/timeseries?days=${days}`).then((d) => {
      if (active) setSeries(d?.series ?? []);
    });
    return () => {
      active = false;
    };
  }, [days]);
  const labels = useMemo(() => (series ?? []).map((p) => p.date), [series]);
  if (!series) return <Loading />;
  const rangeBtn = (
    <div className="flex gap-1">
      {[7, 30, 90].map((d) => (
        <button
          key={d}
          onClick={() => setDays(d)}
          className={`rounded px-2 py-1 text-[10px] uppercase tracking-[0.14em] transition ${
            days === d ? 'bg-cyan-400/15 text-cyan-300' : 'text-white/40 hover:text-white/70'
          }`}
        >
          {d}d
        </button>
      ))}
    </div>
  );
  return (
    <div className="flex flex-col gap-5">
      <Panel title="Engagement" right={rangeBtn}>
        <Legend
          items={[
            { label: 'Active players', color: COLORS.cyan },
            { label: 'Matches', color: COLORS.emerald },
          ]}
        />
        <div className="mt-2">
          <LineChart
            labels={labels}
            series={[
              { label: 'Active players', color: COLORS.cyan, points: series.map((p) => p.activePlayers) },
              { label: 'Matches', color: COLORS.emerald, points: series.map((p) => p.matches) },
            ]}
          />
        </div>
      </Panel>
      <Panel title="New registrations / day">
        <BarChart data={series.map((p) => ({ label: p.date, value: p.registrations }))} color={COLORS.fuchsia} />
      </Panel>
      <Panel title="Logins / day">
        <BarChart data={series.map((p) => ({ label: p.date, value: p.logins }))} color={COLORS.amber} />
      </Panel>
    </div>
  );
}

// ── Tab: Retention ───────────────────────────────────────────────────────────
function RetentionTab() {
  const [cohorts, setCohorts] = useState<Cohort[] | null>(null);
  useEffect(() => {
    let active = true;
    void getJSON<{ cohorts: Cohort[] }>(`/api/admin/metrics/retention?days=21`).then((d) => {
      if (active) setCohorts(d?.cohorts ?? []);
    });
    return () => {
      active = false;
    };
  }, []);
  if (!cohorts) return <Loading />;
  const eligible = cohorts.filter((c) => c.size > 0);
  const totalSize = eligible.reduce((s, c) => s + c.size, 0);
  const d1 = eligible.reduce((s, c) => s + c.d1, 0);
  const d7 = eligible.reduce((s, c) => s + c.d7, 0);
  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile label="New players (21d)" value={fmt(totalSize)} sub="registered cohorts" />
        <StatTile label="D1 retention" value={totalSize ? pct(d1 / totalSize) : '—'} sub={`${fmt(d1)} returned next day`} />
        <StatTile label="D7 retention" value={totalSize ? pct(d7 / totalSize) : '—'} sub={`${fmt(d7)} returned in a week`} />
        <StatTile label="Cohorts" value={fmt(eligible.length)} sub="days with signups" />
      </div>
      <Panel title="Retention by signup day">
        {eligible.length === 0 ? (
          <Empty label="No registrations in the last 21 days." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[12px] font-mono">
              <thead>
                <tr className="text-[10px] uppercase tracking-[0.16em] text-white/40">
                  <th className="py-1.5 pr-4 font-medium">Signup day</th>
                  <th className="py-1.5 pr-4 font-medium">New</th>
                  <th className="py-1.5 pr-4 font-medium">D1</th>
                  <th className="py-1.5 pr-4 font-medium">D7</th>
                </tr>
              </thead>
              <tbody className="text-white/75">
                {eligible
                  .slice()
                  .reverse()
                  .map((c) => (
                    <tr key={c.date} className="border-t border-white/8">
                      <td className="py-2 pr-4 text-white/55">{c.date}</td>
                      <td className="py-2 pr-4 tabular-nums">{fmt(c.size)}</td>
                      <td className="py-2 pr-4">
                        <RetentionBar value={c.d1} total={c.size} color={COLORS.cyan} />
                      </td>
                      <td className="py-2 pr-4">
                        <RetentionBar value={c.d7} total={c.size} color={COLORS.emerald} />
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}

function RetentionBar({ value, total, color }: { value: number; total: number; color: string }) {
  const frac = total > 0 ? value / total : 0;
  return (
    <div className="flex items-center gap-2">
      <div className="h-2 w-24 overflow-hidden rounded-full bg-white/10">
        <div className="h-full rounded-full" style={{ width: `${frac * 100}%`, background: color }} />
      </div>
      <span className="tabular-nums text-white/60">
        {value}/{total} · {total ? pct(frac) : '—'}
      </span>
    </div>
  );
}

// ── Tab: Matches ─────────────────────────────────────────────────────────────
const MODE_LABEL: Record<string, string> = { ffa: 'FFA', duel: 'Duel', tdm: 'TDM', ranked: 'Ranked' };
function MatchesTab() {
  const [matches, setMatches] = useState<MatchRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [done, setDone] = useState(false);
  const load = useCallback(async (before?: number) => {
    setLoading(true);
    const d = await getJSON<{ matches: MatchRow[] }>(
      `/api/admin/metrics/matches?limit=50${before ? `&before=${before}` : ''}`,
    );
    const rows = d?.matches ?? [];
    setMatches((prev) => (before ? [...prev, ...rows] : rows));
    if (rows.length < 50) setDone(true);
    setLoading(false);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <Panel title="Recent matches">
      {matches.length === 0 && !loading ? (
        <Empty label="No recorded matches yet." />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-[12px] font-mono">
            <thead>
              <tr className="text-[10px] uppercase tracking-[0.16em] text-white/40">
                <th className="py-1.5 pr-3 font-medium">When</th>
                <th className="py-1.5 pr-3 font-medium">Player</th>
                <th className="py-1.5 pr-3 font-medium">Mode</th>
                <th className="py-1.5 pr-3 font-medium">K</th>
                <th className="py-1.5 pr-3 font-medium">D</th>
                <th className="py-1.5 pr-3 font-medium">HS</th>
                <th className="py-1.5 pr-3 font-medium">Acc</th>
                <th className="py-1.5 pr-3 font-medium">Result</th>
                <th className="py-1.5 pr-3 font-medium">XP</th>
              </tr>
            </thead>
            <tbody className="text-white/75">
              {matches.map((m) => (
                <tr key={m.id} className="border-t border-white/8">
                  <td className="py-2 pr-3 text-white/45">{ago(m.ts)}</td>
                  <td className="py-2 pr-3 text-white/85">{m.playerName}</td>
                  <td className="py-2 pr-3 text-white/55">
                    {m.offline ? 'Practice' : m.mode ? MODE_LABEL[m.mode] ?? m.mode : '—'}
                  </td>
                  <td className="py-2 pr-3 tabular-nums">{m.kills}</td>
                  <td className="py-2 pr-3 tabular-nums">{m.deaths}</td>
                  <td className="py-2 pr-3 tabular-nums text-fuchsia-300">{m.headshots}</td>
                  <td className="py-2 pr-3 tabular-nums">{m.accuracy}%</td>
                  <td className="py-2 pr-3">
                    {m.won ? (
                      <span className="text-emerald-300">WIN</span>
                    ) : (
                      <span className="text-white/35">loss</span>
                    )}
                  </td>
                  <td className="py-2 pr-3 tabular-nums text-amber-200">+{m.xp}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="mt-3 flex justify-center">
        {!done && matches.length > 0 && (
          <button
            onClick={() => load(matches[matches.length - 1]?.id)}
            disabled={loading}
            className="rounded-md border border-white/15 px-4 py-1.5 text-[11px] uppercase tracking-[0.14em] text-white/60 transition hover:border-cyan-400/50 hover:text-cyan-200 disabled:opacity-40"
          >
            {loading ? 'Loading…' : 'Load more'}
          </button>
        )}
      </div>
    </Panel>
  );
}

// ── Tab: Players ─────────────────────────────────────────────────────────────
const PLAYER_SORTS: { id: string; label: string }[] = [
  { id: 'recent', label: 'Last seen' },
  { id: 'kills', label: 'Kills' },
  { id: 'games', label: 'Games' },
  { id: 'level', label: 'Level' },
  { id: 'accuracy', label: 'Accuracy' },
  { id: 'xp', label: 'XP' },
];
// Ban duration presets for the ban dialog (ms; 0 = permanent).
const BAN_DURATIONS: { label: string; ms: number }[] = [
  { label: '1 hour', ms: 60 * 60 * 1000 },
  { label: '6 hours', ms: 6 * 60 * 60 * 1000 },
  { label: '12 hours', ms: 12 * 60 * 60 * 1000 },
  { label: '1 day', ms: 24 * 60 * 60 * 1000 },
  { label: '3 days', ms: 3 * 24 * 60 * 60 * 1000 },
  { label: '7 days', ms: 7 * 24 * 60 * 60 * 1000 },
  { label: '30 days', ms: 30 * 24 * 60 * 60 * 1000 },
  { label: 'Permanent', ms: 0 },
];
// Compact label for a duration / time remaining: "30m", "2h", "3d", "1w".
const msLabel = (ms: number): string => {
  if (ms <= 0) return 'now';
  const mins = ms / 60_000;
  if (mins < 60) return `${Math.round(mins)}m`;
  const hrs = mins / 60;
  if (hrs < 24) return `${Math.round(hrs)}h`;
  const days = hrs / 24;
  if (days < 7) return `${Math.round(days)}d`;
  return `${Math.round((days / 7) * 10) / 10}w`;
};
// ── Ban-by-guest (shared by the content tabs) ───────────────────────────────
// Guest-authored content rows (community messages / feedback / support tickets)
// carry the author's anonymous igpid uuid as playerId once the identity cookie
// is in place (see server/auth.ts). An admin can ban that identity straight
// from the row: the ban persists against the uuid — refused at the guest's next
// connect, even with a fresh name or IP — and boots them now if they're online.
function useGuestBan() {
  const [target, setTarget] = useState<{ id: string; name: string } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    if (!msg) return;
    const t = setTimeout(() => setMsg(null), 6000);
    return () => clearTimeout(t);
  }, [msg]);
  return {
    target,
    msg,
    open: (id: string, name: string) => setTarget({ id, name }),
    close: () => setTarget(null),
    report: (m: string) => setMsg(m),
  };
}

function BanGuestModal({
  guest,
  onClose,
  onResult,
}: {
  guest: { id: string; name: string };
  onClose: () => void;
  onResult: (msg: string) => void;
}) {
  const [reason, setReason] = useState('');
  const [durationMs, setDurationMs] = useState(0);
  const [busy, setBusy] = useState(false);
  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    const d = await postJSON<{ ok: boolean }>('/api/admin/ban', {
      guest: guest.id,
      reason: reason.trim().slice(0, 200),
      durationMs,
    });
    setBusy(false);
    if (d?.ok) {
      onResult(
        durationMs > 0
          ? `Banned guest ${shortGuest(guest.id)} for ${msLabel(durationMs)}.`
          : `Banned guest ${shortGuest(guest.id)} permanently.`,
      );
    } else {
      onResult(`Couldn't ban guest ${shortGuest(guest.id)} — moderation needs an admin session login.`);
    }
    onClose();
  };
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm rounded-lg border border-rose-400/30 bg-zinc-950 p-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className='mb-1 font-mono text-[13px] font-semibold text-rose-200'>
          Ban guest {shortGuest(guest.id)}
        </h3>
        <p className='mb-3 font-mono text-[10px] leading-relaxed text-rose-200/60'>
          Author: {guest.name || 'Guest'} · {guest.id}. The ban follows this
          browser's anonymous id across reconnects.
        </p>
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && confirm()}
          placeholder='Reason (optional)'
          autoFocus
          className='mb-2 w-full rounded-md border border-white/15 bg-black/40 px-3 py-1.5 font-mono text-[12px] text-white outline-none focus:border-rose-400/60'
        />
        <select
          value={durationMs}
          onChange={(e) => setDurationMs(Number(e.target.value))}
          className='w-full rounded-md border border-white/15 bg-black/40 px-2 py-1.5 font-mono text-[12px] text-white/80 outline-none focus:border-rose-400/60'
        >
          {BAN_DURATIONS.map((d) => (
            <option key={d.ms} value={d.ms} className='bg-zinc-900'>
              {d.label}
            </option>
          ))}
        </select>
        <div className='mt-4 flex items-center justify-end gap-2'>
          <button
            onClick={onClose}
            className='rounded border border-white/15 px-3 py-1 font-mono text-[11px] uppercase tracking-wider text-white/60 transition hover:text-white/90'
          >
            Cancel
          </button>
          <button
            onClick={confirm}
            disabled={busy}
            className='rounded border border-rose-500/40 px-3 py-1 font-mono text-[11px] uppercase tracking-wider text-rose-200 transition hover:border-rose-400/70 hover:text-rose-100 disabled:opacity-40'
          >
            Ban
          </button>
        </div>
      </div>
    </div>
  );
}

// Account controls are separate from moderation: admins can grant credits or
// replace a password for registered accounts. The server revokes all sessions
// after a password replacement, so the target must log in again everywhere.
function AccountManageModal({
  player,
  onClose,
  onResult,
  onCredits,
}: {
  player: PlayerRow;
  onClose: () => void;
  onResult: (message: string) => void;
  onCredits: (credits: number) => void;
}) {
  const [password, setPassword] = useState('');
  const [currentCredits, setCurrentCredits] = useState(player.credits);
  const [passwordAgain, setPasswordAgain] = useState('');
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState<'password' | 'credits' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const resetPassword = async () => {
    if (busy) return;
    if (password.length < 6 || password.length > 200) {
      setError('Password must be 6 to 200 characters.');
      return;
    }
    if (password !== passwordAgain) {
      setError('Passwords do not match.');
      return;
    }
    setBusy('password');
    setError(null);
    const result = await postJSON<{ ok: boolean }>('/api/admin/password', {
      username: player.userName,
      password,
    });
    setBusy(null);
    if (!result?.ok) {
      setError('Password change failed.');
      return;
    }
    setPassword('');
    setPasswordAgain('');
    onResult(`Password reset for ${player.userName}; all existing sessions were revoked.`);
  };

  const grant = async () => {
    if (busy) return;
    const value = Number(amount);
    if (!Number.isSafeInteger(value) || value < 1 || value > 1_000_000) {
      setError('Enter a whole-number grant from 1 to 1,000,000.');
      return;
    }
    setBusy('credits');
    setError(null);
    const result = await postJSON<{ ok: boolean; credits?: number }>('/api/admin/credits', {
      username: player.userName,
      amount: value,
    });
    setBusy(null);
    if (!result?.ok || typeof result.credits !== 'number') {
      setError('Credit grant failed.');
      return;
    }
    setAmount('');
    setCurrentCredits(result.credits);
    onCredits(result.credits);
    onResult(`Granted ${fmt(value)} credits to ${player.userName}; new balance: ${fmt(result.credits)}.`);
  };

  return (
    <div className='fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4' onClick={onClose}>
      <div
        className='w-full max-w-md rounded-lg border border-cyan-400/30 bg-zinc-950 p-4 shadow-2xl'
        onClick={(event) => event.stopPropagation()}
      >
        <div className='flex items-start justify-between gap-3'>
          <div>
            <h3 className='font-mono text-[13px] font-semibold text-cyan-100'>Manage {player.userName}</h3>
            <p className='mt-1 font-mono text-[10px] text-white/45'>Account actions are recorded in the admin audit log.</p>
          </div>
          <button
            type='button'
            onClick={onClose}
            aria-label='Close account management'
            className='rounded p-1 text-white/45 transition hover:bg-white/10 hover:text-white'
          >
            ×
          </button>
        </div>
        {error && <div className='mt-3 rounded border border-rose-400/35 bg-rose-400/10 px-3 py-2 font-mono text-[11px] text-rose-200'>{error}</div>}
        <div className='mt-4 border-t border-white/10 pt-3'>
          <div className='mb-2 font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-white/50'>Grant credits</div>
          <div className='flex gap-2'>
            <input
              type='number'
              min='1'
              max='1000000'
              step='1'
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              placeholder='Amount'
              className='min-w-0 flex-1 rounded-md border border-white/15 bg-black/40 px-3 py-2 font-mono text-[12px] text-white outline-none focus:border-cyan-400/60'
            />
            <button
              type='button'
              onClick={() => void grant()}
              disabled={busy !== null || !amount}
              className='rounded-md border border-amber-400/40 px-3 py-2 font-mono text-[10px] font-bold uppercase tracking-[0.12em] text-amber-200 transition hover:bg-amber-400/10 disabled:opacity-40'
            >
              {busy === 'credits' ? 'Granting...' : 'Grant'}
            </button>
          </div>
          <div className='mt-1 font-mono text-[10px] text-white/35'>Current balance: {fmt(currentCredits)}</div>
        </div>
        <div className='mt-4 border-t border-white/10 pt-3'>
          <div className='mb-1 font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-white/50'>Reset password</div>
          <p className='mb-2 font-mono text-[10px] leading-relaxed text-rose-200/60'>This signs the account out on every device. The player must use the new password to log in again.</p>
          <div className='flex flex-col gap-2'>
            <input
              type='password'
              minLength={6}
              maxLength={200}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder='New password'
              className='w-full rounded-md border border-white/15 bg-black/40 px-3 py-2 font-mono text-[12px] text-white outline-none focus:border-cyan-400/60'
            />
            <input
              type='password'
              minLength={6}
              maxLength={200}
              value={passwordAgain}
              onChange={(event) => setPasswordAgain(event.target.value)}
              placeholder='Repeat new password'
              className='w-full rounded-md border border-white/15 bg-black/40 px-3 py-2 font-mono text-[12px] text-white outline-none focus:border-cyan-400/60'
            />
            <button
              type='button'
              onClick={() => void resetPassword()}
              disabled={busy !== null || !password || !passwordAgain}
              className='self-start rounded-md border border-rose-400/40 px-3 py-2 font-mono text-[10px] font-bold uppercase tracking-[0.12em] text-rose-200 transition hover:bg-rose-400/10 disabled:opacity-40'
            >
              {busy === 'password' ? 'Resetting...' : 'Reset password'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// Moderation actions on the players table + the live online list (accounts AND
// guests). Bans persist server-side; kick disconnects a live player (must be
// online to hit). Both are session-only routes — the token/read-only path can't
// mutate. Guests are moderated by their anonymous uuid (the igpid cookie): a
// guest ban follows the browser across reconnects even when their per-room
// "Guest N" name renumbers or the IP changes.
type BanTarget = { kind: 'name' | 'guest'; id: string };
function PlayersTab() {
  const [players, setPlayers] = useState<PlayerRow[] | null>(null);
  const [sort, setSort] = useState('recent');
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [bans, setBans] = useState<BanEntry[]>([]);
  const [online, setOnline] = useState<OnlinePlayer[] | null>(null);
  const [modBusy, setModBusy] = useState<string | null>(null);
  const [modMsg, setModMsg] = useState<string | null>(null);
  const [banTarget, setBanTarget] = useState<BanTarget | null>(null);
  const [accountTarget, setAccountTarget] = useState<PlayerRow | null>(null);
  const [banReason, setBanReason] = useState('');
  const [banDurationMs, setBanDurationMs] = useState(0);
  // Bans: NAME rows flag the players table (banned chip + Unban toggle); IP and
  // GUEST rows render as removable chips below. Re-fetched after every action
  // because a name unban also lifts the IPs + guest uuids that ban captured
  // (server-side).
  const reloadBans = useCallback(() => {
    void getJSON<{ bans: BanEntry[] }>('/api/admin/bans').then((d) => {
      if (d) setBans(d.bans ?? []);
    });
  }, []);
  // Live sockets right now — incl. each guest individually (uuid + IP). Polled
  // so joins/leaves and live bans show up without a manual refresh.
  const loadOnline = useCallback(() => {
    void getJSON<{ online: OnlinePlayer[] }>('/api/admin/online').then((d) => {
      setOnline(d?.online ?? null);
    });
  }, []);
  useEffect(() => {
    reloadBans();
    loadOnline();
    const t = setInterval(loadOnline, 10_000);
    return () => clearInterval(t);
  }, [reloadBans, loadOnline]);
  const nameBanMap = useMemo(
    () => new Map(bans.filter((b) => b.kind === 'name').map((b) => [b.name.toLowerCase(), b])),
    [bans],
  );
  const nameBanSet = useMemo(() => new Set(nameBanMap.keys()), [nameBanMap]);
  const ipBans = useMemo(() => bans.filter((b) => b.kind === 'ip'), [bans]);
  const guestBans = useMemo(() => bans.filter((b) => b.kind === 'guest'), [bans]);
  const guestBanSet = useMemo(
    () => new Set(guestBans.map((b) => (b.guestId ?? '').toLowerCase())),
    [guestBans],
  );
  // Auto-dismiss the action result line.
  useEffect(() => {
    if (!modMsg) return;
    const t = setTimeout(() => setModMsg(null), 5000);
    return () => clearTimeout(t);
  }, [modMsg]);
  const banLabel = (t: BanTarget): string =>
    t.kind === 'guest' ? `guest ${shortGuest(t.id)}` : `“${t.id}”`;
  // Open the duration/reason dialog instead of a prompt — bans are no longer
  // always permanent.
  const openBan = (t: BanTarget) => {
    if (modBusy) return;
    setBanReason('');
    setBanDurationMs(0);
    setBanTarget(t);
  };
  // Moderate an ACCOUNT by display name (kick / ban / unban).
  const moderate = (name: string, verb: 'kick' | 'ban' | 'unban') => {
    if (modBusy) return;
    if (verb === 'ban') {
      openBan({ kind: 'name', id: name });
      return;
    }
    setModBusy(name);
    void postJSON<{ ok: boolean }>(`/api/admin/${verb}`, { name, reason: '' }).then((d) => {
      setModBusy(null);
      if (d?.ok) {
        setModMsg(verb === 'kick' ? `Kicked ${name}.` : `Unbanned ${name}.`);
        if (verb === 'unban') reloadBans();
      } else {
        setModMsg(
          verb === 'unban'
            ? `“${name}” wasn't banned.`
            : `“${name}” isn't online right now (kick needs a live connection).`,
        );
      }
    });
  };
  // Moderate a GUEST by their uuid (kick / ban / unban).
  const moderateGuest = (guestId: string, verb: 'kick' | 'ban' | 'unban') => {
    if (modBusy) return;
    if (verb === 'ban') {
      openBan({ kind: 'guest', id: guestId });
      return;
    }
    const short = shortGuest(guestId);
    setModBusy(guestId);
    void postJSON<{ ok: boolean }>(`/api/admin/${verb}`, { guest: guestId }).then((d) => {
      setModBusy(null);
      if (d?.ok) {
        setModMsg(verb === 'kick' ? `Kicked guest ${short}.` : `Unbanned guest ${short}.`);
        if (verb === 'unban') reloadBans();
      } else {
        setModMsg(
          verb === 'unban'
            ? `Guest ${short} wasn't banned.`
            : `Guest ${short} isn't online right now (kick needs a live connection).`,
        );
      }
    });
  };
  // Confirm the ban dialog — target a display name or a guest uuid; timed when
  // a non-zero duration is picked.
  const confirmBan = () => {
    if (!banTarget || modBusy) return;
    const target = banTarget;
    const durationMs = banDurationMs;
    const label = banLabel(target);
    setModBusy(target.id);
    void postJSON<{ ok: boolean }>('/api/admin/ban', {
      ...(target.kind === 'guest' ? { guest: target.id } : { name: target.id }),
      reason: banReason.trim().slice(0, 200),
      durationMs,
    }).then((d) => {
      setModBusy(null);
      setBanTarget(null);
      if (d?.ok) {
        setModMsg(
          durationMs > 0
            ? `Banned ${label} for ${msLabel(durationMs)} (their IP too).`
            : `Banned ${label} permanently (their IP too).`,
        );
        reloadBans();
        loadOnline();
      } else {
        setModMsg(`Couldn't ban ${label}.`);
      }
    });
  };
  // Lift a direct IP ban from the strip below.
  const moderateIp = (ip: string) => {
    if (modBusy) return;
    setModBusy(ip);
    void postJSON<{ ok: boolean }>('/api/admin/unban', { ip }).then((d) => {
      setModBusy(null);
      if (d?.ok) {
        setModMsg(`Unbanned IP ${ip}.`);
        reloadBans();
      } else {
        setModMsg(`IP ${ip} wasn't banned.`);
      }
    });
  };
  // Lift a guest-uuid ban from the strip below (also lifts the IP it captured).
  const unbanGuestBan = (guestId: string) => {
    if (modBusy) return;
    setModBusy(guestId);
    void postJSON<{ ok: boolean }>('/api/admin/unban', { guest: guestId }).then((d) => {
      setModBusy(null);
      if (d?.ok) {
        setModMsg(`Unbanned guest ${shortGuest(guestId)}.`);
        reloadBans();
        loadOnline();
      } else {
        setModMsg(`Guest ${shortGuest(guestId)} wasn't banned.`);
      }
    });
  };
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), 250);
    return () => clearTimeout(t);
  }, [q]);
  useEffect(() => {
    let active = true;
    setPlayers(null);
    void getJSON<{ players: PlayerRow[] }>(
      `/api/admin/metrics/players?sort=${sort}&limit=200&q=${encodeURIComponent(debouncedQ)}`,
    ).then((d) => {
      if (active) setPlayers(d?.players ?? []);
    });
    return () => {
      active = false;
    };
  }, [sort, debouncedQ]);
  const controls = (
    <div className="flex items-center gap-2">
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search name…"
        className="rounded-md border border-white/15 bg-black/40 px-3 py-1.5 font-mono text-[12px] text-white outline-none focus:border-cyan-400/60"
      />
      <select
        value={sort}
        onChange={(e) => setSort(e.target.value)}
        className="rounded-md border border-white/15 bg-black/40 px-2 py-1.5 font-mono text-[12px] text-white/80 outline-none focus:border-cyan-400/60"
      >
        {PLAYER_SORTS.map((s) => (
          <option key={s.id} value={s.id} className="bg-zinc-900">
            {s.label}
          </option>
        ))}
      </select>
    </div>
  );
  return (
    <Panel title="Players" right={controls}>
      {accountTarget && (
        <AccountManageModal
          player={accountTarget}
          onClose={() => setAccountTarget(null)}
          onResult={(message) => setModMsg(message)}
          onCredits={(credits) => {
            setPlayers((prev) => prev?.map((row) => (row.id === accountTarget.id ? { ...row, credits } : row)) ?? null);
            setAccountTarget((prev) => (prev ? { ...prev, credits } : prev));
          }}
        />
      )}
      {banTarget && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
          onClick={() => setBanTarget(null)}
        >
          <div
            className="w-full max-w-sm rounded-lg border border-rose-400/30 bg-zinc-950 p-4 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className='mb-3 font-mono text-[13px] font-semibold text-rose-200'>
              Ban {banLabel(banTarget)}
            </h3>
            {banTarget.kind === 'guest' && (
              <p className='mb-2 font-mono text-[10px] leading-relaxed text-rose-200/60'>
                {banTarget.id} — a guest ban follows this browser's anonymous id
                across reconnects, even as their “Guest N” name renumbers.
              </p>
            )}
            <input
              value={banReason}
              onChange={(e) => setBanReason(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && confirmBan()}
              placeholder="Reason (optional)"
              autoFocus
              className="mb-2 w-full rounded-md border border-white/15 bg-black/40 px-3 py-1.5 font-mono text-[12px] text-white outline-none focus:border-rose-400/60"
            />
            <select
              value={banDurationMs}
              onChange={(e) => setBanDurationMs(Number(e.target.value))}
              className="w-full rounded-md border border-white/15 bg-black/40 px-2 py-1.5 font-mono text-[12px] text-white/80 outline-none focus:border-rose-400/60"
            >
              {BAN_DURATIONS.map((d) => (
                <option key={d.ms} value={d.ms} className="bg-zinc-900">
                  {d.label}
                </option>
              ))}
            </select>
            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                onClick={() => setBanTarget(null)}
                className="rounded border border-white/15 px-3 py-1 font-mono text-[11px] uppercase tracking-wider text-white/60 transition hover:text-white/90"
              >
                Cancel
              </button>
              <button
                onClick={confirmBan}
                disabled={modBusy !== null}
                className="rounded border border-rose-500/40 px-3 py-1 font-mono text-[11px] uppercase tracking-wider text-rose-200 transition hover:border-rose-400/70 hover:text-rose-100 disabled:opacity-40"
              >
                Ban
              </button>
            </div>
          </div>
        </div>
      )}
      {modMsg && <div className='mb-3 rounded-md border border-cyan-400/30 bg-cyan-400/10 px-3 py-2 font-mono text-[11px] text-cyan-100'>{modMsg}</div>}
      {ipBans.length > 0 && (
        <div className='mb-3 flex flex-wrap items-center gap-1.5 rounded-md border border-rose-400/25 bg-rose-500/10 px-3 py-2'>
          <span className='mr-1 font-mono text-[10px] uppercase tracking-[0.16em] text-rose-200/80'>IP bans</span>
          {ipBans.map((b) => (
            <span
              key={b.ip}
              className='inline-flex items-center gap-1.5 rounded border border-rose-400/30 bg-rose-950/40 px-2 py-0.5 font-mono text-[11px] text-rose-100'
            >
              {b.ip}
              {b.bannedUntil > 0 && (
                <span className='text-rose-200/50' title={new Date(b.bannedUntil).toLocaleString()}>
                  · {msLabel(b.bannedUntil - Date.now())} left
                </span>
              )}
              {b.reason && <span className='text-rose-200/60'>— {b.reason}</span>}
              <button
                onClick={() => moderateIp(b.ip ?? '')}
                disabled={modBusy !== null}
                title='Lift this IP ban'
                className='text-rose-200/70 underline decoration-dotted transition hover:text-rose-100 disabled:opacity-40'
              >
                unban
              </button>
            </span>
          ))}
        </div>
      )}
      {guestBans.length > 0 && (
        <div className='mb-3 flex flex-wrap items-center gap-1.5 rounded-md border border-amber-400/25 bg-amber-500/10 px-3 py-2'>
          <span className='mr-1 font-mono text-[10px] uppercase tracking-[0.16em] text-amber-200/80'>Guest bans</span>
          {guestBans.map((b) => (
            <span
              key={b.guestId}
              title={b.guestId}
              className='inline-flex items-center gap-1.5 rounded border border-amber-400/30 bg-amber-950/40 px-2 py-0.5 font-mono text-[11px] text-amber-100'
            >
              {shortGuest(b.guestId)}
              {b.bannedUntil > 0 && (
                <span className='text-amber-200/50' title={new Date(b.bannedUntil).toLocaleString()}>
                  · {msLabel(b.bannedUntil - Date.now())} left
                </span>
              )}
              {b.reason && <span className='text-amber-200/60'>— {b.reason}</span>}
              <button
                onClick={() => unbanGuestBan(b.guestId ?? '')}
                disabled={modBusy !== null}
                title='Lift this guest ban (also lifts the IP it captured)'
                className='text-amber-200/70 underline decoration-dotted transition hover:text-amber-100 disabled:opacity-40'
              >
                unban
              </button>
            </span>
          ))}
        </div>
      )}
      {/* Live sockets right now — accounts AND guests. Guests only appear here
          (and by uuid on guest-authored content); the lobby's own presence list
          deliberately shows them as a bare count. */}
      <div className='mb-4 rounded-lg border border-white/10 bg-black/25 p-3'>
        <div className='mb-2 flex items-baseline justify-between gap-2'>
          <h3 className='font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-white/50'>
            Online now
          </h3>
          <span className='font-mono text-[10px] tabular-nums text-white/35'>
            {online === null
              ? '…'
              : `${online.length} ${online.length === 1 ? 'player' : 'players'} · ${online.filter((o) => o.kind === 'guest').length} guest`}
          </span>
        </div>
        {online === null ? (
          <Loading />
        ) : online.length === 0 ? (
          <div className='py-2 font-mono text-[11px] text-white/35'>Nobody online right now.</div>
        ) : (
          <div className='overflow-x-auto'>
            <table className='w-full text-left font-mono text-[11px]'>
              <thead>
                <tr className='text-[9px] uppercase tracking-[0.16em] text-white/35'>
                  <th className='py-1 pr-3 font-medium'>Player</th>
                  <th className='py-1 pr-3 font-medium'>Where</th>
                  <th className='py-1 pr-3 font-medium'>IP</th>
                  <th className='py-1 pr-3 font-medium'>Since</th>
                  <th className='py-1 pr-3 font-medium'>Moderation</th>
                </tr>
              </thead>
              <tbody className='text-white/70'>
                {online.map((o) => {
                  const banned = o.kind === 'guest' ? guestBanSet.has((o.guestId ?? '').toLowerCase()) : nameBanSet.has((o.name ?? '').toLowerCase());
                  return (
                    <tr key={o.id} className='border-t border-white/5 align-top'>
                      <td className='py-1.5 pr-3'>
                        <span className='flex flex-wrap items-center gap-1.5'>
                          <span className='text-white/90'>{o.name}</span>
                          {o.kind === 'guest' ? (
                            <span title={o.guestId} className='text-[9px] uppercase tracking-wide text-fuchsia-300/80'>
                              guest {shortGuest(o.guestId)}
                            </span>
                          ) : (
                            <span className='text-[9px] uppercase tracking-wide text-cyan-300/70'>account</span>
                          )}
                          {o.admin && <span className='text-[9px] uppercase tracking-wide text-amber-300'>staff</span>}
                          {o.verified && <span className='text-cyan-300'>✓</span>}
                          {banned && <span className='text-[9px] uppercase tracking-wide text-rose-300'>banned</span>}
                        </span>
                      </td>
                      <td className='py-1.5 pr-3 text-white/50'>
                        {o.location === 'in-match'
                          ? `match${o.room ? ` · ${o.room.name}` : ''}`
                          : o.location === 'spectating'
                            ? `watching${o.room ? ` · ${o.room.name}` : ''}`
                            : 'lobby'}
                      </td>
                      <td className='py-1.5 pr-3 text-white/40'>{o.ip}</td>
                      <td className='py-1.5 pr-3 text-white/40'>{ago(o.connectedAt)}</td>
                      <td className='py-1.5'>
                        <span className='flex items-center gap-1.5'>
                          <button
                            onClick={() =>
                              o.kind === 'guest'
                                ? moderateGuest(o.guestId ?? '', 'kick')
                                : moderate(o.name, 'kick')
                            }
                            disabled={modBusy !== null}
                            title='Disconnect now (must be live)'
                            className='rounded border border-white/15 px-1.5 py-0.5 text-[9px] font-mono uppercase tracking-wider text-white/70 transition hover:border-amber-300/60 hover:text-amber-200 disabled:opacity-40'
                          >
                            Kick
                          </button>
                          {banned ? (
                            <button
                              onClick={() =>
                                o.kind === 'guest'
                                  ? unbanGuestBan(o.guestId ?? '')
                                  : moderate(o.name, 'unban')
                              }
                              disabled={modBusy !== null}
                              title='Lift this ban'
                              className='rounded border border-amber-400/40 px-1.5 py-0.5 text-[9px] font-mono uppercase tracking-wider text-amber-200 transition hover:border-amber-300/70 hover:text-amber-100 disabled:opacity-40'
                            >
                              Unban
                            </button>
                          ) : (
                            <button
                              onClick={() =>
                                o.kind === 'guest'
                                  ? moderateGuest(o.guestId ?? '', 'ban')
                                  : moderate(o.name, 'ban')
                              }
                              disabled={modBusy !== null}
                              title={
                                o.kind === 'guest'
                                  ? 'Ban this guest by uuid — pick a duration (persisted; kicks them if online)'
                                  : 'Ban this name — pick a duration (persisted; kicks them if online)'
                              }
                              className='rounded border border-rose-500/40 px-1.5 py-0.5 text-[9px] font-mono uppercase tracking-wider text-rose-300 transition hover:border-rose-400/70 hover:text-rose-200 disabled:opacity-40'
                            >
                              Ban
                            </button>
                          )}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {!players ? (
        <Loading />
      ) : players.length === 0 ? (
        <Empty label="No players match." />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-[12px] font-mono">
            <thead>
              <tr className="text-[10px] uppercase tracking-[0.16em] text-white/40">
                <th className="py-1.5 pr-3 font-medium">Player</th>
                <th className="py-1.5 pr-3 font-medium">Lvl</th>
                <th className="py-1.5 pr-3 font-medium">Games</th>
                <th className="py-1.5 pr-3 font-medium">Kills</th>
                <th className="py-1.5 pr-3 font-medium">K/D</th>
                <th className="py-1.5 pr-3 font-medium">Acc</th>
                <th className="py-1.5 pr-3 font-medium">XP</th>
                <th className="py-1.5 pr-3 font-medium">Credits</th>
                <th className="py-1.5 pr-3 font-medium">Joined</th>
                <th className="py-1.5 pr-3 font-medium">Last seen</th>
                <th className="py-1.5 pr-3 font-medium">Moderation</th>
              </tr>
            </thead>
            <tbody className="text-white/75">
              {players.map((p) => (
                <tr key={p.id} className="border-t border-white/8">
                  <td className="py-2 pr-3 text-white/85">
                    <span className="flex items-center gap-1.5">
                      {p.userName}
              {nameBanSet.has((p.userName ?? '').toLowerCase()) && (
                <span className="text-[9px] uppercase tracking-wide text-rose-300">
                  {(() => {
                    const b = nameBanMap.get((p.userName ?? '').toLowerCase());
                    return b && b.bannedUntil > 0
                      ? `banned · ${msLabel(b.bannedUntil - Date.now())} left`
                      : 'banned';
                  })()}
                </span>
              )}
                      {p.admin && <span className="text-[9px] uppercase tracking-wide text-amber-300">staff</span>}
                      {p.verified && <span className="text-cyan-300">✓</span>}
                    </span>
                  </td>
                  <td className="py-2 pr-3 tabular-nums">{p.level}</td>
                  <td className="py-2 pr-3 tabular-nums">{fmt(p.totalGames)}</td>
                  <td className="py-2 pr-3 tabular-nums">{fmt(p.totalKills)}</td>
                  <td className="py-2 pr-3 tabular-nums">{p.kd}</td>
                  <td className="py-2 pr-3 tabular-nums">{Math.round(p.bestAccuracy)}%</td>
                  <td className="py-2 pr-3 tabular-nums text-amber-200">{fmt(p.totalXp)}</td>
                  <td className="py-2 pr-3 tabular-nums text-emerald-200">{fmt(p.credits)}</td>
                  <td className="py-2 pr-3 text-white/45">{new Date(p.createdAt).toLocaleDateString()}</td>
                  <td className="py-2 pr-3 text-white/45">{ago(p.lastSeen)}</td>
                  <td className="py-2 pr-3">
                    <span className="flex items-center gap-1.5">
                      <button
                        onClick={() => setAccountTarget(p)}
                        title='Manage this account: grant credits or reset password'
                        className='rounded border border-cyan-400/40 px-1.5 py-0.5 text-[10px] font-mono uppercase tracking-wider text-cyan-200 transition hover:border-cyan-300/70 hover:text-cyan-100'
                      >
                        Manage
                      </button>
                      <button
                        onClick={() => moderate(p.userName, 'kick')}
                        disabled={modBusy !== null}
                        title='Disconnect this player now (must be online)'
                        className='rounded border border-white/15 px-1.5 py-0.5 text-[10px] font-mono uppercase tracking-wider text-white/70 transition hover:border-amber-300/60 hover:text-amber-200 disabled:opacity-40'
                      >
                        Kick
                      </button>
                      {nameBanSet.has((p.userName ?? '').toLowerCase()) ? (
                        <button
                          onClick={() => moderate(p.userName, 'unban')}
                          disabled={modBusy !== null}
                          title='Lift the ban on this name'
                          className='rounded border border-amber-400/40 px-1.5 py-0.5 text-[10px] font-mono uppercase tracking-wider text-amber-200 transition hover:border-amber-300/70 hover:text-amber-100 disabled:opacity-40'
                        >
                          Unban
                        </button>
                      ) : (
                        <button
                          onClick={() => moderate(p.userName, 'ban')}
                          disabled={modBusy !== null}
                          title='Ban this name — pick a duration (persisted; kicks them if online)'
                          className='rounded border border-rose-500/40 px-1.5 py-0.5 text-[10px] font-mono uppercase tracking-wider text-rose-300 transition hover:border-rose-400/70 hover:text-rose-200 disabled:opacity-40'
                        >
                          Ban
                        </button>
                      )}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

// ── Tab: Feedback ────────────────────────────────────────────────────────────
type FeedbackRow = {
  id: number;
  ts: number;
  playerId: string;
  playerName: string;
  type: 'bug' | 'feature' | 'general';
  title: string;
  body: string;
  status: 'open' | 'ack' | 'resolved' | 'spam';
  ip: string;
  userAgent: string;
  updatedAt: number;
};
const FB_STATUSES = ['open', 'ack', 'resolved', 'spam'] as const;
const FB_STATUS_LABEL: Record<string, string> = { open: 'Open', ack: 'Ack', resolved: 'Resolved', spam: 'Spam' };
const FB_TYPES = ['bug', 'feature', 'general'] as const;
const FB_TYPE_LABEL: Record<string, string> = { bug: 'Bug', feature: 'Feature', general: 'General' };
const FB_TYPE_COLOR: Record<string, string> = { bug: 'text-rose-300', feature: 'text-cyan-300', general: 'text-white/55' };
const FB_STATUS_COLOR: Record<string, string> = {
  open: 'text-amber-300',
  ack: 'text-cyan-300',
  resolved: 'text-emerald-300',
  spam: 'text-white/35',
};

async function postJSON<T>(url: string, body: object): Promise<T | null> {
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

async function delJSON<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url, { method: 'DELETE', credentials: 'same-origin' });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

function FeedbackCard({
  f,
  onStatus,
  onBan,
}: {
  f: FeedbackRow;
  onStatus: (id: number, status: FeedbackRow['status']) => void;
  onBan?: (guestId: string, playerName: string) => void;
}) {
  const guest = isGuestId(f.playerId);
  return (
    <div className="rounded-lg border border-white/10 bg-black/30 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-baseline gap-2 text-[12px]">
          <span className={`font-bold uppercase tracking-[0.12em] ${FB_TYPE_COLOR[f.type] ?? 'text-white/55'}`}>
            {FB_TYPE_LABEL[f.type] ?? f.type}
          </span>
          <span className="font-medium text-white/85">{f.title}</span>
        </div>
        <select
          value={f.status}
          onChange={(e) => onStatus(f.id, e.target.value as FeedbackRow['status'])}
          className={`rounded-md border border-white/15 bg-black/40 px-2 py-1 font-mono text-[11px] outline-none focus:border-cyan-400/60 ${FB_STATUS_COLOR[f.status] ?? 'text-white/70'}`}
        >
          {FB_STATUSES.map((s) => (
            <option key={s} value={s} className="bg-zinc-900 text-white">
              {FB_STATUS_LABEL[s]}
            </option>
          ))}
        </select>
      </div>
      <p className="mt-2 whitespace-pre-wrap break-words text-[12px] leading-relaxed text-white/70">{f.body}</p>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-[10px] text-white/35">
        <span className="text-white/55">
          {f.playerName}
          {(guest || !f.playerId) && <span className='text-white/30'> · guest</span>}
        </span>
        <span>{ago(f.ts)}</span>
        {f.ip && <span>{f.ip}</span>}
        {guest && onBan && (
          <button
            onClick={() => onBan(f.playerId, f.playerName)}
            title='Ban this guest by their anonymous uuid'
            className='ml-auto rounded border border-rose-500/40 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-rose-300 transition hover:border-rose-400/70 hover:text-rose-200'
          >
            Ban guest
          </button>
        )}
      </div>
    </div>
  );
}

function FeedbackTab() {
  const [rows, setRows] = useState<FeedbackRow[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [typeCounts, setTypeCounts] = useState<Record<string, number>>({});
  const [filter, setFilter] = useState<string>('all');
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [loading, setLoading] = useState(true);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ban = useGuestBan();

  const load = useCallback(async (status: string, type: string, before?: number) => {
    setLoading(true);
    const qs =
      `limit=50${status !== 'all' ? `&status=${status}` : ''}` +
      `${type !== 'all' ? `&type=${type}` : ''}${before ? `&before=${before}` : ''}`;
    const d = await getJSON<{
      feedback: FeedbackRow[];
      counts: Record<string, number>;
      typeCounts: Record<string, number>;
    }>(`/api/admin/metrics/feedback?${qs}`);
    const list = d?.feedback ?? [];
    setRows((prev) => (before ? [...prev, ...list] : list));
    if (d?.counts) setCounts(d.counts);
    if (d?.typeCounts) setTypeCounts(d.typeCounts);
    setDone(list.length < 50);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load(filter, typeFilter);
  }, [filter, typeFilter, load]);

  const updateStatus = useCallback(
    async (id: number, status: FeedbackRow['status']) => {
      const ok = await postJSON<{ ok: boolean }>(`/api/admin/feedback/${id}/status`, { status });
      if (!ok) {
        // Surface the failure (likely a token-auth session: status mutations
        // need a real admin session) instead of silently doing nothing.
        setError('Status update failed — moderation needs an admin session login.');
        window.setTimeout(() => setError(null), 5000);
        return;
      }
      setRows((prev) =>
        prev
          .map((r) => (r.id === id ? { ...r, status } : r))
          .filter((r) => filter === 'all' || r.status === filter),
      );
      // Refetch just the counts so the filter chips stay live (cheap, limit=1).
      void getJSON<{ counts: Record<string, number> }>(`/api/admin/metrics/feedback?limit=1`).then(
        (d) => d?.counts && setCounts(d.counts),
      );
    },
    [filter],
  );

  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const chips = (
    <div className="flex flex-col items-end gap-1">
      <div className="flex flex-wrap gap-1">
        {(['all', ...FB_STATUSES] as const).map((s) => {
          const n = s === 'all' ? total : counts[s] ?? 0;
          return (
            <button
              key={s}
              onClick={() => setFilter(s)}
              className={`rounded px-2 py-1 text-[10px] uppercase tracking-[0.14em] transition ${
                filter === s ? 'bg-cyan-400/15 text-cyan-300' : 'text-white/40 hover:text-white/70'
              }`}
            >
              {s === 'all' ? 'All' : FB_STATUS_LABEL[s]}
              {n > 0 && <span className="ml-1 tabular-nums opacity-70">{n}</span>}
            </button>
          );
        })}
      </div>
      {/* Second axis: what KIND of report — bug / feature request / general. */}
      <div className="flex flex-wrap gap-1">
        {(['all', ...FB_TYPES] as const).map((t) => {
          const n = t === 'all' ? total : typeCounts[t] ?? 0;
          return (
            <button
              key={t}
              onClick={() => setTypeFilter(t)}
              className={`rounded px-2 py-1 text-[10px] uppercase tracking-[0.14em] transition ${
                typeFilter === t ? 'bg-fuchsia-400/15 text-fuchsia-300' : 'text-white/40 hover:text-white/70'
              }`}
            >
              {t === 'all' ? 'All types' : FB_TYPE_LABEL[t]}
              {n > 0 && <span className="ml-1 tabular-nums opacity-70">{n}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );

  return (
    <Panel title="Feedback & bug reports" right={chips}>
      {error && (
        <div className="mb-2 rounded-md border border-rose-400/40 bg-rose-400/10 px-3 py-2 text-[11px] text-rose-200">
          {error}
        </div>
      )}
      {ban.msg && (
        <div className="mb-2 rounded-md border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-[11px] text-amber-200">
          {ban.msg}
        </div>
      )}
      {ban.target && <BanGuestModal guest={ban.target} onClose={ban.close} onResult={ban.report} />}
      {rows.length === 0 && !loading ? (
        <Empty label="No feedback yet." />
      ) : rows.length === 0 ? (
        <Loading />
      ) : (
        <div className="flex flex-col gap-2">
          {rows.map((f) => (
            <FeedbackCard key={f.id} f={f} onStatus={updateStatus} onBan={ban.open} />
          ))}
        </div>
      )}
      <div className="mt-3 flex justify-center">
        {!done && rows.length > 0 && (
          <button
            onClick={() => load(filter, typeFilter, rows[rows.length - 1]?.id)}
            disabled={loading}
            className="rounded-md border border-white/15 px-4 py-1.5 text-[11px] uppercase tracking-[0.14em] text-white/60 transition hover:border-cyan-400/50 hover:text-cyan-200 disabled:opacity-40"
          >
            {loading ? 'Loading…' : 'Load more'}
          </button>
        )}
      </div>
    </Panel>
  );
}

// ── Tab: Anticheat ───────────────────────────────────────────────────────────
// What the defensive layer caught and did: rejected hacks (speed / fire-rate /
// shot-origin / aimbot), kicks (afk / flood), blocks (banned at the door /
// profanity), chat timeouts, and bans applied or lifted. Pulls /api/admin/
// anticheat on a 5s poll so a live action shows up within moments.
// ── Tab: Support tickets ───────────────────────────────────────────────────
// Player-facing tickets from the /support page. Status changes + replies mutate
// (need an admin session — token auth is read-only); the list itself is
// token-readable. Replies are appended to the thread the player sees.
type TicketRow = {
  id: number;
  ts: number;
  playerId: string;
  playerName: string;
  category: 'help' | 'report' | 'billing' | 'other';
  subject: string;
  body: string;
  status: 'open' | 'ack' | 'resolved' | 'closed';
  ip: string;
  userAgent: string;
  updatedAt: number;
  replies: { id: number; ts: number; author: string; body: string }[];
};
const TK_STATUSES = ['open', 'ack', 'resolved', 'closed'] as const;
const TK_STATUS_LABEL: Record<string, string> = { open: 'Open', ack: 'Ack', resolved: 'Resolved', closed: 'Closed' };
const TK_STATUS_COLOR: Record<string, string> = {
  open: 'text-amber-300',
  ack: 'text-cyan-300',
  resolved: 'text-emerald-300',
  closed: 'text-white/35',
};
const TK_CATEGORY_LABEL: Record<string, string> = { help: 'Help', report: 'Report', billing: 'Billing', other: 'Other' };
const TK_CATEGORY_COLOR: Record<string, string> = {
  help: 'text-cyan-300',
  report: 'text-rose-300',
  billing: 'text-amber-300',
  other: 'text-white/55',
};

function TicketCard({
  t,
  onStatus,
  onReplied,
  onBan,
}: {
  t: TicketRow;
  onStatus: (id: number, status: TicketRow['status']) => void;
  onReplied: () => void;
  onBan?: (guestId: string, playerName: string) => void;
}) {
  const guest = isGuestId(t.playerId);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const send = async () => {
    if (busy || draft.trim().length === 0) return;
    setBusy(true);
    setErr(null);
    const ok = await postJSON<{ ok: boolean }>(`/api/admin/support/tickets/${t.id}/reply`, {
      text: draft.trim(),
    });
    if (!ok) setErr('Reply failed — moderation needs an admin session login.');
    else {
      setDraft('');
      onReplied();
    }
    setBusy(false);
  };
  return (
    <div className="rounded-lg border border-white/10 bg-black/30 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-baseline gap-2 text-[12px]">
          <span className="font-mono text-[10px] tabular-nums text-white/30">#{t.id}</span>
          <span
            className={`font-bold uppercase tracking-[0.12em] ${TK_CATEGORY_COLOR[t.category] ?? 'text-white/55'}`}
          >
            {TK_CATEGORY_LABEL[t.category] ?? t.category}
          </span>
          <span className="font-medium text-white/85">{t.subject}</span>
        </div>
        <span className="flex items-center gap-2">
          {guest && onBan && (
            <button
              onClick={() => onBan(t.playerId, t.playerName)}
              title='Ban this guest by their anonymous uuid'
              className='rounded border border-rose-500/40 px-1.5 py-1 text-[9px] uppercase tracking-wider text-rose-300 transition hover:border-rose-400/70 hover:text-rose-200'
            >
              Ban guest
            </button>
          )}
          <select
            value={t.status}
            onChange={(e) => onStatus(t.id, e.target.value as TicketRow['status'])}
            className={`rounded-md border border-white/15 bg-black/40 px-2 py-1 font-mono text-[11px] outline-none focus:border-cyan-400/60 ${TK_STATUS_COLOR[t.status] ?? 'text-white/70'}`}
          >
            {TK_STATUSES.map((s) => (
              <option key={s} value={s} className="bg-zinc-900 text-white">
                {TK_STATUS_LABEL[s]}
              </option>
            ))}
          </select>
        </span>
      </div>
      <p className="mt-2 whitespace-pre-wrap break-words text-[12px] leading-relaxed text-white/70">{t.body}</p>
      {t.replies.length > 0 && (
        <div className="mt-2 flex flex-col gap-1.5 border-t border-white/10 pt-2">
          {t.replies.map((r) => (
            <div key={r.id} className="rounded-md bg-cyan-400/5 px-2.5 py-1.5">
              <div className="flex items-baseline justify-between gap-2 font-mono text-[10px]">
                <span className="font-bold uppercase tracking-[0.14em] text-cyan-300/80">{r.author}</span>
                <span className="text-white/30">{ago(r.ts)}</span>
              </div>
              <p className="mt-0.5 whitespace-pre-wrap break-words text-[12px] leading-relaxed text-white/80">
                {r.body}
              </p>
            </div>
          ))}
        </div>
      )}
      <div className="mt-2 flex gap-2 border-t border-white/10 pt-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && send()}
          maxLength={2000}
          placeholder="Reply to the player…"
          className="flex-1 rounded-md border border-white/15 bg-black/40 px-2.5 py-1.5 font-mono text-[12px] text-white outline-none focus:border-cyan-400/60"
        />
        <button
          onClick={send}
          disabled={busy || draft.trim().length === 0}
          className="rounded-md bg-cyan-400 px-3 py-1.5 text-[11px] font-bold uppercase tracking-[0.12em] text-zinc-950 transition hover:bg-cyan-300 disabled:opacity-40"
        >
          {busy ? '…' : 'Reply'}
        </button>
      </div>
      {err && <div className="mt-1.5 text-[10px] text-rose-300">{err}</div>}
      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[10px] text-white/35">
        <span className="text-white/55">{t.playerName}</span>
        <span>{ago(t.ts)}</span>
        {t.ip && <span>{t.ip}</span>}
        {t.replies.length > 0 && (
          <span>
            {t.replies.length} reply{t.replies.length > 1 ? 's' : ''}
          </span>
        )}
      </div>
    </div>
  );
}

function SupportTab() {
  const [rows, setRows] = useState<TicketRow[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [filter, setFilter] = useState<string>('all');
  const [loading, setLoading] = useState(true);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ban = useGuestBan();

  const load = useCallback(async (status: string, before?: number) => {
    setLoading(true);
    const qs =
      `limit=50${status !== 'all' ? `&status=${status}` : ''}${before ? `&before=${before}` : ''}`;
    const d = await getJSON<{
      tickets: TicketRow[];
      counts: Record<string, number>;
    }>(`/api/admin/support/tickets?${qs}`);
    const list = d?.tickets ?? [];
    setRows((prev) => (before ? [...prev, ...list] : list));
    if (d?.counts) setCounts(d.counts);
    setDone(list.length < 50);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load(filter);
  }, [filter, load]);

  const updateStatus = useCallback(
    async (id: number, status: TicketRow['status']) => {
      const ok = await postJSON<{ ok: boolean }>(`/api/admin/support/tickets/${id}/status`, {
        status,
      });
      if (!ok) {
        setError('Status update failed — moderation needs an admin session login.');
        window.setTimeout(() => setError(null), 5000);
        return;
      }
      setRows((prev) =>
        prev
          .map((r) => (r.id === id ? { ...r, status } : r))
          .filter((r) => filter === 'all' || r.status === filter),
      );
      // Keep the filter chips live (cheap, limit=1).
      void getJSON<{ counts: Record<string, number> }>(
        '/api/admin/support/tickets?limit=1',
      ).then((d) => d?.counts && setCounts(d.counts));
    },
    [filter],
  );

  // A reply changes the thread a player sees — refetch the visible list so
  // cards show the new reply + the auto-ack status.
  const refresh = useCallback(() => {
    void load(filter);
  }, [filter, load]);

  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const chips = (
    <div className="flex flex-wrap justify-end gap-1">
      {(['all', ...TK_STATUSES] as const).map((s) => {
        const n = s === 'all' ? total : counts[s] ?? 0;
        return (
          <button
            key={s}
            onClick={() => setFilter(s)}
            className={`rounded px-2 py-1 text-[10px] uppercase tracking-[0.14em] transition ${
              filter === s ? 'bg-cyan-400/15 text-cyan-300' : 'text-white/40 hover:text-white/70'
            }`}
          >
            {s === 'all' ? 'All' : TK_STATUS_LABEL[s]}
            {n > 0 && <span className="ml-1 tabular-nums opacity-70">{n}</span>}
          </button>
        );
      })}
    </div>
  );

  return (
    <Panel title="Support tickets" right={chips}>
      {error && (
        <div className="mb-2 rounded-md border border-rose-400/40 bg-rose-400/10 px-3 py-2 text-[11px] text-rose-200">
          {error}
        </div>
      )}
      {ban.msg && (
        <div className="mb-2 rounded-md border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-[11px] text-amber-200">
          {ban.msg}
        </div>
      )}
      {ban.target && <BanGuestModal guest={ban.target} onClose={ban.close} onResult={ban.report} />}
      {rows.length === 0 && !loading ? (
        <Empty label="No tickets yet." />
      ) : rows.length === 0 ? (
        <Loading />
      ) : (
        <div className="flex flex-col gap-2">
          {rows.map((t) => (
            <TicketCard key={t.id} t={t} onStatus={updateStatus} onReplied={refresh} onBan={ban.open} />
          ))}
        </div>
      )}
      <div className="mt-3 flex justify-center">
        {!done && rows.length > 0 && (
          <button
            onClick={() => load(filter, rows[rows.length - 1]?.id)}
            disabled={loading}
            className="rounded-md border border-white/15 px-4 py-1.5 text-[11px] uppercase tracking-[0.14em] text-white/60 transition hover:border-cyan-400/50 hover:text-cyan-200 disabled:opacity-40"
          >
            {loading ? 'Loading…' : 'Load more'}
          </button>
        )}
      </div>
    </Panel>
  );
}

// ── Tab: Community chat (moderation) ───────────────────────────────────────
// Discord-style web chat messages across all channels, newest first. Deletes
// are soft (hidden everywhere, kept for audit) and need an admin session — the
// list itself is token-readable.
type CommunityMsg = {
  id: number;
  channel: string;
  ts: number;
  playerId: string;
  playerName: string;
  text: string;
  deleted: boolean;
  admin: boolean;
  verified: boolean;
  ip: string;
};
const CM_CHANNEL_LABEL: Record<string, string> = {
  general: '#general',
  'looking-for-match': '#looking-for-match',
  'off-topic': '#off-topic',
};

function CommunityTab() {
  const [rows, setRows] = useState<CommunityMsg[]>([]);
  const [loading, setLoading] = useState(true);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ban = useGuestBan();

  const load = useCallback(async (before?: number) => {
    setLoading(true);
    const qs = `limit=50${before ? `&before=${before}` : ''}`;
    const d = await getJSON<{ messages: CommunityMsg[] }>(`/api/admin/community/messages?${qs}`);
    const list = d?.messages ?? [];
    setRows((prev) => (before ? [...prev, ...list] : list));
    setDone(list.length < 50);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const remove = useCallback(
    async (id: number) => {
      const ok = await postJSON<{ ok: boolean }>(`/api/admin/community/messages/${id}/delete`, {});
      if (!ok) {
        setError('Delete failed — moderation needs an admin session login.');
        window.setTimeout(() => setError(null), 5000);
        return;
      }
      setRows((prev) => prev.map((r) => (r.id === id ? { ...r, deleted: true } : r)));
    },
    [],
  );

  return (
    <Panel title="Community chat" right={
      <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-white/35">
        web chat · soft delete
      </span>
    }>
      {error && (
        <div className="mb-2 rounded-md border border-rose-400/40 bg-rose-400/10 px-3 py-2 text-[11px] text-rose-200">
          {error}
        </div>
      )}
      {ban.msg && (
        <div className="mb-2 rounded-md border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-[11px] text-amber-200">
          {ban.msg}
        </div>
      )}
      {ban.target && <BanGuestModal guest={ban.target} onClose={ban.close} onResult={ban.report} />}
      {rows.length === 0 && !loading ? (
        <Empty label="No community messages yet." />
      ) : rows.length === 0 ? (
        <Loading />
      ) : (
        <div className="flex flex-col gap-2">
          {rows.map((m) => (
            <div key={m.id} className="rounded-lg border border-white/10 bg-black/30 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-baseline gap-2 font-mono text-[11px]">
                  <span className="text-cyan-300/70">{CM_CHANNEL_LABEL[m.channel] ?? `#${m.channel}`}</span>
                  <span className={m.admin ? 'font-bold text-amber-300' : m.verified ? 'text-cyan-300' : 'text-white/85'}>
                    {m.playerName}
                  </span>
                  {m.admin && <span className="text-amber-300/80">●</span>}
                  <span className="text-white/30">{ago(m.ts)}</span>
                </div>
                {!m.deleted ? (
                  <span className="flex items-center gap-1.5">
                    {isGuestId(m.playerId) && (
                      <button
                        onClick={() => ban.open(m.playerId, m.playerName)}
                        title='Ban this guest by their anonymous uuid'
                        className="rounded-md border border-amber-400/30 px-2 py-1 text-[10px] font-bold uppercase tracking-[0.12em] text-amber-300 transition hover:bg-amber-400/10"
                      >
                        Ban guest
                      </button>
                    )}
                    <button
                      onClick={() => void remove(m.id)}
                      className="rounded-md border border-rose-400/30 px-2 py-1 text-[10px] font-bold uppercase tracking-[0.12em] text-rose-300 transition hover:bg-rose-400/10"
                    >
                      Delete
                    </button>
                  </span>
                ) : (
                  <span className="font-mono text-[10px] italic text-white/30">removed</span>
                )}
              </div>
              <p className="mt-1.5 whitespace-pre-wrap break-words text-[12px] leading-relaxed text-white/75">
                {m.deleted ? <span className="italic text-white/30">[removed by staff]</span> : m.text}
              </p>
              {m.ip && !m.deleted && (
                <div className="mt-1 font-mono text-[10px] text-white/25">{m.ip}</div>
              )}
            </div>
          ))}
        </div>
      )}
      <div className="mt-3 flex justify-center">
        {!done && rows.length > 0 && (
          <button
            onClick={() => load(rows[rows.length - 1]?.id)}
            disabled={loading}
            className="rounded-md border border-white/15 px-4 py-1.5 text-[11px] uppercase tracking-[0.14em] text-white/60 transition hover:border-cyan-400/50 hover:text-cyan-200 disabled:opacity-40"
          >
            {loading ? 'Loading…' : 'Load more'}
          </button>
        )}
      </div>
    </Panel>
  );
}

type AcEvent = {
  id: number;
  ts: number;
  kind: string;
  target: string;
  detail: string;
  actor?: string;
  reason?: string;
  count: number;
};
type AcCounts = Record<string, number>;
const AC_KINDS: { kind: string; label: string; cls: string }[] = [
  { kind: 'reject', label: 'Stopped hack', cls: 'border-amber-400/40 bg-amber-400/10 text-amber-300' },
  { kind: 'flag', label: 'Flagged', cls: 'border-rose-400/50 bg-rose-400/10 text-rose-300' },
  { kind: 'ban', label: 'Banned', cls: 'border-rose-400/60 bg-rose-500/10 text-rose-300' },
  { kind: 'unban', label: 'Unbanned', cls: 'border-emerald-400/40 bg-emerald-400/10 text-emerald-300' },
  { kind: 'block', label: 'Blocked', cls: 'border-rose-400/40 bg-rose-400/10 text-rose-300' },
  { kind: 'kick', label: 'Kicked', cls: 'border-amber-400/40 bg-amber-400/10 text-amber-300' },
  { kind: 'timeout', label: 'Timed out', cls: 'border-cyan-400/40 bg-cyan-400/10 text-cyan-300' },
];
function AnticheatTab() {
  const [events, setEvents] = useState<AcEvent[] | null>(null);
  const [counts, setCounts] = useState<AcCounts>({});
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    let active = true;
    const pull = () => {
      void getJSON<{ events: AcEvent[]; counts: AcCounts }>('/api/admin/anticheat?limit=120').then((d) => {
        if (active && d) {
          setEvents(d.events);
          setCounts(d.counts);
        }
      });
    };
    pull();
    const t = setInterval(pull, 5000);
    return () => {
      active = false;
      clearInterval(t);
    };
  }, [paused]);
  const metaFor = (kind: string) => AC_KINDS.find((k) => k.kind === kind);
  const chips = AC_KINDS.filter((k) => (counts[k.kind] ?? 0) > 0);
  return (
    <Panel
      title='Anticheat activity'
      right={
        <div className='flex items-center gap-2'>
          <button
            onClick={() => setPaused((p) => !p)}
            className='rounded-md border border-white/15 px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-white/60 transition hover:border-cyan-400/50 hover:text-cyan-200'
          >
            {paused ? 'Resume' : 'Pause'}
          </button>
          <span className='font-mono text-[10px] uppercase tracking-[0.14em] text-white/35'>5s poll</span>
        </div>
      }
    >
      {chips.length > 0 && (
        <div className='mb-3 flex flex-wrap gap-1.5'>
          {chips.map((k) => (
            <span
              key={k.kind}
              className={`inline-flex items-center gap-1.5 rounded border px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-[0.14em] ${k.cls}`}
            >
              {k.label}
              <span className='tabular-nums opacity-80'>{counts[k.kind]}</span>
            </span>
          ))}
        </div>
      )}
      {!events ? (
        <Loading />
      ) : events.length === 0 ? (
        <Empty label='Nothing caught yet — the guards are quiet. Launch one of the demo hacks (npm run ac:demo) to watch it react.' />
      ) : (
        <div className='max-h-[560px] overflow-y-auto pr-1'>
          <div className='flex flex-col gap-1'>
            {events.map((e) => {
              const meta = metaFor(e.kind);
              return (
                <div
                  key={e.id}
                  className='flex items-baseline gap-3 rounded-md border border-white/8 bg-black/25 px-3 py-1.5 font-mono text-[11px]'
                >
                  <span className='shrink-0 tabular-nums text-white/30'>
                    {new Date(e.ts).toLocaleTimeString()}
                  </span>
                  <span
                    className={`shrink-0 rounded border px-1.5 py-px text-[9px] font-bold uppercase tracking-[0.14em] ${meta?.cls ?? 'border-white/15 text-white/50'}`}
                  >
                    {meta?.label ?? e.kind}
                  </span>
                  <span className='shrink-0 font-semibold text-white/85'>{e.target}</span>
                  <span className='shrink-0 text-white/45'>{e.detail}</span>
                  {e.reason && <span className='truncate text-white/35'>{e.reason}</span>}
                  {e.actor && (
                    <span className='ml-auto shrink-0 text-cyan-200/70'>by {e.actor}</span>
                  )}
                  {e.count > 1 && (
                    <span className='ml-auto shrink-0 font-bold text-amber-300'>×{e.count}</span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </Panel>
  );
}

// ── Tab: Server announcements ───────────────────────────────────────────────
// Site-wide notices shown on the landing page (menu). Posting + deleting need
// an admin session (denyToken server-side); the list itself is token-readable.
type AnnouncementRow = {
  id: number;
  text: string;
  author: string;
  createdAt: number;
  expiresAt: number; // epoch ms; 0 = never expires
};
const ANN_DURATIONS: { label: string; ms: number }[] = [
  { label: 'Until deleted', ms: 0 },
  { label: '1 hour', ms: 60 * 60 * 1000 },
  { label: '6 hours', ms: 6 * 60 * 60 * 1000 },
  { label: '1 day', ms: 24 * 60 * 60 * 1000 },
  { label: '3 days', ms: 3 * 24 * 60 * 60 * 1000 },
  { label: '7 days', ms: 7 * 24 * 60 * 60 * 1000 },
  { label: '30 days', ms: 30 * 24 * 60 * 60 * 1000 },
];

function AnnouncementsTab() {
  const [rows, setRows] = useState<AnnouncementRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [durationMs, setDurationMs] = useState(0);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const d = await getJSON<{ announcements: AnnouncementRow[] }>('/api/admin/announcements');
    setRows(d?.announcements ?? []);
    setLoading(false);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const announce = async () => {
    const text = draft.trim();
    if (busy || !text) return;
    setBusy(true);
    setError(null);
    const d = await postJSON<{ ok: boolean; id?: number }>('/api/admin/announcements', {
      text,
      durationMs,
    });
    if (!d?.ok) {
      setError('Post failed — announcements need an admin session login.');
      window.setTimeout(() => setError(null), 5000);
    } else {
      setDraft('');
      await load();
    }
    setBusy(false);
  };

  const remove = async (id: number) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const d = await delJSON<{ ok: boolean }>(`/api/admin/announcements/${id}`);
    if (!d?.ok) {
      setError('Delete failed — announcements need an admin session login.');
      window.setTimeout(() => setError(null), 5000);
    } else {
      setRows((prev) => prev.filter((r) => r.id !== id));
    }
    setBusy(false);
  };

  const now = Date.now();
  return (
    <Panel
      title="Server announcements"
      right={
        <span className='font-mono text-[10px] uppercase tracking-[0.16em] text-white/35'>
          shown on the landing page
        </span>
      }
    >
      {/* Compose */}
      <div className='mb-4 rounded-lg border border-cyan-400/25 bg-cyan-400/5 p-3'>
        <div className='mb-2 font-mono text-[10px] uppercase tracking-[0.16em] text-cyan-200/80'>
          New announcement
        </div>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void announce();
          }}
          maxLength={500}
          rows={3}
          placeholder={"What should every player know? (e.g. \"Maintenance tonight 11pm UTC\")"}
          className='w-full resize-y rounded-md border border-white/15 bg-black/40 px-3 py-2 font-mono text-[12px] text-white outline-none focus:border-cyan-400/60'
        />
        <div className='mt-2 flex flex-wrap items-center justify-between gap-2'>
          <label className='flex items-center gap-2 font-mono text-[11px] text-white/55'>
            Expires
            <select
              value={durationMs}
              onChange={(e) => setDurationMs(Number(e.target.value))}
              className='rounded-md border border-white/15 bg-black/40 px-2 py-1 font-mono text-[12px] text-white/80 outline-none focus:border-cyan-400/60'
            >
              {ANN_DURATIONS.map((d) => (
                <option key={d.ms} value={d.ms} className='bg-zinc-900'>
                  {d.label}
                </option>
              ))}
            </select>
          </label>
          <div className='flex items-center gap-2'>
            <span className='font-mono text-[10px] tabular-nums text-white/30'>{draft.length}/500</span>
            <button
              onClick={() => void announce()}
              disabled={busy || draft.trim().length === 0}
              className='rounded-md bg-cyan-400 px-4 py-1.5 text-[11px] font-bold uppercase tracking-[0.12em] text-zinc-950 transition hover:bg-cyan-300 disabled:opacity-40'
            >
              {busy ? '…' : 'Announce'}
            </button>
          </div>
        </div>
      </div>

      {error && (
        <div className='mb-2 rounded-md border border-rose-400/40 bg-rose-400/10 px-3 py-2 text-[11px] text-rose-200'>
          {error}
        </div>
      )}

      {loading ? (
        <Loading />
      ) : rows.length === 0 ? (
        <Empty label='No announcements — post one above to reach every player.' />
      ) : (
        <div className='flex flex-col gap-2'>
          {rows.map((a) => {
            const active = a.expiresAt === 0 || a.expiresAt > now;
            return (
              <div key={a.id} className='rounded-lg border border-white/10 bg-black/30 p-3'>
                <div className='flex flex-wrap items-center justify-between gap-2'>
                  <div className='flex items-baseline gap-2 font-mono text-[11px]'>
                    {active ? (
                      <span className='rounded border border-emerald-400/40 bg-emerald-400/10 px-1.5 py-px text-[9px] font-bold uppercase tracking-[0.14em] text-emerald-300'>
                        live
                      </span>
                    ) : (
                      <span className='rounded border border-white/15 px-1.5 py-px text-[9px] font-bold uppercase tracking-[0.14em] text-white/35'>
                        expired
                      </span>
                    )}
                    <span className='text-amber-300/80'>{a.author}</span>
                    <span className='text-white/30'>{ago(a.createdAt)}</span>
                    <span className='text-white/30'>
                      {active
                        ? a.expiresAt > 0
                          ? `expires in ${msLabel(a.expiresAt - now)}`
                          : 'until deleted'
                        : `expired ${ago(a.expiresAt)}`}
                    </span>
                  </div>
                  <button
                    onClick={() => void remove(a.id)}
                    disabled={busy}
                    className='rounded-md border border-rose-400/30 px-2 py-1 text-[10px] font-bold uppercase tracking-[0.12em] text-rose-300 transition hover:bg-rose-400/10 disabled:opacity-40'
                  >
                    Delete
                  </button>
                </div>
                <p className='mt-1.5 whitespace-pre-wrap break-words text-[12px] leading-relaxed text-white/80'>
                  {a.text}
                </p>
              </div>
            );
          })}
        </div>
      )}
    </Panel>
  );
}

// ── Tab: Duel-the-AI brains ─────────────────────────────────────────────────
// The reinforcement-learning duel brains (see src/game/rl-brain.ts + server/
// ai-brain.ts): one SHARED global brain per tier, trained by every "Duel the
// AI" match and persisted in data/*.sqlite. This tab inspects their training
// progress and can reset a tier back to its untrained seed (session-only + audit
// logged server-side) when it has been farmed into something silly.

// How far a brain's current weights have drifted from its untrained seed (L2
// over the whole policy) — a read-only "how much has this tier actually moved"
// signal, alongside the gen/duel/frag tallies.
function weightDriftOf(b: RlBrain): number {
  const seed = seedRlBrain(b.difficulty);
  let sum = 0;
  for (const [key, arr] of (
    [
      ['mov', b.weights.mov],
      ['buttons', b.weights.buttons],
    ] as const
  )) {
    const seedArr = key === 'mov' ? seed.weights.mov : seed.weights.buttons;
    for (let i = 0; i < arr.length; i++) {
      const d = arr[i] - seedArr[i];
      sum += d * d;
    }
  }
  return Math.sqrt(sum);
}

function AiBrainsTab() {
  const [brains, setBrains] = useState<RlBrain[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'err' | 'ok'; text: string } | null>(null);

  const load = useCallback(async () => {
    const d = await getJSON<{ brains: RlBrain[] }>('/api/admin/ai/brains');
    if (!d) {
      setBrains([]);
      return;
    }
    // Fixed tier order (easy → hard), never trusting the wire order.
    const ordered = RL_DIFFICULTIES.map((t) => d.brains.find((b) => b.difficulty === t)).filter(
      (b): b is RlBrain => b != null,
    );
    setBrains(ordered);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const flash = (kind: 'err' | 'ok', text: string) => {
    setMsg({ kind, text });
    window.setTimeout(() => setMsg(null), 5000);
  };

  const reset = async (b: RlBrain) => {
    if (busy) return;
    const label = RL_DIFFICULTY_LABEL[b.difficulty];
    const trained =
      b.duels > 0 ? `${b.duels} duel${b.duels === 1 ? '' : 's'} (${b.gen} policy updates)` : 'no recorded duels';
    if (!window.confirm(`Reset the shared ${label} (${b.difficulty}) brain to its untrained seed?\n\n${trained} of training is wiped for EVERYONE dueling that tier.`)) return;
    setBusy(true);
    setMsg(null);
    const r = await postJSON<{ ok: boolean; brain?: RlBrain }>('/api/admin/ai/brains/reset', {
      difficulty: b.difficulty,
    });
    setBusy(false);
    if (!r?.ok || !r.brain) {
      flash('err', 'Reset failed — brain resets need an admin session login.');
      return;
    }
    flash('ok', `${label} brain reset to its untrained seed.`);
    setBrains((prev) => prev?.map((x) => (x.difficulty === r.brain?.difficulty ? r.brain! : x)) ?? null);
  };

  return (
    <Panel
      title="AI duel brains"
      right={
        <span className='font-mono text-[10px] uppercase tracking-[0.16em] text-white/35'>
          shared per tier · trained by every duel
        </span>
      }
    >
      <div className='mb-4 rounded-lg border border-cyan-400/20 bg-cyan-400/5 p-3 text-[11px] leading-relaxed text-white/55'>
        Each “Duel the AI” match is a training episode: at match end the tier’s
        policy is updated from frags &amp; deaths and saved here. Drift is how far
        the weights have moved from the untrained seed — a rough “how much this
        tier has learned” meter.
      </div>

      {msg && (
        <div
          className={`mb-2 rounded-md border px-3 py-2 text-[11px] ${
            msg.kind === 'err'
              ? 'border-rose-400/40 bg-rose-400/10 text-rose-200'
              : 'border-emerald-400/40 bg-emerald-400/10 text-emerald-200'
          }`}
        >
          {msg.text}
        </div>
      )}

      {!brains ? (
        <Loading />
      ) : brains.length === 0 ? (
        <Empty label='No brains found — duel an AI once to seed a tier.' />
      ) : (
        <div className='flex flex-col gap-2'>
          {brains.map((b) => {
            const totalFrags = b.botFrags + b.humanFrags;
            const botShare = totalFrags > 0 ? Math.round((b.botFrags / totalFrags) * 100) : 0;
            const drift = weightDriftOf(b);
            const trained = b.duels > 0;
            return (
              <div key={b.difficulty} className='rounded-lg border border-white/10 bg-black/30 p-3'>
                <div className='flex flex-wrap items-center justify-between gap-3'>
                  <div className='flex items-center gap-3'>
                    <span
                      className={`rounded-md border px-2.5 py-1 font-display text-[12px] font-bold uppercase tracking-[0.12em] ${
                        b.difficulty === 'easy'
                          ? 'border-emerald-400/40 bg-emerald-400/10 text-emerald-200'
                          : b.difficulty === 'medium'
                            ? 'border-amber-400/40 bg-amber-400/10 text-amber-200'
                            : 'border-rose-400/40 bg-rose-400/10 text-rose-200'
                      }`}
                    >
                      {RL_DIFFICULTY_LABEL[b.difficulty]}
                    </span>
                    <span className='font-mono text-[11px] text-white/45'>{b.difficulty}</span>
                    {!trained && (
                      <span className='rounded border border-white/15 px-1.5 py-px text-[9px] font-bold uppercase tracking-[0.14em] text-white/40'>
                        untrained seed
                      </span>
                    )}
                  </div>
                  <button
                    onClick={() => void reset(b)}
                    disabled={busy}
                    className='rounded-md border border-rose-400/30 px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.12em] text-rose-300 transition hover:bg-rose-400/10 disabled:opacity-40'
                  >
                    {busy ? '…' : 'Reset'}
                  </button>
                </div>

                <div className='mt-3 grid grid-cols-2 gap-3 font-mono text-[12px] sm:grid-cols-4'>
                  <div>
                    <div className='text-[9px] uppercase tracking-[0.16em] text-white/35'>Policy updates</div>
                    <div className='mt-0.5 tabular-nums text-cyan-200'>{fmt(b.gen)}</div>
                  </div>
                  <div>
                    <div className='text-[9px] uppercase tracking-[0.16em] text-white/35'>Duels</div>
                    <div className='mt-0.5 tabular-nums text-white/85'>{fmt(b.duels)}</div>
                  </div>
                  <div>
                    <div className='text-[9px] uppercase tracking-[0.16em] text-white/35'>Frags (bot–human)</div>
                    <div className='mt-0.5 tabular-nums text-white/85'>
                      {fmt(b.botFrags)}–{fmt(b.humanFrags)}
                      <span className='text-white/35'> · {botShare}% bot</span>
                    </div>
                  </div>
                  <div>
                    <div className='text-[9px] uppercase tracking-[0.16em] text-white/35'>Last trained</div>
                    <div className='mt-0.5 tabular-nums text-white/85'>{trained ? ago(b.updatedAt) : '—'}</div>
                  </div>
                </div>

                <div className='mt-2 text-[10px] text-white/35'>
                  <span className='uppercase tracking-[0.14em]'>Weight drift vs seed:</span>{' '}
                  <span className='font-mono tabular-nums text-white/60'>{drift.toFixed(2)}</span>
                  {trained && drift < 0.05 && (
                    <span className='text-amber-300/70'> — duels recorded but the policy barely moved (learning signal is weak)</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Panel>
  );
}

// ── Admin navigation chrome ───────────────────────────────────────────────────
type AdminNavItem = {
  id: Tab;
  title: string;
  icon: 'grid' | 'activity' | 'trend' | 'reticle' | 'users' | 'chat' | 'shield' | 'support' | 'globe' | 'chip' | 'megaphone';
  badge?: number | string;
};

type AdminNavGroup = {
  heading?: string;
  items: AdminNavItem[];
};

const ADMIN_NAV_GROUPS: AdminNavGroup[] = [
  {
    items: [
      { id: 'overview', title: 'Overview', icon: 'grid' },
      { id: 'activity', title: 'Activity', icon: 'activity' },
      { id: 'retention', title: 'Retention', icon: 'trend' },
    ],
  },
  {
    heading: 'Operations',
    items: [
      { id: 'matches', title: 'Matches', icon: 'reticle' },
      { id: 'players', title: 'Players', icon: 'users' },
      { id: 'feedback', title: 'Feedback', icon: 'chat' },
      { id: 'support', title: 'Support', icon: 'support' },
      { id: 'community', title: 'Community', icon: 'globe' },
    ],
  },
  {
    heading: 'Systems',
    items: [
      { id: 'anticheat', title: 'Anticheat', icon: 'shield' },
      { id: 'ai', title: 'AI brains', icon: 'chip' },
      { id: 'announcements', title: 'Announcements', icon: 'megaphone' },
    ],
  },
];

function AdminGlyph({ name, size = 17 }: { name: AdminNavItem['icon'] | 'search' | 'chevron' | 'close' | 'menu' | 'command' | 'logout' | 'back'; size?: number }) {
  const paths: Record<string, string> = {
    grid: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
    activity: 'M3 12h4l2.2-7 4.2 14 2.2-7H21',
    trend: 'M3 17l5-5 4 3 8-9M15 6h5v5',
    reticle: 'M12 2v3M12 19v3M2 12h3M19 12h3M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10z',
    users: 'M16 20v-1.5a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4V20M9.5 10.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM17 11a3 3 0 0 0 0-6M17 14.5h1a4 4 0 0 1 4 4V20',
    chat: 'M4 5h16v11H8l-4 4V5zM8 9h8M8 12h5',
    shield: 'M12 3l8 3v5c0 5-3.4 8.5-8 10-4.6-1.5-8-5-8-10V6l8-3zM9 12l2 2 4-4',
    support: 'M4 13v-2a8 8 0 0 1 16 0v2M4 13h3v5H5a1 1 0 0 1-1-1v-4zM20 13h-3v5h2a1 1 0 0 0 1-1v-4zM12 20h3',
    globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18',
    chip: 'M8 8h8v8H8zM5 9H3M5 12H3M5 15H3M21 9h-2M21 12h-2M21 15h-2M9 5V3M12 5V3M15 5V3M9 21v-2M12 21v-2M15 21v-2',
    megaphone: 'M3 11v2l12 4V7L3 11zM15 9l4-2v10l-4-2M6 14l1 5h3l-1-4',
    search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM17 17l4 4',
    chevron: 'M9 5l7 7-7 7',
    close: 'M6 6l12 12M18 6L6 18',
    menu: 'M4 7h16M4 12h16M4 17h16',
    command: 'M9 9a3 3 0 1 0-3 3 3 3 0 1 0 3 3V9zM15 9a3 3 0 1 1 3 3 3 3 0 1 1-3 3V9zM9 9h6M9 15h6',
    logout: 'M10 5H5v14h5M14 8l4 4-4 4M9 12h9',
    back: 'M19 12H5M11 6l-6 6 6 6',
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox='0 0 24 24'
      fill='none'
      stroke='currentColor'
      strokeWidth='1.6'
      strokeLinecap='round'
      strokeLinejoin='round'
      aria-hidden='true'
    >
      <path d={paths[name] ?? paths.grid} />
    </svg>
  );
}

function AdminWorkspaceSwitcher({ username }: { username: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className='relative'>
      <button
        type='button'
        onClick={() => setOpen((v) => !v)}
        className='group mb-4 flex w-full items-center justify-between rounded-lg px-2 py-2 text-left transition hover:bg-black/[0.04]'
        aria-expanded={open}
      >
        <span className='flex min-w-0 items-center gap-3'>
          <span className='flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-cyan-400 font-display text-sm font-bold text-zinc-950 shadow-sm'>
            E
          </span>
          <span className='flex min-w-0 flex-col'>
            <span className='truncate text-[13px] font-semibold leading-none text-zinc-800'>{username}</span>
            <span className='mt-1 text-[10px] uppercase tracking-[0.16em] text-zinc-400'>Admin workspace</span>
          </span>
        </span>
        <AdminGlyph name='chevron' size={14} />
      </button>
      {open && (
        <>
          <button
            type='button'
            aria-label='Close workspace menu'
            className='fixed inset-0 z-40 cursor-default'
            onClick={() => setOpen(false)}
          />
          <div className='absolute left-0 top-12 z-50 w-full rounded-lg border border-zinc-200 bg-white p-1 shadow-xl'>
            <div className='rounded-md bg-cyan-50 px-3 py-2 text-[12px] font-medium text-cyan-800'>
              Elyxion Admin
            </div>
            <div className='px-3 py-2 text-[11px] text-zinc-400'>Live production workspace</div>
          </div>
        </>
      )}
    </div>
  );
}

function AdminSidebar({
  activeId,
  onSelect,
  username,
  onLogout,
}: {
  activeId: Tab;
  onSelect: (id: Tab) => void;
  username: string;
  onLogout: () => void;
}) {
  return (
    <aside className='flex h-full w-64 shrink-0 flex-col border-r border-zinc-200 bg-white p-3 font-sans'>
      <AdminWorkspaceSwitcher username={username} />
      <nav className='flex-1 overflow-y-auto'>
        {ADMIN_NAV_GROUPS.map((group, groupIndex) => (
          <div key={group.heading ?? `group-${groupIndex}`} className='mb-5'>
            {group.heading && (
              <div className='mb-1 px-2.5 text-[10px] font-bold uppercase tracking-[0.18em] text-zinc-400'>
                {group.heading}
              </div>
            )}
            <div className='flex flex-col gap-0.5'>
              {group.items.map((item) => {
                const active = activeId === item.id;
                return (
                  <button
                    key={item.id}
                    type='button'
                    onClick={() => onSelect(item.id)}
                    className={`group flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[13px] transition ${
                      active
                        ? 'bg-zinc-100 font-semibold text-zinc-900'
                        : 'text-zinc-500 hover:bg-zinc-50 hover:text-zinc-800'
                    }`}
                  >
                    <span className={active ? 'text-zinc-800' : 'text-zinc-400 group-hover:text-zinc-600'}>
                      <AdminGlyph name={item.icon} />
                    </span>
                    <span className='min-w-0 flex-1 truncate'>{item.title}</span>
                    {item.badge && <span className='rounded-full bg-cyan-100 px-1.5 text-[10px] font-semibold text-cyan-700'>{item.badge}</span>}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </nav>
      <div className='flex flex-col gap-0.5 border-t border-zinc-200 pt-3'>
        <a
          href='/play'
          className='group flex items-center gap-2.5 rounded-md px-2.5 py-2 text-[13px] text-zinc-500 transition hover:bg-zinc-50 hover:text-zinc-800'
        >
          <span className='text-zinc-400 group-hover:text-zinc-600'><AdminGlyph name='back' /></span>
          Return to arena
        </a>
        <button
          type='button'
          onClick={onLogout}
          className='group flex items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[13px] text-zinc-500 transition hover:bg-rose-50 hover:text-rose-700'
        >
          <span className='text-zinc-400 group-hover:text-rose-600'><AdminGlyph name='logout' /></span>
          Log out
        </button>
      </div>
    </aside>
  );
}

function AdminSearchPalette({
  open,
  query,
  onQuery,
  onClose,
  onSelect,
}: {
  open: boolean;
  query: string;
  onQuery: (query: string) => void;
  onClose: () => void;
  onSelect: (id: Tab) => void;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  const matches = ADMIN_NAV_GROUPS.flatMap((group) => group.items).filter((item) =>
    item.title.toLowerCase().includes(query.trim().toLowerCase()),
  );
  return (
    <div className='fixed inset-0 z-[100] flex items-start justify-center bg-zinc-950/30 px-4 pt-[13vh] backdrop-blur-sm'>
      <button type='button' aria-label='Close search' className='absolute inset-0 cursor-default' onClick={onClose} />
      <div className='relative w-full max-w-xl overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-2xl'>
        <div className='flex items-center gap-3 border-b border-zinc-200 px-4'>
          <span className='text-zinc-400'><AdminGlyph name='search' /></span>
          <input
            autoFocus
            value={query}
            onChange={(event) => onQuery(event.target.value)}
            placeholder='Search admin sections…'
            className='min-w-0 flex-1 bg-transparent py-4 text-sm text-zinc-900 outline-none placeholder:text-zinc-400'
          />
          <button type='button' onClick={onClose} className='rounded p-1 text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-700'>
            <AdminGlyph name='close' size={17} />
          </button>
        </div>
        <div className='max-h-72 overflow-y-auto p-2'>
          {matches.length === 0 ? (
            <div className='flex flex-col items-center gap-2 px-4 py-10 text-center text-zinc-400'>
              <AdminGlyph name='command' size={24} />
              <span className='text-[13px]'>No admin sections match that search.</span>
            </div>
          ) : (
            matches.map((item) => (
              <button
                key={item.id}
                type='button'
                onClick={() => { onSelect(item.id); onClose(); }}
                className='flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left text-[13px] text-zinc-600 transition hover:bg-cyan-50 hover:text-cyan-800'
              >
                <AdminGlyph name={item.icon} />
                <span className='flex-1'>{item.title}</span>
                <AdminGlyph name='chevron' size={14} />
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

// ── Shared states ────────────────────────────────────────────────────────────
function Loading() {
  return <div className="py-10 text-center text-[12px] uppercase tracking-[0.2em] text-white/35">Loading…</div>;
}
function Empty({ label }: { label: string }) {
  return <div className="py-8 text-center text-[12px] text-white/35">{label}</div>;
}

// ── Page shell ───────────────────────────────────────────────────────────────
export default function AdminDashboard() {
  const auth = useAuth();
  const [tab, setTab] = useState<Tab>('overview');
  const [overview, setOverview] = useState<Overview | null>(null);
  const [live, setLive] = useState<LiveCounts | null>(null);

  const isAdmin = !!auth.account?.isAdmin;
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState('');

  useEffect(() => {
    if (!isAdmin) return;
    let active = true;
    const pull = () => {
      void getJSON<{ overview: Overview }>('/api/admin/metrics/overview').then((d) => {
        if (active && d) setOverview(d.overview);
      });
      void getJSON<LiveCounts>('/api/live').then((d) => {
        if (active && d) setLive(d);
      });
    };
    pull();
    const t = setInterval(pull, 15_000); // keep the live tile + KPIs fresh
    return () => {
      active = false;
      clearInterval(t);
    };
  }, [isAdmin]);

  useEffect(() => {
    const onShortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener('keydown', onShortcut);
    return () => window.removeEventListener('keydown', onShortcut);
  }, []);

  if (!auth.ready) {
    return <Centered>Loading…</Centered>;
  }
  if (!auth.account) {
    return (
      <Centered>
        <div className="text-center">
          <p className="text-white/60">You must be logged in as an admin.</p>
          <a href="/play" className="mt-3 inline-block text-cyan-300 hover:text-cyan-200">
            ← Back to the arena
          </a>
        </div>
      </Centered>
    );
  }
  if (!isAdmin) {
    return (
      <Centered>
        <div className="text-center">
          <p className="font-display text-2xl text-rose-300">403</p>
          <p className="mt-2 text-white/60">This dashboard is admin-only.</p>
          <a href="/play" className="mt-3 inline-block text-cyan-300 hover:text-cyan-200">
            ← Back to the arena
          </a>
        </div>
      </Centered>
    );
  }

  const selectTab = (next: Tab) => {
    setTab(next);
    setSearchOpen(false);
  };

  return (
    <div className='flex h-screen overflow-hidden bg-zinc-50 text-zinc-900'>
      <div className={`shrink-0 overflow-hidden transition-[width] duration-300 ${sidebarOpen ? 'w-64' : 'w-0'}`}>
        <AdminSidebar
          activeId={tab}
          onSelect={selectTab}
          username={auth.account.username}
          onLogout={() => { void auth.logout(); }}
        />
      </div>
      <main className='flex min-w-0 flex-1 flex-col overflow-hidden'>
        <header className='flex h-14 shrink-0 items-center justify-between border-b border-zinc-200 bg-white px-4 sm:px-6'>
          <div className='flex min-w-0 items-center gap-3'>
            <button
              type='button'
              onClick={() => setSidebarOpen((open) => !open)}
              aria-label={sidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'}
              className='rounded-md p-1.5 text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-800'
            >
              <AdminGlyph name='menu' />
            </button>
            <div className='hidden items-center gap-2 text-sm text-zinc-400 sm:flex'>
              <span>Elyxion</span>
              <span>/</span>
              <span className='font-medium text-zinc-800'>{TABS.find((item) => item.id === tab)?.label}</span>
            </div>
          </div>
          <button
            type='button'
            onClick={() => setSearchOpen(true)}
            className='flex w-40 items-center gap-2 rounded-md border border-zinc-200 bg-zinc-50 px-3 py-1.5 text-left text-[12px] text-zinc-400 transition hover:border-zinc-300 hover:bg-white sm:w-64'
          >
            <AdminGlyph name='search' size={15} />
            <span className='flex-1'>Search sections…</span>
            <kbd className='hidden rounded border border-zinc-200 bg-white px-1.5 py-0.5 font-mono text-[10px] text-zinc-400 sm:inline'>⌘K</kbd>
          </button>
        </header>
        <div className='min-h-0 flex-1 overflow-y-auto'>
          <div className='mx-auto w-full max-w-[1400px] px-4 py-6 sm:px-6 lg:px-8'>
            <div className='mb-6 flex flex-wrap items-end justify-between gap-3'>
              <div>
                <div className='mb-1 text-[10px] font-bold uppercase tracking-[0.2em] text-cyan-600'>Command deck</div>
                <h1 className='font-display text-2xl uppercase tracking-[0.14em] text-zinc-900 sm:text-3xl'>
                  {TABS.find((item) => item.id === tab)?.label}
                </h1>
                <p className='mt-1 text-[12px] text-zinc-500'>
                  Signed in as {auth.account.username} · live metrics from production data
                </p>
              </div>
              {live && (
                <div className='flex items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-emerald-700'>
                  <span className='h-1.5 w-1.5 rounded-full bg-emerald-500' />
                  {live.online} online
                </div>
              )}
            </div>

            {tab === 'overview' && <OverviewTab overview={overview} live={live} />}
            {tab === 'activity' && <ActivityTab />}
            {tab === 'retention' && <RetentionTab />}
            {tab === 'matches' && <MatchesTab />}
            {tab === 'players' && <PlayersTab />}
            {tab === 'feedback' && <FeedbackTab />}
            {tab === 'anticheat' && <AnticheatTab />}
            {tab === 'support' && <SupportTab />}
            {tab === 'community' && <CommunityTab />}
            {tab === 'ai' && <AiBrainsTab />}
            {tab === 'announcements' && <AnnouncementsTab />}
          </div>
        </div>
      </main>
      <AdminSearchPalette
        open={searchOpen}
        query={search}
        onQuery={setSearch}
        onClose={() => { setSearchOpen(false); setSearch(''); }}
        onSelect={selectTab}
      />
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-950 font-mono text-sm text-white/70">
      {children}
    </div>
  );
}
