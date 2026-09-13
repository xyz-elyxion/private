// /donate — the community donation page, themed like the command-deck landing
// page. Players give credits from their OWN balance; the amount is split
// EQUALLY among every player present on this page (30s presence heartbeat).
// Pure in-game economy — no real money involved.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Coins, Sparkles, ArrowLeft } from 'lucide-react';
import { apiUrl } from '../game/urls';
import { authHeaders } from '../auth';
import { CrosshairMark } from '../pages/Landing';

type DonateState = {
  recent: { name: string; credits: number; at: number }[];
  presence: { playerId: string; name: string; lastSeen: number }[];
  balance: number | null;
  min: number;
  max: number;
  loggedIn: boolean;
};

type DonateResult = { ok: boolean; reason?: string; each: number; recipients: number; balance: number };

const PRESETS = [100, 500, 1000, 5000]; // credits
const HEARTBEAT_MS = 20_000;

async function api<T>(path: string, body?: unknown): Promise<{ status: number; data: T }> {
  const res = await fetch(apiUrl(path), {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? { ...authHeaders() } : { 'Content-Type': 'application/json', ...authHeaders() },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'include',
  });
  return { status: res.status, data: (await res.json().catch(() => ({}))) as T };
}

// Command-deck utility bar — mirrors the landing page header.
function DeckHeader() {
  return (
    <header className="mx-auto flex w-full max-w-4xl items-center justify-between gap-4 px-5 pt-5 sm:px-8">
      <Link to="/" className="flex items-center gap-2.5">
        <CrosshairMark />
        <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.32em] text-white/50">
          Elyxion
        </span>
      </Link>
      <nav
        aria-label="Site links"
        className="flex items-center gap-4 font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-white/45"
      >
        <Link to="/search" className="transition hover:text-white/90">
          Players
        </Link>
        <Link to="/support" className="transition hover:text-white/90">
          Support
        </Link>
        <Link to="/" className="transition hover:text-white/90">
          Home
        </Link>
      </nav>
    </header>
  );
}

export default function Donate() {
  const [state, setState] = useState<DonateState | null>(null);
  const [selected, setSelected] = useState<number>(500);
  const [custom, setCustom] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<DonateResult | null>(null);
  const [balance, setBalance] = useState<number | null>(null);
  const leavingRef = useRef(false);

  const refresh = useCallback(async () => {
    const { data } = await api<DonateState>('/api/donate/state');
    setState(data);
    setBalance(data.balance);
  }, []);

  // Presence: heartbeat while the page is open; leave on unmount.
  useEffect(() => {
    let stopped = false;
    const beat = () => {
      void api('/api/donate/heartbeat', {}).then(() => {
        if (!stopped) void refresh();
      });
    };
    beat();
    const t = setInterval(beat, HEARTBEAT_MS);
    const onLeave = () => {
      if (leavingRef.current) return;
      leavingRef.current = true;
      void fetch(apiUrl('/api/donate/leave'), { method: 'POST', credentials: 'include' });
    };
    window.addEventListener('pagehide', onLeave);
    return () => {
      stopped = true;
      clearInterval(t);
      window.removeEventListener('pagehide', onLeave);
      onLeave();
    };
  }, [refresh]);

  const amount = custom ? Math.floor(parseFloat(custom) * 100) || 0 : selected;
  const balanceNum = balance ?? 0;

  const donate = async () => {
    setError('');
    setResult(null);
    setBusy(true);
    const { status, data } = await api<DonateResult>('/api/donate/donate', { amount });
    setBusy(false);
    if (status === 200 && data.ok) {
      setBalance(data.balance);
      setResult(data);
      void refresh();
      return;
    }
    if (data.reason === 'login_required') {
      setError('Log in to donate. Log in from the game menu first.');
    } else if (data.reason === 'insufficient') {
      setError(`Not enough credits — you have ${(data.balance ?? balanceNum).toLocaleString('en-US')}.`);
    } else {
      setError(
        `Choose an amount between ${(state?.min ?? 100).toLocaleString('en-US')} and ${(state?.max ?? 1_000_000).toLocaleString('en-US')} credits.`,
      );
    }
  };

  const fmt = (n: number) => n.toLocaleString('en-US');

  return (
    <div className="deck-bg relative h-full overflow-hidden text-white">
      <div className="deck-scan pointer-events-none fixed inset-0 z-10" aria-hidden="true" />

      <div className="relative h-full overflow-y-auto">
        <DeckHeader />

        <main className="mx-auto w-full max-w-4xl px-5 pb-14 pt-10 sm:px-8">
          <Link
            to="/play"
            className="inline-flex items-center gap-2 font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-white/45 transition hover:text-white/90"
          >
            <ArrowLeft className="h-3.5 w-3.5" /> Back to the arena
          </Link>

          <p className="deck-rise mt-8 font-mono text-[11px] uppercase tracking-[0.32em] text-cyan-300/90">
            Community pot
          </p>
          <h1
            className="deck-rise mt-3 font-display text-4xl font-bold uppercase leading-none tracking-[0.04em] sm:text-5xl"
            style={{ animationDelay: '60ms' }}
          >
            Donate <span className="text-cyan-300">credits</span>
          </h1>
          <p
            className="deck-rise mt-3 max-w-md text-[15px] leading-relaxed text-white/55"
            style={{ animationDelay: '120ms' }}
          >
            Give credits from your own balance to the community pot. The amount is
            split <span className="text-white/85">equally</span> among every player who
            is on this page at that moment — including you. Stay here to catch the
            next split.
          </p>

          {/* Balance + presence readouts */}
          <div className="deck-rise mt-8 grid gap-4 sm:grid-cols-2" style={{ animationDelay: '180ms' }}>
            <div className="clip-deck-sm deck-panel p-5">
              <p className="flex items-center gap-2 font-mono text-[10px] font-semibold uppercase tracking-[0.22em] text-white/40">
                <Coins className="h-3.5 w-3.5 text-amber-300" /> Your balance
              </p>
              <p className="mt-2 font-display text-3xl font-bold tabular-nums text-amber-300">
                {balance === null ? '—' : fmt(balance)}
                <span className="ml-2 font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-white/40">
                  credits
                </span>
              </p>
              {balance === null && (
                <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.16em] text-white/35">
                  Log in to donate
                </p>
              )}
            </div>
            <div className="clip-deck-sm deck-panel p-5">
              <p className="flex items-center gap-2 font-mono text-[10px] font-semibold uppercase tracking-[0.22em] text-white/40">
                <Sparkles className="h-3.5 w-3.5 text-emerald-300" /> On this page now
              </p>
              <p className="mt-2 font-display text-3xl font-bold tabular-nums text-emerald-300">
                {state?.presence.length ?? 0}
                <span className="ml-2 font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-white/40">
                  players
                </span>
              </p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {(state?.presence ?? []).slice(0, 12).map((p) => (
                  <span
                    key={p.playerId}
                    className="bg-white/[0.06] px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.14em] text-white/70"
                  >
                    {p.name}
                  </span>
                ))}
              </div>
            </div>
          </div>

          {/* Donation result banner */}
          {result?.ok && (result.each ?? 0) > 0 && (
            <div className="clip-deck-sm mt-6 border border-emerald-400/40 bg-emerald-400/10 p-4" role="status">
              <p className="font-display text-sm font-bold uppercase tracking-[0.16em] text-emerald-200">
                Donation sent — thank you
              </p>
              <p className="mt-1 font-mono text-[11px] uppercase tracking-[0.14em] text-emerald-200/70">
                <span className="tabular-nums">{fmt(result.each)}</span> credits to each of{' '}
                <span className="tabular-nums">{result.recipients}</span> present player
                {result.recipients === 1 ? '' : 's'} — you included.
              </p>
            </div>
          )}

          {/* Donate form */}
          <div className="clip-deck deck-panel deck-rise mt-6 p-6" style={{ animationDelay: '240ms' }}>
            {state && !state.loggedIn ? (
              <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-white/45">
                Log in (from the game menu) to donate credits.
              </p>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  {PRESETS.map((c) => (
                    <button
                      key={c}
                      onClick={() => {
                        setSelected(c);
                        setCustom('');
                      }}
                      disabled={!!balance && c > balanceNum}
                      className={`clip-deck-sm border py-4 text-center font-display font-bold uppercase tracking-[0.08em] transition disabled:cursor-not-allowed disabled:opacity-30 ${
                        !custom && selected === c
                          ? 'border-cyan-300/70 bg-cyan-300/15 text-cyan-200'
                          : 'border-white/12 bg-white/[0.03] text-white/80 hover:border-white/30'
                      }`}
                    >
                      <span className="block text-lg tabular-nums">{fmt(c)}</span>
                      <span className="mt-0.5 block font-mono text-[9px] font-semibold uppercase tracking-[0.2em] text-white/40">
                        credits
                      </span>
                    </button>
                  ))}
                </div>

                <div className="mt-5 flex items-center gap-3">
                  <label
                    htmlFor="custom-amt"
                    className="font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-white/45"
                  >
                    Custom
                  </label>
                  <input
                    id="custom-amt"
                    inputMode="numeric"
                    min="100"
                    value={custom}
                    onChange={(e) => setCustom(e.target.value.replace(/[^0-9]/g, ''))}
                    placeholder="2500"
                    className="clip-deck-sm w-36 border border-white/15 bg-white/[0.05] px-4 py-2.5 font-mono text-sm tabular-nums tracking-[0.14em] text-white placeholder:text-white/25 focus:border-cyan-300/60 focus:outline-none"
                  />
                  <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-white/35">credits</span>
                </div>

                {state && (state.presence.length ?? 0) > 0 && amount >= (state.min ?? 100) && (
                  <p className="mt-4 font-mono text-[11px] uppercase tracking-[0.16em] text-white/45">
                    Each player would receive ≈{' '}
                    <span className="tabular-nums text-amber-300">
                      {fmt(Math.floor(amount / Math.max(1, state.presence.length)))}
                    </span>{' '}
                    credits.
                  </p>
                )}

                <button
                  onClick={donate}
                  disabled={busy || amount < (state?.min ?? 100) || (!!balance && amount > balanceNum)}
                  className="clip-deck group mt-5 inline-flex w-full items-center justify-center gap-3 bg-cyan-300 py-4 font-display text-base font-bold uppercase tracking-[0.2em] text-zinc-950 transition hover:bg-cyan-200 active:translate-y-px disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {busy ? 'Transferring…' : `Donate ${fmt(amount)} credits`}
                  {!busy && <span aria-hidden="true" className="transition-transform group-hover:translate-x-1">→</span>}
                </button>

                {error && (
                  <p className="clip-deck-sm mt-4 border border-amber-400/40 bg-amber-400/10 px-4 py-2.5 font-mono text-[11px] uppercase tracking-[0.14em] text-amber-200">
                    {error}
                  </p>
                )}

                <p className="mt-4 font-mono text-[10px] leading-relaxed tracking-[0.08em] text-white/35">
                  Credits come straight from your balance — nothing real is charged. The
                  split happens instantly; with N players present, each gets the amount
                  divided by N.
                </p>
              </>
            )}
          </div>

          {/* Recent splits */}
          <div className="clip-deck deck-panel deck-rise mt-6 p-6" style={{ animationDelay: '300ms' }}>
            <p className="mb-4 flex items-center gap-3 font-mono text-[10px] font-semibold uppercase tracking-[0.26em] text-white/40">
              Recent splits
              <span className="h-px flex-1 bg-white/10" aria-hidden="true" />
            </p>
            {(state?.recent.length ?? 0) === 0 ? (
              <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-white/35">
                No donations yet — be the first.
              </p>
            ) : (
              <ul className="space-y-2">
                {(state?.recent ?? []).map((r, i) => (
                  <li
                    key={`${r.at}-${i}`}
                    className="flex items-center justify-between border-b border-white/5 pb-2 font-mono text-[11px] uppercase tracking-[0.14em] last:border-0 last:pb-0"
                  >
                    <span className="truncate text-white/80">{r.name}</span>
                    <span className="flex shrink-0 items-center gap-3">
                      <span className="tabular-nums text-amber-300">{fmt(r.credits)} cr</span>
                      <span className="tabular-nums text-white/30">
                        {new Date(r.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
