import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth, LoginModal } from '../auth';
import { MAPS } from '../game/map';
import { CrosshairMark } from './Landing';

// "My replays": every finished match (any gamemode) uploads a temporary,
// ~24h-live recording to the account. This page lists the account's still-live
// ones so a run doesn't vanish the moment you leave the results screen — watch
// it again, copy the share link, or delete it early. Guests upload anonymously,
// so the list needs a logged-in account.

type MyReplay = {
  code: string;
  mapId: string;
  mode: string;
  won: boolean;
  durationMs: number;
  runner: string;
  createdAt: number;
  expiresAt: number;
  kills: number;
  deaths: number;
  headshots: number;
  url: string;
};

const MODE_LABEL: Record<string, string> = {
  ffa: 'FFA',
  duel: 'Duel',
  tdm: 'TDM',
  ranked: 'Ranked',
  solo: 'Solo',
  bots: 'Vs Bots',
  challenge: 'Challenge',
  training: 'Training',
};
const MODE_COLOR: Record<string, string> = {
  ffa: 'border-cyan-400/40 text-cyan-300',
  duel: 'border-violet-400/40 text-violet-300',
  tdm: 'border-emerald-400/40 text-emerald-300',
  ranked: 'border-amber-400/40 text-amber-300',
  solo: 'border-white/20 text-white/70',
  bots: 'border-sky-400/40 text-sky-300',
  challenge: 'border-amber-400/40 text-amber-300',
  training: 'border-white/15 text-zinc-400',
};
const modeLabel = (mode: string): string => MODE_LABEL[mode] ?? (mode ? mode.toUpperCase() : 'Match');
const modeColor = (mode: string): string => MODE_COLOR[mode] ?? 'border-white/20 text-white/70';

const fmtClock = (ms: number): string => {
  if (!Number.isFinite(ms) || ms <= 0) return '0:00';
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}:${String(s % 60).padStart(2, '0')}` : `0:${String(s).padStart(2, '0')}`;
};
const ago = (ts: number, now: number): string => {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
};
const left = (until: number, now: number): string => {
  const s = Math.max(0, Math.ceil((until - now) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
};

export default function MyReplaysPage() {
  const auth = useAuth();
  const [replays, setReplays] = useState<MyReplay[] | null>(null);
  const [showLogin, setShowLogin] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // Keep the "expires in …" labels fresh.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  const load = useCallback(async () => {
    setReplays(null);
    try {
      const r = await fetch('/api/replays/mine', { credentials: 'same-origin' });
      if (!r.ok) {
        setReplays([]);
        return;
      }
      const d = (await r.json()) as { replays?: MyReplay[] };
      setReplays(d.replays ?? []);
    } catch {
      setReplays([]);
    }
  }, []);

  useEffect(() => {
    if (auth.ready && auth.account) void load();
  }, [auth.ready, auth.account, load]);

  // Dismiss the result line after a few seconds.
  useEffect(() => {
    if (!msg) return;
    const t = setTimeout(() => setMsg(null), 4000);
    return () => clearTimeout(t);
  }, [msg]);

  const del = async (code: string) => {
    setDeleting(code);
    try {
      const r = await fetch(`/api/replays/${encodeURIComponent(code)}`, {
        method: 'DELETE',
        credentials: 'same-origin',
      });
      if (r.ok) {
        setReplays((rs) => (rs ?? []).filter((x) => x.code !== code));
        setMsg('Replay deleted.');
      } else {
        setMsg("Couldn't delete that replay.");
      }
    } catch {
      setMsg("Couldn't delete that replay.");
    }
    setDeleting(null);
  };

  const copyLink = async (code: string, url: string) => {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}${url}`);
      setCopied(code);
    } catch {
      /* clipboard unavailable */
    }
    window.setTimeout(() => setCopied(null), 1800);
  };

  const loggedOut = auth.ready && !auth.account;

  return (
    <div className="min-h-screen bg-[#0a0a0b] text-white">
      <div className="mx-auto w-full max-w-5xl px-5 pb-16 sm:px-8">
        {/* ── Header ─────────────────────────────────────────────────── */}
        <header className="flex w-full flex-wrap items-center justify-between gap-4 pt-5">
          <Link to="/" className="flex items-center gap-2.5">
            <CrosshairMark />
            <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.32em] text-white/50">
              My Replays
            </span>
          </Link>
          <nav
            aria-label="Replays navigation"
            className="flex items-center gap-4 font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-white/45"
          >
            <span className="text-white/30">temporary · ~24h each</span>
            <Link to="/play" className="transition hover:text-white/90">
              Play →
            </Link>
          </nav>
        </header>

        {msg && (
          <div className="mt-6 rounded-md border border-cyan-400/30 bg-cyan-400/10 px-3 py-2 font-mono text-[11px] text-cyan-100">
            {msg}
          </div>
        )}

        {!auth.ready ? (
          <main className="mt-24 flex flex-col items-center gap-3">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-cyan-300/30 border-t-cyan-300" />
            <p className="font-mono text-[12px] uppercase tracking-[0.2em] text-white/55">Loading replays</p>
          </main>
        ) : loggedOut ? (
          <main className="mx-auto mt-24 max-w-md text-center">
            <p className="font-display text-3xl font-bold text-white/85">Log in to see your replays</p>
            <p className="mt-3 text-[13px] leading-relaxed text-white/45">
              Replays from your matches (any gamemode) are kept for ~24 hours so
              you can rewatch or share them. They're tied to your account — log
              in or register to claim them.
            </p>
            <button
              onClick={() => setShowLogin(true)}
              className="mt-6 rounded-lg bg-cyan-400 px-6 py-2.5 text-sm font-bold uppercase tracking-[0.16em] text-zinc-950 transition hover:bg-cyan-300"
            >
              Log in / Register
            </button>
          </main>
        ) : replays === null ? (
          <main className="mt-24 flex flex-col items-center gap-3">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-cyan-300/30 border-t-cyan-300" />
            <p className="font-mono text-[12px] uppercase tracking-[0.2em] text-white/55">Loading replays</p>
          </main>
        ) : replays.length === 0 ? (
          <main className="mx-auto mt-24 max-w-md text-center">
            <p className="font-display text-3xl font-bold text-white/85">No replays yet</p>
            <p className="mt-3 text-[13px] leading-relaxed text-white/45">
              Finish a match — solo, vs bots, online, ranked, the weekly
              challenge — and its recording lands here for ~24 hours.
            </p>
            <Link
              to="/play"
              className="mt-6 inline-block rounded-lg bg-cyan-400 px-6 py-2.5 text-sm font-bold uppercase tracking-[0.16em] text-zinc-950 transition hover:bg-cyan-300"
            >
              Play a match
            </Link>
          </main>
        ) : (
          <main className="mt-10">
            <h1 className="flex items-center gap-3 font-display text-[11px] font-bold uppercase tracking-[0.26em] text-cyan-200/90">
              Your replays
              <span className="h-px flex-1 bg-white/10" aria-hidden="true" />
            </h1>
            <ul className="mt-4 space-y-2">
              {replays.map((r) => (
                <li
                  key={r.code}
                  className="deck-panel clip-deck flex flex-wrap items-center gap-x-4 gap-y-2 p-4"
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={`rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.14em] ${modeColor(r.mode)}`}
                    >
                      {modeLabel(r.mode)}
                    </span>
                    <span
                      className={`rounded px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.14em] ${
                        r.won
                          ? 'border border-emerald-400/40 text-emerald-300'
                          : 'border border-rose-400/40 text-rose-300'
                      }`}
                    >
                      {r.won ? 'Win' : 'Loss'}
                    </span>
                  </div>
                  <div className="min-w-0 flex-1 font-mono text-[12px]">
                    <span className="text-white/85">
                      {(MAPS.find((m) => m.id === r.mapId)?.label ?? r.mapId) || 'Unknown map'}
                    </span>
                    <span className="text-white/40">
                      {' '}
                      · {r.kills}k / {r.deaths}d
                      {r.headshots > 0 && <span className="text-amber-300/80"> · {r.headshots} hs</span>}
                      {' · '}
                      {fmtClock(r.durationMs)}
                    </span>
                  </div>
                  <div className="font-mono text-[11px] text-white/40">
                    {ago(r.createdAt, now)} · expires in {left(r.expiresAt, now)}
                  </div>
                  <div className="flex items-center gap-2">
                    <Link
                      to={r.url}
                      className="rounded bg-cyan-400 px-3 py-1.5 font-mono text-[11px] font-bold uppercase tracking-[0.12em] text-zinc-950 transition hover:bg-cyan-300"
                    >
                      Watch
                    </Link>
                    <Link
                      to={`${r.url}/edit`}
                      title='Open the replay editor'
                      className="rounded border border-cyan-400/40 bg-cyan-400/10 px-3 py-1.5 font-mono text-[11px] font-semibold uppercase tracking-[0.12em] text-cyan-200 transition hover:bg-cyan-400/20"
                    >
                      Edit
                    </Link>
                    <button
                      onClick={() => void copyLink(r.code, r.url)}
                      className="rounded border border-white/15 bg-white/5 px-3 py-1.5 font-mono text-[11px] font-semibold uppercase tracking-[0.12em] text-white transition hover:bg-white/10"
                    >
                      {copied === r.code ? 'Copied ✓' : 'Copy link'}
                    </button>
                    <button
                      onClick={() => void del(r.code)}
                      disabled={deleting === r.code}
                      title='Delete this replay (stops the share link)'
                      className="rounded border border-rose-500/40 px-3 py-1.5 font-mono text-[11px] font-semibold uppercase tracking-[0.12em] text-rose-300 transition hover:border-rose-400/70 hover:text-rose-200 disabled:opacity-40"
                    >
                      {deleting === r.code ? '…' : 'Delete'}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </main>
        )}
      </div>

      {showLogin && <LoginModal auth={auth} onClose={() => setShowLogin(false)} />}
    </div>
  );
}