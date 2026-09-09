import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { CrosshairMark } from '../pages/Landing';

// ── Types ────────────────────────────────────────────────────────────────────


type PublicProfile = {
  level: number;
  totalXp: number;
  xpIntoLevel: number;
  xpForNext: number;
  credits: number;
  unlocked: string[];
  equipped: Record<string, string>;
  stats: {
    totalKills: number;
    totalDeaths: number;
    totalGames: number;
    totalWins: number;
    bestKillStreak: number;
    headshots: number;
    bestAccuracy: number;
  };
  ranked: {
    id: string;
    userName: string;
    rating: number;
    peak: number;
    games: number;
    wins: number;
    losses: number;
    streak: number;
    rank: number;
    provisional: boolean;
    season: {
      id: number;
      rating: number;
      peak: number;
      games: number;
      wins: number;
      losses: number;
      streak: number;
      rank: number;
      provisional: boolean;
      startsAt: number;
      endsAt: number;
    };
    eligible: boolean;
    level: number;
  } | null;
};

type RecentMatch = {
  id: number;
  ts: number;
  kills: number;
  deaths: number;
  won: boolean;
  headshots: number;
  accuracy: number;
  offline: boolean;
  xp: number;
  mode: string | null;
};

type PublicProfileResp = {
  profile: PublicProfile;
  recentMatches: RecentMatch[];
  username: string;
  isAdmin: boolean;
  isVerified: boolean;
};

// ── Component ────────────────────────────────────────────────────────────────

export default function PublicProfile() {
  const { username } = useParams<{ username: string }>();
  const [profile, setProfile] = useState<PublicProfile | null>(null);
  const [recent, setRecent] = useState<RecentMatch[]>([]);
  const [displayUsername, setDisplayUsername] = useState<string>('');
  const [isAdmin, setIsAdmin] = useState(false);
  const [isVerified, setIsVerified] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!username) return;
    let active = true;
    fetch(`/api/players/${encodeURIComponent(username)}`, {
      credentials: 'same-origin',
    })
      .then((r) => {
        if (r.status === 404) throw new Error('not_found');
        if (!r.ok) throw new Error('fetch_error');
        return r.json() as Promise<PublicProfileResp>;
      })
      .then((d) => {
        if (active) {
          setProfile(d.profile);
          setRecent(d.recentMatches);
          setDisplayUsername(d.username);
          setIsAdmin(d.isAdmin);
          setIsVerified(d.isVerified);
        }
      })
      .catch((err) => {
        if (active) {
          setError(err.message === 'not_found' ? 'Player not found' : 'Failed to load profile');
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [username]);

  // ── helpers ────────────────────────────────────────────────────────────────

  const kd = profile && profile.stats.totalDeaths > 0
    ? (profile.stats.totalKills / profile.stats.totalDeaths).toFixed(2)
    : String(profile?.stats.totalKills ?? '—');

  const accuracy = profile?.stats.bestAccuracy ?? 0;

  const winRate = profile && profile.stats.totalGames > 0
    ? Math.round((profile.stats.totalWins / profile.stats.totalGames) * 100)
    : 0;

  const modeLabel = (m: string | null) => {
    if (!m) return 'FFA';
    switch (m) {
      case 'ffa': return 'FFA';
      case 'duel': return 'Duel';
      case 'tdm': return 'TDM';
      case 'ranked': return 'Ranked';
      default: return m.toUpperCase();
    }
  };

  const timeAgo = (ts: number) => {
    const sec = Math.floor((Date.now() - ts) / 1000);
    if (sec < 60) return 'just now';
    if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
    if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
    return `${Math.floor(sec / 86400)}d ago`;
  };

  // ── render ────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="min-h-screen bg-[#0a0a0b] text-white flex items-center justify-center">
        <div className="font-mono text-[11px] uppercase tracking-[0.2em] text-white/40">Loading profile…</div>
      </div>
    );
  }

  if (error || !profile) {
    return (
      <div className="min-h-screen bg-[#0a0a0b] text-white flex items-center justify-center px-4">
        <div className="max-w-md text-center">
          <div className="mb-4 inline-flex items-center justify-center w-12 h-12 rounded-full bg-white/5">
            <CrosshairMark size={20} />
          </div>
          <h1 className="font-display text-2xl font-bold uppercase tracking-[0.16em] text-white/80">
            {error || 'Profile not found'}
          </h1>
          <p className="mt-2 text-sm text-white/40">
            This player may not exist, or their profile is private.
          </p>
          <Link
            to="/play"
            className="mt-6 inline-flex items-center gap-2 rounded-lg bg-cyan-400 px-5 py-2.5 text-sm font-bold uppercase tracking-[0.16em] text-zinc-950 transition hover:bg-cyan-300"
          >
            Back to lobby
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0a0a0b] text-white">
      {/* Header */}
      <header className="border-b border-white/10 bg-black/40">
        <div className="mx-auto flex max-w-4xl items-center justify-between gap-4 px-5 py-3">
          <div className="flex items-center gap-3">
            <Link
              to="/play"
              className="rounded-md p-1.5 text-white/40 transition hover:text-white/80"
              aria-label="Back to lobby"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M19 12H5M12 19l-7-7 7-7" />
              </svg>
            </Link>
            <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.3em] text-white/40">
              Elyxion
            </span>
          </div>
          <div className="flex items-center gap-2">
            {isAdmin && (
              <span className="flex items-center gap-1 rounded-full bg-amber-400/10 px-2.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-amber-300">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="#ffcf3f">
                  <path d="M2.6 8.4l4 3.3L12 4.6l5.4 7.1 4-3.3-1.7 10H4.3z" />
                </svg>
                Staff
              </span>
            )}
            {isVerified && !isAdmin && (
              <span className="flex items-center gap-1 rounded-full bg-blue-400/10 px-2.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-blue-300">
                <svg width="10" height="10" viewBox="0 0 24 24">
                  <circle cx="12" cy="12" r="11" fill="#3b9eff" />
                  <path d="M6.5 12.5l3.4 3.4L17.6 8.4" fill="none" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" />
                </svg>
                Verified
              </span>
            )}
          </div>
        </div>
      </header>

      {/* Profile hero */}
      <div className="border-b border-white/10 bg-gradient-to-b from-[#0f1419] to-[#0a0a0b]">
        <div className="mx-auto max-w-4xl px-5 py-8">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex items-center gap-4">
              {/* Level ring */}
              <div className="flex h-20 w-20 shrink-0 items-center justify-center rounded-full border-2 border-white/20 bg-black/40">
                <span className="font-display text-3xl font-extrabold uppercase text-cyan-300">
                  {profile.level}
                </span>
              </div>
              <div>
                <h1 className="font-display text-2xl font-bold uppercase tracking-[0.14em] text-white/90">
                  {displayUsername}
                </h1>
                <div className="mt-1 flex items-center gap-3 text-[11px] font-mono uppercase tracking-[0.16em] text-white/40">
                  {profile.ranked && profile.ranked.season.games > 0 && (
                    <span className="text-cyan-300">
                      Ranked #{profile.ranked.season.rank} · {profile.ranked.season.rating}
                    </span>
                  )}
                  {profile.ranked && profile.ranked.season.games === 0 && (
                    <span>Not yet ranked</span>
                  )}
                </div>
              </div>
            </div>
            <div className="flex gap-2">
              <Link
                to={`/play?spectate=${encodeURIComponent(displayUsername)}`}
                className="rounded-lg border border-white/15 bg-white/5 px-3.5 py-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-white/70 transition hover:bg-white/10"
              >
                Watch
              </Link>
            </div>
          </div>

          {/* XP bar */}
          <div className="mt-6">
            <div className="mb-1 flex items-center justify-between text-[11px] font-mono uppercase tracking-[0.16em] text-white/40">
              <span>Level {profile.level}</span>
              <span>
                {profile.xpIntoLevel.toLocaleString()} / {profile.xpForNext.toLocaleString()} XP
              </span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-white/5">
              <div
                className="h-full rounded-full bg-gradient-to-r from-cyan-500 to-cyan-300 transition-all duration-500"
                style={{ width: `${(profile.xpIntoLevel / profile.xpForNext) * 100}%` }}
              />
            </div>
          </div>

          {/* Stats grid */}
          <div className="mt-6 grid grid-cols-2 sm:grid-cols-4 gap-3">
            <StatCard label="Kills" value={profile.stats.totalKills} sub={kd} />
            <StatCard label="Wins" value={profile.stats.totalWins} sub={`${winRate}%`} />
            <StatCard label="Games" value={profile.stats.totalGames} sub={`Streak ${profile.stats.bestKillStreak}`} />
            <StatCard label="Accuracy" value={`${Math.round(accuracy)}%`} sub={`${profile.stats.headshots} HS`} />
          </div>

          {/* Credits + unlocks */}
          <div className="mt-5 flex items-center gap-4 rounded-lg border border-white/10 bg-white/[0.02] px-4 py-3">
            <div className="flex items-center gap-2">
              <span className="text-lg">🪙</span>
              <div>
                <div className="text-[10px] uppercase tracking-[0.2em] text-white/40">Credits</div>
                <div className="font-mono text-lg font-bold tabular-nums text-cyan-200">{profile.credits.toLocaleString()}</div>
              </div>
            </div>
            <div className="flex-1 border-t border-white/10" />
            <div>
              <div className="text-[10px] uppercase tracking-[0.2em] text-white/40">Unlocked</div>
              <div className="font-mono text-lg font-bold tabular-nums text-white/80">{profile.unlocked.length}</div>
            </div>
          </div>
        </div>
      </div>

      {/* Recent matches */}
      <div className="border-t border-white/10">
        <div className="mx-auto max-w-4xl px-5 py-6">
          <h2 className="mb-4 flex items-center gap-3 font-display text-[11px] font-bold uppercase tracking-[0.26em] text-cyan-200/90">
            Recent Matches
            <span className="h-px flex-1 bg-white/10" aria-hidden="true" />
          </h2>
          {recent.length === 0 ? (
            <div className="py-8 text-center text-[11px] font-mono uppercase tracking-[0.2em] text-white/30">
              No matches recorded yet
            </div>
          ) : (
            <div className="overflow-hidden rounded-lg border border-white/10">
              <div className="grid grid-cols-[2rem_1fr_3rem_3rem_3rem_3rem_6rem] gap-2 bg-white/5 px-3 py-1.5 text-[10px] uppercase tracking-[0.16em] text-white/45">
                <span>#</span>
                <span>Map / Mode</span>
                <span className="text-right">K</span>
                <span className="text-right">D</span>
                <span className="text-right">HS</span>
                <span className="text-right">Acc</span>
                <span className="text-right">Time</span>
              </div>
              {recent.map((m, i) => (
                <div
                  key={m.id}
                  className={`grid grid-cols-[2rem_1fr_3rem_3rem_3rem_3rem_6rem] gap-2 px-3 py-2 text-sm ${
                    i === 0 ? 'bg-cyan-300/5' : 'bg-white/[0.02]'
                  }`}
                >
                  <span className="tabular-nums text-white/40">{i + 1}</span>
                  <span className="truncate text-white/70">
                    {m.offline ? 'Practice' : modeLabel(m.mode)}
                  </span>
                  <span className="text-right tabular-nums text-white/70">{m.kills}</span>
                  <span className="text-right tabular-nums text-white/40">{m.deaths}</span>
                  <span className="text-right tabular-nums text-white/40">{m.headshots}</span>
                  <span className="text-right tabular-nums text-white/40">{Math.round(m.accuracy)}%</span>
                  <span className="text-right tabular-nums text-white/30">{timeAgo(m.ts)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Footer */}
      <footer className="border-t border-white/10 py-4 text-center font-mono text-[10px] uppercase tracking-[0.18em] text-white/30">
        Elyxion · One railgun. One shot. One kill.
      </footer>
    </div>
  );
}

function StatCard({ label, value, sub }: { label: string; value: string | number; sub: string }) {
  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.02] px-3 py-3 text-center">
      <div className="text-[10px] uppercase tracking-[0.2em] text-white/40">{label}</div>
      <div className="mt-1 font-mono text-xl font-extrabold tabular-nums text-white/90">{value}</div>
      <div className="mt-0.5 text-[10px] font-mono uppercase tracking-[0.14em] text-cyan-300/70">{sub}</div>
    </div>
  );
}
