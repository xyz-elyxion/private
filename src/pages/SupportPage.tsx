import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth';
import { CrosshairMark } from './Landing';

// Player-facing support. Anyone can open a ticket (guests included — the server
// stamps their IP + an optional name); logged-in players also see their own
// ticket history + the admin's replies on this page. Admins triage + reply in
// /admin → Support.

type TicketCategory = 'help' | 'report' | 'billing' | 'other';
type TicketStatus = 'open' | 'ack' | 'resolved' | 'closed';

type TicketReply = { id: number; ts: number; author: string; body: string };
type Ticket = {
  id: number;
  ts: number;
  playerName: string;
  category: TicketCategory;
  subject: string;
  body: string;
  status: TicketStatus;
  updatedAt: number;
  replies: TicketReply[];
};

const CATEGORIES: { id: TicketCategory; label: string }[] = [
  { id: 'help', label: 'Help' },
  { id: 'report', label: 'Report' },
  { id: 'billing', label: 'Billing' },
  { id: 'other', label: 'Other' },
];

const STATUS_LABEL: Record<TicketStatus, string> = {
  open: 'Open',
  ack: 'Acked',
  resolved: 'Resolved',
  closed: 'Closed',
};
const STATUS_COLOR: Record<TicketStatus, string> = {
  open: 'text-amber-300 border-amber-400/40 bg-amber-400/10',
  ack: 'text-cyan-300 border-cyan-400/40 bg-cyan-400/10',
  resolved: 'text-emerald-300 border-emerald-400/40 bg-emerald-400/10',
  closed: 'text-white/40 border-white/15 bg-white/5',
};
const CATEGORY_COLOR: Record<TicketCategory, string> = {
  help: 'text-cyan-300',
  report: 'text-rose-300',
  billing: 'text-amber-300',
  other: 'text-white/55',
};

const ERRORS: Record<string, string> = {
  bad_category: 'Pick a category.',
  bad_subject: 'Give it a short subject (3–120 characters).',
  bad_body: 'Add a bit more detail (10–4000 characters).',
  bad_id: 'That ticket doesn’t exist.',
  not_found: 'That ticket doesn’t exist.',
  forbidden: 'That ticket belongs to another account.',
  unauthorized: 'Log in to reply to your tickets.',
  rate_limited: 'You’ve sent a lot recently — try again in a bit.',
  server_error: 'Something went wrong — try again.',
  network: 'Network error — try again.',
};

// One ticket card: the original message, the full reply thread, and — for the
// ticket's own author — a reply box so the conversation is two-way instead of
// admin-only. Replying reopens a resolved/closed ticket (the server does it).
function TicketCard({ t, onReplied }: { t: Ticket; onReplied: () => void }) {
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const send = async () => {
    if (busy || draft.trim().length === 0) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`/api/support/tickets/${t.id}/replies`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ message: draft.trim() }),
      });
      const d = (await r.json().catch(() => ({}))) as { error?: string };
      if (r.ok) {
        setDraft('');
        onReplied();
      } else {
        setErr(ERRORS[d.error ?? ''] ?? 'Something went wrong.');
      }
    } catch {
      setErr(ERRORS.network);
    }
    setBusy(false);
  };

  return (
    <li className="rounded-lg border border-white/10 bg-black/30 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-baseline gap-2 text-[12px]">
          <span className="shrink-0 font-mono text-[10px] tabular-nums text-white/30">
            #{t.id}
          </span>
          <span
            className={`shrink-0 font-bold uppercase tracking-[0.12em] ${CATEGORY_COLOR[t.category]}`}
          >
            {CATEGORIES.find((c) => c.id === t.category)?.label ?? t.category}
          </span>
          <span className="truncate font-medium text-white/85">{t.subject}</span>
        </div>
        <span
          className={`shrink-0 rounded border px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-[0.12em] ${STATUS_COLOR[t.status]}`}
        >
          {STATUS_LABEL[t.status]}
        </span>
      </div>
      <p className="mt-2 whitespace-pre-wrap break-words text-[12px] leading-relaxed text-white/70">
        {t.body}
      </p>
      <div className="mt-1.5 font-mono text-[10px] text-white/35">{ago(t.ts)}</div>

      {t.replies.length > 0 && (
        <div className="mt-2 flex flex-col gap-2 border-t border-white/10 pt-2">
          {t.replies.map((r) => (
            <div key={r.id} className="rounded-md bg-cyan-400/5 px-2.5 py-2">
              <div className="flex items-baseline justify-between gap-2 font-mono text-[10px] text-cyan-300/80">
                <span className="font-bold uppercase tracking-[0.14em]">{r.author} replied</span>
                <span className="text-white/30">{ago(r.ts)}</span>
              </div>
              <p className="mt-1 whitespace-pre-wrap break-words text-[12px] leading-relaxed text-white/80">
                {r.body}
              </p>
            </div>
          ))}
        </div>
      )}

      <div className="mt-2 border-t border-white/10 pt-2">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void send();
            }
          }}
          maxLength={2000}
          rows={2}
          placeholder="Reply to the dev — more details, or let them know it’s sorted…"
          className="w-full resize-y rounded-md border border-white/15 bg-black/40 px-2.5 py-1.5 font-mono text-[12px] leading-relaxed text-white outline-none focus:border-cyan-400/60"
        />
        <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
          <span className="text-[10px] text-white/35">
            {(t.status === 'resolved' || t.status === 'closed') &&
              'Replying reopens this ticket.'}
          </span>
          {err && <span className="text-[11px] text-rose-300">{err}</span>}
          <button
            onClick={() => void send()}
            disabled={busy || draft.trim().length === 0}
            className="ml-auto rounded-md bg-cyan-400/90 px-3 py-1 text-[10px] font-bold uppercase tracking-[0.14em] text-zinc-950 transition hover:bg-cyan-300 disabled:opacity-40"
          >
            {busy ? '…' : 'Send reply'}
          </button>
        </div>
      </div>
    </li>
  );
}

function ago(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export default function SupportPage() {
  const auth = useAuth();
  const [category, setCategory] = useState<TicketCategory>('help');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sentId, setSentId] = useState<number | null>(null);
  const [tickets, setTickets] = useState<Ticket[] | null>(null);

  // The caller's own tickets — keyed to the account when logged in, or to the
  // browser's anonymous guest identity otherwise (see server/support.ts), so a
  // guest's open thread is visible back to them on the same browser.
  const loadTickets = useCallback(async () => {
    try {
      const r = await fetch('/api/support/tickets', { credentials: 'same-origin' });
      if (!r.ok) return;
      const d = (await r.json()) as { tickets: Ticket[] };
      setTickets(d.tickets);
    } catch {
      /* non-fatal — the page still works for submitting */
    }
  }, []);

  useEffect(() => {
    void loadTickets();
  }, [loadTickets]);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch('/api/support/tickets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          category,
          subject: subject.trim(),
          message: body.trim(),
          name: auth.account?.username,
        }),
      });
      const d = (await r.json().catch(() => ({}))) as { error?: string; id?: number };
      if (r.ok) {
        setSentId(d.id ?? 0);
        setSubject('');
        setBody('');
        void loadTickets(); // a logged-in submit should appear in "your tickets"
      } else {
        setErr(ERRORS[d.error ?? ''] ?? 'Something went wrong.');
      }
    } catch {
      setErr(ERRORS.network);
    }
    setBusy(false);
  };

  return (
    <div className="min-h-screen bg-[#0a0a0b] text-white">
      <div className="mx-auto w-full max-w-5xl px-5 pb-16 sm:px-8">
        {/* ── Header ─────────────────────────────────────────────────── */}
        <header className="flex w-full items-center justify-between gap-4 pt-5">
          <Link to="/" className="flex items-center gap-2.5">
            <CrosshairMark />
            <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.32em] text-white/50">
              Elyxion
            </span>
          </Link>
          <nav
            aria-label="Support navigation"
            className="flex items-center gap-4 font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-white/45"
          >
            <Link to="/play" className="transition hover:text-white/90">
              Play →
            </Link>
          </nav>
        </header>

        <main className="mt-10 grid gap-8 lg:grid-cols-[1fr_1fr] lg:items-start">
          {/* ── Open a ticket ──────────────────────────────────────────── */}
          <section className="deck-panel clip-deck p-6">
            <h1 className="flex items-center gap-3 font-display text-[11px] font-bold uppercase tracking-[0.26em] text-cyan-200/90">
              Open a ticket
              <span className="h-px flex-1 bg-white/10" aria-hidden="true" />
            </h1>

            {sentId !== null ? (
              <div className="py-8 text-center">
                <p className="text-3xl text-emerald-300">✓</p>
                <p className="mt-3 text-sm text-white/85">
                  Ticket <span className="font-mono text-cyan-200">#{sentId}</span> is in
                  — we’ll get back to you here.
                </p>
                <button
                  onClick={() => setSentId(null)}
                  className="mt-5 rounded-lg bg-cyan-400 px-5 py-2 text-xs font-bold uppercase tracking-[0.16em] text-zinc-950 transition hover:bg-cyan-300"
                >
                  Open another
                </button>
              </div>
            ) : (
              <>
                <label className="mt-5 block text-[10px] uppercase tracking-[0.24em] text-white/45">
                  Category
                </label>
                <div className="mt-1.5 flex gap-1.5">
                  {CATEGORIES.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => setCategory(c.id)}
                      className={`flex-1 rounded-lg border px-3 py-2 text-[11px] font-bold uppercase tracking-[0.14em] transition ${
                        category === c.id
                          ? 'border-cyan-400/60 bg-cyan-400/10 text-cyan-300'
                          : 'border-white/10 text-white/40 hover:text-white/70'
                      }`}
                    >
                      {c.label}
                    </button>
                  ))}
                </div>

                <label className="mt-5 block text-[10px] uppercase tracking-[0.24em] text-white/45">
                  Subject
                </label>
                <input
                  autoFocus
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && submit()}
                  maxLength={120}
                  placeholder="One-line summary, e.g. can’t join my friend’s room"
                  className="mt-1.5 w-full rounded-lg border border-white/15 bg-black/40 px-3 py-2.5 font-mono text-sm text-white outline-none focus:border-cyan-400/60"
                />

                <label className="mt-4 block text-[10px] uppercase tracking-[0.24em] text-white/45">
                  Details
                </label>
                <textarea
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  maxLength={4000}
                  rows={6}
                  placeholder="What happened, what you expected, steps to reproduce…"
                  className="mt-1.5 w-full resize-y rounded-lg border border-white/15 bg-black/40 px-3 py-2.5 font-mono text-[13px] leading-relaxed text-white outline-none focus:border-cyan-400/60"
                />
                <p className="mt-2 text-[11px] text-white/35">
                  Goes straight to the dev behind the admin panel.
                  {auth.account
                    ? ` Logged in as ${auth.account.username} — your ticket is attached to this account.`
                    : " Tickets opened here are tracked on this browser automatically — no account needed."}
                </p>
                {err && <div className="mt-3 text-[12px] text-rose-300">{err}</div>}
                <button
                  onClick={submit}
                  disabled={busy || subject.trim().length < 3 || body.trim().length < 10}
                  className="mt-5 w-full rounded-lg bg-cyan-400 px-6 py-3 text-sm font-bold uppercase tracking-[0.16em] text-zinc-950 transition hover:bg-cyan-300 disabled:opacity-50"
                >
                  {busy ? '…' : 'Submit ticket'}
                </button>
              </>
            )}
          </section>

          {/* ── Your tickets ───────────────────────────────────────────── */}
          <section className="deck-panel clip-deck p-6">
            <h2 className="flex items-center gap-3 font-display text-[11px] font-bold uppercase tracking-[0.26em] text-cyan-200/90">
              Your tickets
              <span className="h-px flex-1 bg-white/10" aria-hidden="true" />
              <button
                onClick={() => void loadTickets()}
                title="Refresh"
                aria-label="Refresh tickets"
                className="font-mono text-[11px] font-bold text-cyan-300/70 transition hover:text-cyan-200"
              >
                ⟳
              </button>
            </h2>

            {tickets === null ? (
              <p className="mt-5 font-mono text-[12px] text-white/35">Loading…</p>
            ) : tickets.length === 0 ? (
              <p className="mt-5 text-[13px] leading-relaxed text-white/45">
                No tickets from this browser yet — anything you open below shows up
                here with its status and the reply thread.
              </p>
            ) : (
              <ul className="mt-4 flex flex-col gap-3">
                {tickets.map((t) => (
                  <TicketCard key={t.id} t={t} onReplied={() => void loadTickets()} />
                ))}
              </ul>
            )}
          </section>
        </main>

        <footer className="mt-12 flex w-full flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-white/10 pt-4 font-mono text-[10px] uppercase tracking-[0.18em] text-white/30">
          <span>Tickets are private — only you and admins see them.</span>
          <Link to="/" className="transition hover:text-white/70">
            ← Back home
          </Link>
        </footer>
      </div>
    </div>
  );
}