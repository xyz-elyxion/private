// /appeal — dedicated ban-appeal page.
//
// The rule this page enforces: you can only appeal a SPECIFIC ban. The page
// loads your ban history from the server; if you have no bans there is nothing
// to appeal and the form is disabled (a message explains why). You must select
// one ban from your list — the submit button stays disabled until a ban is
// picked, and the server re-checks ownership + one-appeal-per-ban.
//
// Staff review appeals in the dashboard's Moderation tab (appeals queue).

import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Gavel, Inbox, Scale, Send } from 'lucide-react';
import { apiUrl } from '../game/urls';
import { useAuth, authHeaders } from '../auth';
import { CrosshairMark } from './Landing';

// ── API shapes (mirror server/bans.ts) ───────────────────────────────────────
type BanRow = {
  id: number;
  playerId: string;
  playerName: string;
  reason: string;
  source: string;
  issuedAt: number;
  expiresAt: number | null;
  lifted: boolean;
};
type AppealRow = {
  id: number;
  banId: number;
  message: string;
  status: 'open' | 'upheld' | 'overturned';
  handledBy: string;
  handledAt: number | null;
  createdAt: number;
  banReason: string;
};

async function api<T>(path: string, body?: unknown): Promise<{ status: number; data: T }> {
  const res = await fetch(apiUrl(path), {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? { ...authHeaders() } : { 'Content-Type': 'application/json', ...authHeaders() },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'include',
  });
  return { status: res.status, data: (await res.json().catch(() => ({}))) as T };
}

const ago = (ts: number) => {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

function DeckHeader() {
  return (
    <header className="mx-auto flex w-full max-w-3xl items-center justify-between gap-4 px-5 pt-5 sm:px-8">
      <Link to="/" className="flex items-center gap-2.5">
        <CrosshairMark />
        <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.32em] text-white/50">
          Elyxion
        </span>
      </Link>
      <Link
        to="/support"
        className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-white/45 transition hover:text-white/90"
      >
        Support
      </Link>
    </header>
  );
}

const STATUS_STYLES: Record<string, string> = {
  open: 'text-amber-300 bg-amber-400/10 ring-amber-400/30',
  upheld: 'text-rose-300 bg-rose-400/10 ring-rose-400/30',
  overturned: 'text-emerald-300 bg-emerald-400/10 ring-emerald-400/30',
};

export default function Appeal() {
  const { account: user } = useAuth();
  const [bans, setBans] = useState<BanRow[] | null>(null);
  const [appeals, setAppeals] = useState<AppealRow[] | null>(null);
  const [selectedBanId, setSelectedBanId] = useState<number | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');

  const refresh = useCallback(() => {
    void api<{ bans?: BanRow[] }>('/api/appeal/eligible').then(({ status, data }) =>
      setBans(status === 200 ? data.bans ?? [] : null),
    );
    void api<{ appeals?: AppealRow[] }>('/api/appeal/mine').then(({ data }) =>
      setAppeals(data.appeals ?? []),
    );
  }, []);
  useEffect(refresh, [refresh]);

  const selected = bans?.find((b) => b.id === selectedBanId) ?? null;
  const canSubmit = selected != null && message.trim().length >= 20 && !busy;

  const submit = async () => {
    if (!selected) return; // hard gate: a ban must be selected
    setError('');
    setBusy(true);
    const { status, data } = await api<{ ok?: boolean; error?: string }>('/api/appeal', {
      banId: selected.id,
      message: message.trim(),
    });
    setBusy(false);
    if (status === 200 && data.ok) {
      setSent(true);
      setSelectedBanId(null);
      setMessage('');
      refresh();
      return;
    }
    setError(
      status === 401 ? 'Sign in first — appeals are tied to your account.'
        : status === 400 && data.error === 'ban_required' ? 'Select the ban you are appealing.'
        : status === 400 ? 'Write a bit more (20+ characters) so mods can act on it.'
        : status === 403 ? 'That ban belongs to another account.'
        : status === 409 ? 'This ban already has an appeal — one per ban.'
        : status === 429 ? 'You already appealed recently — wait 30 minutes.'
        : 'Could not send right now — try again in a moment.',
    );
  };

  return (
    <div className="deck-bg relative h-full overflow-hidden text-white">
      <div className="deck-scan pointer-events-none fixed inset-0 z-10" aria-hidden="true" />
      <div className="relative h-full overflow-y-auto">
        <DeckHeader />
        <main className="mx-auto w-full max-w-3xl px-5 pb-14 pt-10 sm:px-8">
          <Link
            to="/play"
            className="inline-flex items-center gap-2 font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-white/45 transition hover:text-white/90"
          >
            <ArrowLeft className="h-3.5 w-3.5" /> Back to the arena
          </Link>

          <p className="deck-rise mt-8 flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.32em] text-amber-300/90">
            <Scale className="h-3.5 w-3.5" /> Ban appeals
          </p>
          <h1
            className="deck-rise mt-3 font-display text-4xl font-bold uppercase leading-none tracking-[0.04em] sm:text-5xl"
            style={{ animationDelay: '60ms' }}
          >
            Appeal a <span className="text-amber-300">ban</span>
          </h1>
          <p className="deck-rise mt-3 max-w-md text-[15px] leading-relaxed text-white/55" style={{ animationDelay: '120ms' }}>
            {user
              ? 'Select the ban you want to appeal from your history below, then tell the moderators why it should be lifted. One appeal per ban.'
              : 'Sign in with the banned account — appeals are tied to the account that received the ban.'}
          </p>

          {/* Not signed in */}
          {!user && (
            <div className="clip-deck deck-panel deck-rise mt-10 p-6 text-center" style={{ animationDelay: '180ms' }}>
              <p className="font-display text-sm font-bold uppercase tracking-[0.16em] text-white/85">
                Sign-in required
              </p>
              <p className="mt-2 text-[13px] text-white/55">
                We need to know which account was banned. Guests can't appeal.
              </p>
              <Link
                to="/auth?returnTo=/appeal"
                className="clip-deck-sm mt-4 inline-block bg-amber-400 px-5 py-2.5 font-display text-[11px] font-bold uppercase tracking-[0.16em] text-zinc-950 transition hover:bg-amber-300"
              >
                Sign in
              </Link>
            </div>
          )}

          {user && (
            <>
              {/* Eligible bans — must pick one */}
              <section className="deck-rise mt-10" style={{ animationDelay: '180ms' }} aria-label="Your bans">
                <p className="mb-3 flex items-center gap-2 font-mono text-[10px] font-semibold uppercase tracking-[0.22em] text-white/40">
                  <Gavel className="h-3.5 w-3.5 text-amber-300" /> Step 1 — select the ban to appeal
                </p>
                {!bans ? (
                  <div className="deck-panel clip-deck-sm p-5 font-mono text-[11px] uppercase tracking-[0.14em] text-white/40">
                    Loading…
                  </div>
                ) : bans.length === 0 ? (
                  <div className="deck-panel clip-deck-sm p-6 text-center">
                    <Inbox className="mx-auto h-6 w-6 text-white/25" />
                    <p className="mt-2 font-display text-[13px] font-bold uppercase tracking-[0.14em] text-white/70">
                      No bans on this account
                    </p>
                    <p className="mt-1 text-[13px] text-white/45">
                      There's nothing to appeal — you can only appeal a ban that exists on your
                      account. If you can't play, the issue may be something else; use{' '}
                      <Link to="/support" className="text-cyan-300 underline-offset-2 hover:underline">
                        support
                      </Link>{' '}
                      instead.
                    </p>
                  </div>
                ) : (
                  <div className="grid gap-2">
                    {bans.map((b) => {
                      const active = !b.lifted && (b.expiresAt == null || b.expiresAt > Date.now());
                      return (
                        <button
                          key={b.id}
                          onClick={() => setSelectedBanId(selectedBanId === b.id ? null : b.id)}
                          aria-pressed={selectedBanId === b.id}
                          className={`clip-deck-sm deck-panel flex flex-col gap-1 px-4 py-3 text-left transition ${
                            selectedBanId === b.id
                              ? 'ring-2 ring-amber-400/70'
                              : 'hover:ring-1 hover:ring-white/20'
                          }`}
                        >
                          <div className="flex flex-wrap items-center gap-2 font-mono text-[11px]">
                            <span className="font-bold uppercase tracking-[0.12em] text-white/85">
                              Ban #{b.id}
                            </span>
                            <span className={active ? 'text-rose-300' : 'text-white/35'}>
                              {b.lifted ? 'lifted' : active ? (b.expiresAt ? 'active' : 'permanent') : 'expired'}
                            </span>
                            <span className="text-white/35">·</span>
                            <span className="text-white/45">{b.source === 'anticheat' ? 'anticheat' : 'moderator'}</span>
                            <span className="text-white/35">·</span>
                            <span className="text-white/35">{ago(b.issuedAt)}</span>
                            {selectedBanId === b.id && (
                              <span className="ml-auto rounded bg-amber-400 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.1em] text-zinc-950">
                                Selected
                              </span>
                            )}
                          </div>
                          <p className="font-mono text-[12px] text-white/60">{b.reason}</p>
                        </button>
                      );
                    })}
                  </div>
                )}
              </section>

              {/* Appeal form — gated on a selected ban */}
              <section
                className="clip-deck deck-panel deck-rise mt-8 p-6"
                style={{ animationDelay: '240ms' }}
                aria-label="Appeal form"
              >
                {sent ? (
                  <div className="border border-emerald-400/40 bg-emerald-400/10 p-5 text-center" role="status">
                    <p className="font-display text-sm font-bold uppercase tracking-[0.16em] text-emerald-200">
                      Appeal received
                    </p>
                    <p className="mt-1 font-mono text-[11px] uppercase tracking-[0.14em] text-emerald-200/70">
                      A moderator will review it — you'll see the decision here.
                    </p>
                    <button
                      onClick={() => setSent(false)}
                      className="mt-4 bg-white/10 px-4 py-2 font-display text-[11px] font-bold uppercase tracking-[0.14em] text-white transition hover:bg-white/20"
                    >
                      Appeal another ban
                    </button>
                  </div>
                ) : !selected ? (
                  <p className="py-4 text-center font-mono text-[11px] uppercase tracking-[0.14em] text-white/35">
                    {bans && bans.length > 0
                      ? 'Step 2 — pick a ban above to unlock the appeal form'
                      : 'Appeal a specific ban to unlock this form'}
                  </p>
                ) : (
                  <>
                    <p className="flex items-center gap-2 font-mono text-[10px] font-semibold uppercase tracking-[0.22em] text-white/40">
                      <Send className="h-3.5 w-3.5 text-amber-300" /> Appealing ban #{selected.id}
                    </p>
                    <p className="mt-2 font-mono text-[12px] text-white/55">{selected.reason}</p>
                    <textarea
                      value={message}
                      onChange={(e) => setMessage(e.target.value)}
                      maxLength={4000}
                      rows={6}
                      autoFocus
                      placeholder="Why should this ban be lifted? Include anything a moderator would need — dates, what happened, what you'll do differently."
                      className="mt-3 w-full resize-y bg-black/40 px-3 py-2.5 font-mono text-[13px] leading-relaxed text-white/90 outline-none ring-1 ring-white/10 transition focus:ring-amber-400/50"
                    />
                    {error && (
                      <p role="alert" className="mt-2 font-mono text-[11px] uppercase tracking-[0.14em] text-rose-300">
                        {error}
                      </p>
                    )}
                    <div className="mt-4 flex items-center justify-between gap-4">
                      <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-white/30">
                        {message.length}/4000 · one appeal per ban
                      </p>
                      <button
                        onClick={submit}
                        disabled={!canSubmit}
                        className="clip-deck-sm shrink-0 bg-amber-400 px-5 py-2.5 font-display text-[11px] font-bold uppercase tracking-[0.16em] text-zinc-950 transition hover:bg-amber-300 disabled:cursor-not-allowed disabled:bg-white/12 disabled:text-white/40"
                      >
                        {busy ? 'Sending…' : 'Submit appeal'}
                      </button>
                    </div>
                  </>
                )}
              </section>

              {/* Past appeals */}
              {appeals && appeals.length > 0 && (
                <section className="deck-rise mt-8" style={{ animationDelay: '300ms' }} aria-label="Your past appeals">
                  <p className="mb-3 font-mono text-[10px] font-semibold uppercase tracking-[0.22em] text-white/40">
                    Your appeals
                  </p>
                  <div className="grid gap-2">
                    {appeals.map((a) => (
                      <div key={a.id} className="deck-panel clip-deck-sm flex items-center gap-3 px-4 py-3">
                        <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.12em] ring-1 ${STATUS_STYLES[a.status] ?? STATUS_STYLES.open}`}>
                          {a.status === 'open' ? 'under review' : a.status}
                        </span>
                        <span className="font-mono text-[11px] text-white/45">ban #{a.banId}</span>
                        <span className="truncate font-mono text-[12px] text-white/55">{a.banReason || a.message}</span>
                        <span className="ml-auto shrink-0 font-mono text-[10px] text-white/30">{ago(a.createdAt)}</span>
                      </div>
                    ))}
                  </div>
                </section>
              )}
            </>
          )}
        </main>
      </div>
    </div>
  );
}
