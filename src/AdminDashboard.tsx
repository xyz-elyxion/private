// Admin metrics dashboard (/admin). Read-only visualizations over data we
// already keep — career stats, registrations, and the per-event audit timeline.
// Gated on isAdmin both here (UX) and server-side (every /api/admin/* route runs
// requireAdmin). Charts are hand-rolled SVG: no charting dependency, and they
// match the game's cyan/zinc deck aesthetic.

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  Crosshair,
  Gamepad2,
  Inbox,
  LayoutDashboard,
  Package,
  PanelLeftClose,
  PanelLeftOpen,
  Users,
} from 'lucide-react';
import { useAuth , authHeaders } from './auth';
import { apiUrl } from './game/urls';

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
    const r = await fetch(apiUrl(url), { ...authHeaders(), credentials: 'include' });
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

// ── Sidebar navigation (command-deck shell) ────────────────────────────────
// Workspace-style sidebar format: collapsible left rail with grouped nav,
// per-item badges (live counts), shortcut hints, and a top bar with breadcrumb.
// Same six panels as before — just re-homed. lucide icons at 1.5 stroke match
// the deck's thin technical line style.
type Tab = 'overview' | 'activity' | 'retention' | 'matches' | 'players' | 'feedback';
const TAB_TITLES: Record<Tab, string> = {
  overview: 'Overview',
  activity: 'Activity',
  retention: 'Retention',
  matches: 'Matches',
  players: 'Players',
  feedback: 'Feedback',
};

function NavItem({
  item,
  activeId,
  onSelect,
}: {
  item: { id: Tab; title: string; icon: React.ElementType; badge?: number | string };
  activeId: Tab;
  onSelect: (id: Tab) => void;
}) {
  const isActive = activeId === item.id;
  const Icon = item.icon;
  return (
    <button
      onClick={() => onSelect(item.id)}
      className={`group flex w-full items-center justify-between rounded-md px-2.5 py-[7px] text-left transition-all duration-200 select-none ${
        isActive
          ? 'bg-cyan-400/10 text-cyan-200'
          : 'text-white/50 hover:bg-white/5 hover:text-white/90'
      }`}
    >
      <span className="flex items-center gap-2.5">
        <Icon
          className={`h-4 w-4 transition-colors ${
            isActive ? 'text-cyan-300' : 'text-white/35 group-hover:text-white/70'
          }`}
          strokeWidth={1.5}
        />
        <span className="truncate text-[13px] tracking-wide">{item.title}</span>
      </span>
      {item.badge !== undefined && item.badge !== 0 && (
        <span
          className={`flex h-5 min-w-[20px] items-center justify-center rounded-full px-1.5 text-[10px] font-medium tabular-nums ${
            isActive ? 'bg-cyan-400/20 text-cyan-200' : 'bg-white/10 text-white/60'
          }`}
        >
          {item.badge}
        </span>
      )}
    </button>
  );
}

function SidebarNav({
  tab,
  onTab,
  badges,
}: {
  tab: Tab;
  onTab: (t: Tab) => void;
  badges: Partial<Record<Tab, number | string>>;
}) {
  const groups: { heading?: string; items: { id: Tab; title: string; icon: React.ElementType; badge?: number | string }[] }[] = [
    {
      items: [{ id: 'overview', title: 'Overview', icon: LayoutDashboard, badge: badges.overview }],
    },
    {
      heading: 'Metrics',
      items: [
        { id: 'activity', title: 'Activity', icon: Activity },
        { id: 'retention', title: 'Retention', icon: Users },
        { id: 'matches', title: 'Matches', icon: Crosshair },
        { id: 'players', title: 'Players', icon: Users },
      ],
    },
    {
      heading: 'Community',
      items: [{ id: 'feedback', title: 'Feedback', icon: Inbox, badge: badges.feedback }],
    },
  ];
  return (
    <div className="flex flex-1 flex-col gap-4 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {groups.map((g, i) => (
        <div key={i} className="flex flex-col gap-0.5">
          {g.heading && (
            <span className="mb-1 px-2.5 text-[10px] font-semibold tracking-[0.18em] text-white/25 uppercase">
              {g.heading}
            </span>
          )}
          {g.items.map((item) => (
            <NavItem key={item.id} item={item} activeId={tab} onSelect={onTab} />
          ))}
        </div>
      ))}
    </div>
  );
}

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
function PlayersTab() {
  const [players, setPlayers] = useState<PlayerRow[] | null>(null);
  const [sort, setSort] = useState('recent');
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
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
                <th className="py-1.5 pr-3 font-medium">Joined</th>
                <th className="py-1.5 pr-3 font-medium">Last seen</th>
              </tr>
            </thead>
            <tbody className="text-white/75">
              {players.map((p) => (
                <tr key={p.id} className="border-t border-white/8">
                  <td className="py-2 pr-3 text-white/85">
                    <span className="flex items-center gap-1.5">
                      {p.userName}
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
                  <td className="py-2 pr-3 text-white/45">{new Date(p.createdAt).toLocaleDateString()}</td>
                  <td className="py-2 pr-3 text-white/45">{ago(p.lastSeen)}</td>
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
    const r = await fetch(apiUrl(url), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(body),
    });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

function FeedbackCard({
  f,
  onStatus,
}: {
  f: FeedbackRow;
  onStatus: (id: number, status: FeedbackRow['status']) => void;
}) {
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
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[10px] text-white/35">
        <span className="text-white/55">{f.playerName}{f.playerId ? '' : ' · guest'}</span>
        <span>{ago(f.ts)}</span>
        {f.ip && <span>{f.ip}</span>}
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
      {rows.length === 0 && !loading ? (
        <Empty label="No feedback yet." />
      ) : rows.length === 0 ? (
        <Loading />
      ) : (
        <div className="flex flex-col gap-2">
          {rows.map((f) => (
            <FeedbackCard key={f.id} f={f} onStatus={updateStatus} />
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

// ── Shared states ────────────────────────────────────────────────────────────
function Loading() {
  return <div className="py-10 text-center text-[12px] uppercase tracking-[0.2em] text-white/35">Loading…</div>;
}
function Empty({ label }: { label: string }) {
  return <div className="py-8 text-center text-[12px] text-white/35">{label}</div>;
}

// ── Page shell ───────────────────────────────────────────────────────────────
// Downloads /api/admin/portal-zip (the production static build, zipped for
// upload to other gaming portals). Fetched as a blob so a missing build or a
// failed session surfaces as a message instead of a mystery JSON download.
function PortalZipButton() {
  const [state, setState] = useState<'idle' | 'working' | 'error'>('idle');
  const download = async () => {
    setState('working');
    try {
      const r = await fetch('/api/admin/portal-zip', { ...authHeaders(), credentials: 'include' });
      if (!r.ok) {
        setState('error');
        window.setTimeout(() => setState('idle'), 4000);
        return;
      }
      const blob = await r.blob();
      // Prefer the server's dated filename from Content-Disposition.
      const cd = r.headers.get('content-disposition') ?? '';
      const m = /filename="([^"]+)"/.exec(cd);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = m?.[1] ?? 'elyxion-portal.zip';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setState('idle');
    } catch {
      setState('error');
      window.setTimeout(() => setState('idle'), 4000);
    }
  };
  return (
    <button
      onClick={() => void download()}
      disabled={state === 'working'}
      title="Download the production static build (dist/) as a zip for submitting to other gaming portals"
      className="flex items-center gap-2 rounded-md border border-white/15 px-3 py-1.5 text-[11px] uppercase tracking-[0.14em] text-white/60 transition hover:border-cyan-400/50 hover:text-cyan-200 disabled:opacity-50"
    >
      <Package className="h-3.5 w-3.5" strokeWidth={1.5} />
      {state === 'error' ? 'Build unavailable' : state === 'working' ? 'Packaging…' : 'Portal zip'}
    </button>
  );
}

export default function AdminDashboard() {
  const auth = useAuth();
  const [tab, setTab] = useState<Tab>('overview');
  const [overview, setOverview] = useState<Overview | null>(null);
  const [live, setLive] = useState<LiveCounts | null>(null);
  const [navOpen, setNavOpen] = useState(true);
  const [searchOpen, setSearchOpen] = useState(false);

  const isAdmin = !!auth.account?.isAdmin;

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

  const activeTitle = TAB_TITLES[tab];

  return (
    <div className="deck-bg flex h-screen overflow-hidden text-white">
      {/* ── Sidebar rail ── */}
      <div
        className={`h-full shrink-0 overflow-hidden border-r border-white/10 bg-black/40 backdrop-blur transition-all duration-300 ease-in-out ${
          navOpen ? 'w-[240px] opacity-100' : 'w-0 border-none opacity-0'
        }`}
      >
        <div className="flex h-full w-[240px] flex-col p-3">
          {/* Workspace tile */}
          <div className="mb-4 flex items-center gap-3 rounded-lg px-2 py-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-[6px] bg-cyan-400/15 font-display text-[15px] font-semibold text-cyan-300 ring-1 ring-cyan-400/30">
              E
            </div>
            <div className="flex min-w-0 flex-col">
              <span className="max-w-[140px] truncate font-display text-[13px] leading-none tracking-[0.08em] text-white/90">
                ELYXION
              </span>
              <span className="mt-1 text-[11px] leading-none text-white/40">
                {live ? `${live.online} online` : 'command deck'}
              </span>
            </div>
          </div>

          <SidebarNav tab={tab} onTab={setTab} badges={{ overview: live?.online }} />

          {/* Bottom: back to arena (portal zip lives in the top bar) */}
          <div className="mt-auto flex flex-col gap-0.5 border-t border-white/10 pt-3">
            <a
              href="/play"
              className="group flex items-center gap-2.5 rounded-md px-2.5 py-[7px] text-white/50 transition hover:bg-white/5 hover:text-white/90"
            >
              <Gamepad2 className="h-4 w-4 text-white/35 transition-colors group-hover:text-white/70" strokeWidth={1.5} />
              <span className="text-[13px] tracking-wide">Back to arena</span>
            </a>
          </div>
        </div>
      </div>

      {/* ── Main column ── */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-white/10 bg-black/30 px-4 backdrop-blur">
          <div className="flex items-center gap-3">
            <button
              onClick={() => setNavOpen(!navOpen)}
              className="rounded-md p-1.5 text-white/50 transition hover:bg-white/5 hover:text-white/90"
              title={navOpen ? 'Collapse sidebar' : 'Expand sidebar'}
            >
              {navOpen ? (
                <PanelLeftClose className="h-[18px] w-[18px]" strokeWidth={1.5} />
              ) : (
                <PanelLeftOpen className="h-[18px] w-[18px]" strokeWidth={1.5} />
              )}
            </button>
            <div className="flex items-center gap-2 text-[13px] text-white/45">
              <span className="truncate">Elyxion</span>
              <span className="text-white/20">/</span>
              <span className="truncate font-medium text-white/90">{activeTitle}</span>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <PortalZipButton />
            <div
              className="flex h-8 w-8 items-center justify-center rounded-full bg-cyan-400/10 text-[11px] font-medium text-cyan-300 ring-1 ring-cyan-400/25"
              title={`Signed in as ${auth.account.username}`}
            >
              {auth.account.username.charAt(0).toUpperCase()}
            </div>
          </div>
        </header>

        <main className="flex-1 overflow-y-auto p-6 [scrollbar-width:thin]">
          <div className="mx-auto max-w-6xl">
            {tab === 'overview' && <OverviewTab overview={overview} live={live} />}
            {tab === 'activity' && <ActivityTab />}
            {tab === 'retention' && <RetentionTab />}
            {tab === 'matches' && <MatchesTab />}
            {tab === 'players' && <PlayersTab />}
            {tab === 'feedback' && <FeedbackTab />}
          </div>
        </main>
      </div>
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
