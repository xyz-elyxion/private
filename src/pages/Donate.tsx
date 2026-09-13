// /donate — the community donation page. Players give credits from their OWN
// balance; the amount is split EQUALLY among every player present on this page
// (30s presence heartbeat). Pure in-game economy — no real money involved.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Heart, Users, Coins, Sparkles, ArrowLeft } from 'lucide-react';

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
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'include',
  });
  return { status: res.status, data: (await res.json().catch(() => ({}))) as T };
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
      void fetch('/api/donate/leave', { method: 'POST', credentials: 'include' });
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
      setError('You need to be logged in to donate. Log in from the game menu first.');
    } else if (data.reason === 'insufficient') {
      setError(`Not enough credits — you have ${(data.balance ?? balanceNum).toLocaleString('en-US')}.`);
    } else {
      setError(`Choose an amount between ${(state?.min ?? 100).toLocaleString('en-US')} and ${(state?.max ?? 1_000_000).toLocaleString('en-US')} credits.`);
    }
  };

  const fmt = (n: number) => n.toLocaleString('en-US');

  return (
    <div className="min-h-screen bg-[#0a0d13] text-slate-200">
      <div className="mx-auto max-w-3xl px-4 py-10">
        <Link
          to="/play"
          className="inline-flex items-center gap-2 text-sm text-slate-400 hover:text-slate-200 transition-colors mb-8"
        >
          <ArrowLeft className="w-4 h-4" /> Back to the arena
        </Link>

        <div className="flex items-center gap-3 mb-2">
          <div className="w-11 h-11 rounded-xl bg-rose-500/15 border border-rose-500/30 flex items-center justify-center">
            <Heart className="w-5 h-5 text-rose-400" fill="currentColor" />
          </div>
          <h1 className="text-3xl font-bold text-white tracking-tight">Donate credits</h1>
        </div>
        <p className="text-slate-400 leading-relaxed mb-8">
          Give credits from your own balance to the community pot. When you donate, the
          amount is split <span className="text-slate-200 font-medium">equally</span> among
          every player who is on this page at that moment — including you. Stay here to
          catch the next split.
        </p>

        {/* Balance + presence */}
        <div className="grid sm:grid-cols-2 gap-4 mb-8">
          <div className="rounded-xl border border-white/10 bg-white/[0.03] p-5">
            <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-slate-500 mb-2">
              <Coins className="w-3.5 h-3.5" /> Your balance
            </div>
            <div className="text-2xl font-bold text-amber-300">
              {balance === null ? '—' : fmt(balance)}{' '}
              <span className="text-sm font-normal text-slate-400">credits</span>
            </div>
            {balance === null && (
              <p className="text-xs text-slate-500 mt-1">Log in to donate.</p>
            )}
          </div>
          <div className="rounded-xl border border-white/10 bg-white/[0.03] p-5">
            <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-slate-500 mb-2">
              <Users className="w-3.5 h-3.5" /> On this page now
            </div>
            <div className="text-2xl font-bold text-emerald-300">
              {state?.presence.length ?? 0} <span className="text-sm font-normal text-slate-400">players</span>
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {(state?.presence ?? []).slice(0, 12).map((p) => (
                <span
                  key={p.playerId}
                  className="px-2 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/25 text-xs text-emerald-200"
                >
                  {p.name}
                </span>
              ))}
            </div>
          </div>
        </div>

        {/* Donation result */}
        {result?.ok && (result.each ?? 0) > 0 && (
          <div className="mb-8 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-4 flex items-start gap-3">
            <Sparkles className="w-5 h-5 text-emerald-300 shrink-0 mt-0.5" />
            <div className="text-sm">
              <p className="text-emerald-200 font-medium">Donation sent. Thank you!</p>
              <p className="text-emerald-200/70 mt-0.5">
                {fmt(result.each)} credits went to each of {result.recipients} present
                player{result.recipients === 1 ? '' : 's'} — you included.
              </p>
            </div>
          </div>
        )}

        {/* Donate form */}
        <div className="rounded-xl border border-white/10 bg-white/[0.03] p-6 mb-8">
          {state && !state.loggedIn ? (
            <p className="text-slate-400 text-sm">
              Log in (from the game menu) to donate credits.
            </p>
          ) : (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
                {PRESETS.map((c) => (
                  <button
                    key={c}
                    onClick={() => {
                      setSelected(c);
                      setCustom('');
                    }}
                    disabled={!!balance && c > balanceNum}
                    className={`rounded-lg border px-4 py-3 text-center transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${
                      !custom && selected === c
                        ? 'border-rose-400/60 bg-rose-500/15 text-white'
                        : 'border-white/10 bg-white/[0.02] text-slate-300 hover:border-white/25'
                    }`}
                  >
                    <span className="block text-lg font-bold">{fmt(c)}</span>
                    <span className="block text-xs text-slate-500 mt-0.5">credits</span>
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-3 mb-4">
                <label className="text-sm text-slate-400" htmlFor="custom-amt">
                  Custom:
                </label>
                <input
                  id="custom-amt"
                  inputMode="numeric"
                  min="100"
                  value={custom}
                  onChange={(e) => setCustom(e.target.value.replace(/[^0-9]/g, ''))}
                  placeholder="2500"
                  className="w-32 rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:border-rose-400/50 focus:outline-none"
                />
                <span className="text-xs text-slate-500">credits</span>
              </div>
              {state && (state.presence.length ?? 0) > 0 && amount >= (state.min ?? 100) && (
                <p className="text-xs text-slate-500 mb-4">
                  Each player would receive ≈{' '}
                  <span className="text-amber-300 font-medium">
                    {fmt(Math.floor(amount / Math.max(1, state.presence.length)))}
                  </span>{' '}
                  credits.
                </p>
              )}
              <button
                onClick={donate}
                disabled={busy || amount < (state?.min ?? 100) || (!!balance && amount > balanceNum)}
                className="w-full rounded-lg bg-rose-500 hover:bg-rose-400 disabled:opacity-40 disabled:cursor-not-allowed text-white font-semibold py-3 transition-colors inline-flex items-center justify-center gap-2"
              >
                <Heart className="w-4 h-4" fill="currentColor" />
                {busy ? 'Sending…' : `Donate ${fmt(amount)} credits`}
              </button>
              {error && <p className="mt-3 text-sm text-rose-300">{error}</p>}
              <p className="mt-3 text-xs text-slate-500 leading-relaxed">
                Credits come straight from your balance — nothing real is charged. The
                split happens instantly at donate time; with N players present, each gets
                the amount divided by N.
              </p>
            </>
          )}
        </div>

        {/* Recent splits */}
        <div className="rounded-xl border border-white/10 bg-white/[0.03] p-6">
          <h2 className="text-sm uppercase tracking-wider text-slate-500 mb-4">Recent splits</h2>
          {(state?.recent.length ?? 0) === 0 ? (
            <p className="text-sm text-slate-500">No donations yet — be the first.</p>
          ) : (
            <ul className="space-y-2">
              {(state?.recent ?? []).map((r, i) => (
                <li
                  key={`${r.at}-${i}`}
                  className="flex items-center justify-between text-sm border-b border-white/5 last:border-0 pb-2 last:pb-0"
                >
                  <span className="text-slate-300">{r.name}</span>
                  <span className="flex items-center gap-3">
                    <span className="text-amber-300 font-medium">{fmt(r.credits)} credits</span>
                    <span className="text-slate-600 text-xs">
                      {new Date(r.at).toLocaleString()}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
