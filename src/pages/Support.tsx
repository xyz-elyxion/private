// /support — player support page, themed like the command-deck landing/donate
// pages. Answers common questions (bans, accounts, gameplay) and offers a
// support ticket form that POSTs to the same /api/feedback endpoint the
// in-game FeedbackModal uses — admins see it in the same queue.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, LifeBuoy, ShieldAlert, UserCog, Gamepad2, Send } from 'lucide-react';
import { apiUrl } from '../game/urls';
import { authHeaders } from '../auth';
import { CrosshairMark } from '../pages/Landing';

type FeedbackType = 'bug' | 'feature' | 'general';

const RATE_NOTE = 'A few tickets per 10 minutes, please.';

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
        <Link to="/docs" className="transition hover:text-white/90">
          Docs
        </Link>
        <Link to="/" className="transition hover:text-white/90">
          Home
        </Link>
      </nav>
    </header>
  );
}

type Faq = { q: string; a: React.ReactNode };

const FAQS: Faq[] = [
  {
    q: 'Why was I banned?',
    a: (
      <>
        Bans are issued by moderators or automatically when our server-side anticheat
        detects impossible gameplay (fire-rate, movement, shot-origin, or message-flood
        violations). The ban reason is shown when you try to play. Bans expire on their
        own — most anticheat bans last <span className="text-white/85">24 hours</span>.
        If you believe it was a mistake, send a ticket below with your username.
      </>
    ),
  },
  {
    q: 'I lost my password',
    a: (
      <>
        Use the <span className="text-white/85">Forgot password</span> link on the login
        screen in-game. Recovery only works if you added an email to your account. No
        email attached? Send a ticket below from the same device you usually play on and
        include your username.
      </>
    ),
  },
  {
    q: 'Someone is cheating / being abusive',
    a: (
      <>
        Report them in-game (player card → report) or send a ticket below with their
        exact username and what happened. Our anticheat logs every match server-side, so
        reports are checked against real evidence, not guesses.
      </>
    ),
  },
  {
    q: 'Lag, disconnects, or "Reconnecting…"',
    a: (
      <>
        The game needs a stable connection to the match server; brief drops recover
        automatically and your slot is held for about a minute. If it keeps happening,
        try a wired connection or a different network, and avoid heavy downloads while
        playing.
      </>
    ),
  },
  {
    q: 'Progress, credits, or cosmetics missing',
    a: (
      <>
        Progress is tied to your account — guests lose everything between sessions. If
        you were logged in and something is missing, send a ticket with your username and
        what you had before. Cosmetics are cosmetic-only and never affect gameplay.
      </>
    ),
  },
  {
    q: 'Playing on portals (CrazyGames etc.)',
    a: (
      <>
        The game works the same on gaming portals, but those platforms control ads and
        their own account linking. Progress made as a guest on a portal may not transfer
        to a self-hosted account.
      </>
    ),
  },
];

function FaqItem({ q, a }: Faq) {
  const [open, setOpen] = useState(false);
  return (
    <div className="clip-deck-sm deck-panel">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 px-5 py-4 text-left"
      >
        <span className="font-display text-[13px] font-bold uppercase tracking-[0.12em] text-white/85">
          {q}
        </span>
        <span
          className={`font-mono text-sm text-cyan-300 transition-transform ${open ? 'rotate-45' : ''}`}
          aria-hidden
        >
          +
        </span>
      </button>
      {open && (
        <p className="border-t border-white/[0.07] px-5 py-4 text-[13px] leading-relaxed text-white/60">
          {a}
        </p>
      )}
    </div>
  );
}

const CATEGORIES: { id: FeedbackType; label: string; icon: typeof Gamepad2 }[] = [
  { id: 'bug', label: 'Bug / broken thing', icon: ShieldAlert },
  { id: 'general', label: 'Ban appeal / account', icon: UserCog },
  { id: 'feature', label: 'Suggestion', icon: Gamepad2 },
];

export default function Support() {
  const [category, setCategory] = useState<FeedbackType>('bug');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    setError('');
    setBusy(true);
    const { status, data } = await api<{ ok?: boolean; error?: string; id?: number }>('/api/feedback', {
      type: category,
      title,
      body,
      name,
    });
    setBusy(false);
    if (status === 200 && data.ok) {
      setSent(true);
      return;
    }
    setError(
      status === 429
        ? `You're sending tickets too fast — ${RATE_NOTE}`
        : status === 400
          ? 'Title needs 3+ characters and the message 10+ characters.'
          : 'Could not send right now — try again in a moment.',
    );
  };

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
            Help desk
          </p>
          <h1
            className="deck-rise mt-3 font-display text-4xl font-bold uppercase leading-none tracking-[0.04em] sm:text-5xl"
            style={{ animationDelay: '60ms' }}
          >
            Support <span className="text-cyan-300">&amp; appeals</span>
          </h1>
          <p
            className="deck-rise mt-3 max-w-md text-[15px] leading-relaxed text-white/55"
            style={{ animationDelay: '120ms' }}
          >
            Answers to the most common questions, and a direct line to the moderators for
            ban appeals, account trouble, and bug reports.
          </p>

          {/* FAQ */}
          <section className="deck-rise mt-10" style={{ animationDelay: '180ms' }} aria-label="Frequently asked questions">
            <p className="mb-3 flex items-center gap-2 font-mono text-[10px] font-semibold uppercase tracking-[0.22em] text-white/40">
              <LifeBuoy className="h-3.5 w-3.5 text-cyan-300" /> Common questions
            </p>
            <div className="grid gap-3">
              {FAQS.map((f) => (
                <FaqItem key={f.q} {...f} />
              ))}
            </div>
          </section>

          {/* Ticket form */}
          <section
            className="clip-deck deck-panel deck-rise mt-10 p-6"
            style={{ animationDelay: '240ms' }}
            aria-label="Support ticket"
          >
            {sent ? (
              <div className="border border-emerald-400/40 bg-emerald-400/10 p-5 text-center" role="status">
                <p className="font-display text-sm font-bold uppercase tracking-[0.16em] text-emerald-200">
                  Ticket received
                </p>
                <p className="mt-1 font-mono text-[11px] uppercase tracking-[0.14em] text-emerald-200/70">
                  A moderator will review it — check back in-game for updates.
                </p>
                <button
                  onClick={() => {
                    setSent(false);
                    setTitle('');
                    setBody('');
                  }}
                  className="mt-4 bg-white/10 px-4 py-2 font-display text-[11px] font-bold uppercase tracking-[0.14em] text-white transition hover:bg-white/20"
                >
                  Send another
                </button>
              </div>
            ) : (
              <>
                <p className="flex items-center gap-2 font-mono text-[10px] font-semibold uppercase tracking-[0.22em] text-white/40">
                  <Send className="h-3.5 w-3.5 text-cyan-300" /> Open a ticket
                </p>

                <div className="mt-4 grid gap-2 sm:grid-cols-3">
                  {CATEGORIES.map(({ id, label, icon: Icon }) => (
                    <button
                      key={id}
                      onClick={() => setCategory(id)}
                      aria-pressed={category === id}
                      className={`clip-deck-sm flex items-center gap-2 px-3 py-2.5 text-left font-display text-[11px] font-bold uppercase tracking-[0.12em] transition ${
                        category === id
                          ? 'bg-cyan-400 text-zinc-950'
                          : 'bg-white/[0.06] text-white/70 hover:bg-white/[0.12]'
                      }`}
                    >
                      <Icon className="h-3.5 w-3.5 shrink-0" />
                      {label}
                    </button>
                  ))}
                </div>

                <input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  maxLength={120}
                  placeholder="Subject — e.g. “Ban appeal for <username>”"
                  className="mt-4 w-full bg-black/40 px-3 py-2.5 font-mono text-[13px] text-white/90 outline-none ring-1 ring-white/10 transition focus:ring-cyan-400/50"
                />
                {!title && (
                  <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.14em] text-white/30">
                    Logged in? Your username is attached automatically.
                  </p>
                )}
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={32}
                  placeholder="Your in-game username (if different)"
                  className="mt-2 w-full bg-black/40 px-3 py-2.5 font-mono text-[13px] text-white/90 outline-none ring-1 ring-white/10 transition focus:ring-cyan-400/50"
                />
                <textarea
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  maxLength={4000}
                  rows={6}
                  placeholder="What happened? Include usernames, dates, and anything a moderator would need."
                  className="mt-2 w-full resize-y bg-black/40 px-3 py-2.5 font-mono text-[13px] leading-relaxed text-white/90 outline-none ring-1 ring-white/10 transition focus:ring-cyan-400/50"
                />

                {error && (
                  <p role="alert" className="mt-2 font-mono text-[11px] uppercase tracking-[0.14em] text-rose-300">
                    {error}
                  </p>
                )}

                <div className="mt-4 flex items-center justify-between gap-4">
                  <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-white/30">
                    {body.length}/4000 · {RATE_NOTE}
                  </p>
                  <button
                    onClick={submit}
                    disabled={busy || title.trim().length < 3 || body.trim().length < 10}
                    className="clip-deck-sm shrink-0 bg-cyan-400 px-5 py-2.5 font-display text-[11px] font-bold uppercase tracking-[0.16em] text-zinc-950 transition hover:bg-cyan-300 disabled:cursor-not-allowed disabled:bg-white/12 disabled:text-white/40"
                  >
                    {busy ? 'Sending…' : 'Send ticket'}
                  </button>
                </div>
              </>
            )}
          </section>
        </main>
      </div>
    </div>
  );
}
