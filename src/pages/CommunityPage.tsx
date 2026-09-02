import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth';
import { CrosshairMark } from './Landing';

// Discord-style community chat. Channels are server-defined (#general,
// #looking-for-match, #off-topic); messages persist in the DB so you can scroll
// back. Guests post as "Guest"; logged-in accounts post as their username with
// admin/verified badges. Polls every 2.5s for new messages + posts instantly.

type Channel = 'general' | 'looking-for-match' | 'off-topic';

type ChatMessage = {
  id: number;
  channel: Channel;
  ts: number;
  playerId: string;
  playerName: string;
  text: string;
  deleted: boolean;
  admin: boolean;
  verified: boolean;
};

const CHANNELS: { id: Channel; label: string; hint: string }[] = [
  { id: 'general', label: 'general', hint: 'Anything goes — strats, clips, vibes.' },
  { id: 'looking-for-match', label: 'looking-for-match', hint: 'Find players for custom lobbies.' },
  { id: 'off-topic', label: 'off-topic', hint: 'Everything that is not the railgun.' },
];

const POLL_MS = 2500;

const ERRORS: Record<string, string> = {
  bad_channel: 'Try the chat in a different channel.',
  bad_text: 'Message must be 1–500 characters.',
  profanity: 'That message got caught by the filter — keep it clean.',
  rate_limited: 'Slow down — you’re sending a lot.',
  server_error: 'Something went wrong — try again.',
  network: 'Network error — try again.',
};

function ago(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return 'now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function MessageRow({ m, isYou }: { m: ChatMessage; isYou: boolean }) {
  if (m.deleted) {
    return (
      <div className="px-2 py-1.5">
        <span className="font-mono text-[11px] italic text-white/30">[removed by staff]</span>
      </div>
    );
  }
  const nameColor = m.admin
    ? 'text-amber-300'
    : m.verified
      ? 'text-cyan-300'
      : isYou
        ? 'text-emerald-300'
        : 'text-white/85';
  return (
    <div className="flex items-start gap-2 px-2 py-1.5 transition hover:bg-white/[0.03]">
      <div className="min-w-0 flex-1">
        <span className="mr-2">
          <span className={`text-[12px] font-bold ${nameColor}`}>{m.playerName}</span>
          {m.admin && (
            <span className="ml-1 rounded bg-amber-400/15 px-1 py-px text-[9px] font-bold uppercase tracking-wider text-amber-300">
              Admin
            </span>
          )}
          {m.verified && !m.admin && (
            <span className="ml-1 text-[10px] text-cyan-400/80">✔</span>
          )}
          <span className="ml-2 font-mono text-[10px] text-white/25">{ago(m.ts)}</span>
        </span>
        <span className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-white/85">
          {m.text}
        </span>
      </div>
    </div>
  );
}

export default function CommunityPage() {
  const auth = useAuth();
  const [channel, setChannel] = useState<Channel>('general');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [draft, setDraft] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState<{ online: number; inMatch: number } | null>(null);
  const [stick, setStick] = useState(true);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);
  stickRef.current = stick;

  const load = useCallback(async (before?: number) => {
    try {
      const qs = before ? `?channel=${channel}&limit=50&before=${before}` : `?channel=${channel}&limit=50`;
      const r = await fetch(`/api/community/messages${qs}`, { credentials: 'same-origin' });
      if (!r.ok) return;
      const d = (await r.json()) as { messages: ChatMessage[] };
      if (before) {
        setMessages((prev) => [...d.messages.slice().reverse(), ...prev]);
      } else {
        setMessages(d.messages.slice().reverse()); // newest-first → oldest-first for display
      }
      setLoaded(true);
    } catch {
      /* non-fatal — poll retries */
    }
  }, [channel]);

  // Initial load + poll for new messages on this channel.
  useEffect(() => {
    setMessages([]);
    setLoaded(false);
    setStick(true);
    void load();
    const t = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(t);
  }, [channel, load]);

  // Keep the room's live population + online count fresh.
  useEffect(() => {
    const pull = () => {
      void fetch('/api/live', { credentials: 'same-origin' })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => d && setLive(d))
        .catch(() => {});
    };
    pull();
    const t = window.setInterval(pull, 5000);
    return () => window.clearInterval(t);
  }, []);

  // Stick to the newest message unless the user scrolled up to read history.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    setStick(el.scrollHeight - el.scrollTop - el.clientHeight < 60);
  };

  const send = async () => {
    const text = draft.trim();
    if (busy || !text) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch('/api/community/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ channel, text }),
      });
      const d = (await r.json().catch(() => ({}))) as { error?: string; message?: ChatMessage };
      const msg = d.message;
      if (r.ok && msg) {
        setMessages((prev) => [...prev, msg]);
        setDraft('');
        setStick(true);
      } else {
        setErr(ERRORS[d.error ?? ''] ?? 'Something went wrong.');
      }
    } catch {
      setErr(ERRORS.network);
    }
    setBusy(false);
  };

  const active = CHANNELS.find((c) => c.id === channel);
  const you = auth.account?.username;

  return (
    <div className="min-h-screen bg-[#0a0a0b] text-white">
      <div className="mx-auto flex h-screen w-full max-w-6xl flex-col px-5 pb-4 sm:px-8">
        {/* ── Header ─────────────────────────────────────────────── */}
        <header className="flex w-full shrink-0 items-center justify-between gap-4 pt-5">
          <Link to="/" className="flex items-center gap-2.5">
            <CrosshairMark />
            <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.32em] text-white/50">
              Elyxion
            </span>
          </Link>
          <div className="flex items-center gap-4 font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-white/45">
            {live && (
              <span className="inline-flex items-center gap-1.5 text-white/55">
                <span className="deck-pulse inline-block h-1.5 w-1.5 rounded-full bg-emerald-400" />
                <span className="tabular-nums text-white/90">{live.online}</span> online
                {live.inMatch > 0 && (
                  <span className="text-white/35">· {live.inMatch} in match</span>
                )}
              </span>
            )}
            <Link to="/play" className="transition hover:text-white/90">
              Play →
            </Link>
          </div>
        </header>

        {/* ── Discord-style shell: channel rail + thread ───────────── */}
        <div className="mt-4 flex min-h-0 flex-1 overflow-hidden rounded-xl border border-white/10 bg-black/40">
          {/* Channel rail */}
          <nav aria-label="Channels" className="w-48 shrink-0 border-r border-white/10 bg-black/30 p-2">
            <div className="px-2 pb-2 pt-1 font-mono text-[9px] font-bold uppercase tracking-[0.22em] text-white/30">
              Text channels
            </div>
            <ul className="flex flex-col gap-0.5">
              {CHANNELS.map((c) => (
                <li key={c.id}>
                  <button
                    onClick={() => setChannel(c.id)}
                    className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left font-mono text-[12px] transition ${
                      channel === c.id
                        ? 'bg-cyan-400/10 text-cyan-200'
                        : 'text-white/50 hover:bg-white/5 hover:text-white/80'
                    }`}
                  >
                    <span className={channel === c.id ? 'text-cyan-300' : 'text-white/30'}>#</span>
                    {c.label}
                  </button>
                </li>
              ))}
            </ul>
            <div className="mt-4 px-2 font-mono text-[9px] uppercase tracking-[0.18em] leading-relaxed text-white/25">
              {you ? `Logged in as ${you}` : 'Chatting as Guest — log in in-game to attach your name.'}
            </div>
          </nav>

          {/* Thread */}
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex shrink-0 items-baseline gap-2 border-b border-white/10 px-4 py-2.5">
              <span className="font-mono text-[13px] font-bold text-white/90">#{active?.label}</span>
              <span className="truncate font-mono text-[10px] text-white/35">{active?.hint}</span>
            </div>

            <div
              ref={scrollRef}
              onScroll={onScroll}
              className="min-h-0 flex-1 overflow-y-auto px-2 py-2"
            >
              {messages.length === 0 && loaded ? (
                <p className="px-2 py-6 text-center font-mono text-[11px] text-white/30">
                  No messages yet — say hi.
                </p>
              ) : messages.length === 0 ? (
                <p className="px-2 py-6 text-center font-mono text-[11px] text-white/30">Loading…</p>
              ) : (
                <ul>
                  {messages.map((m) => (
                    <li key={m.id}>
                      <MessageRow m={m} isYou={!!you && m.playerName === you} />
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="shrink-0 border-t border-white/10 p-3">
              <div className="flex items-end gap-2">
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      void send();
                    }
                  }}
                  rows={1}
                  maxLength={500}
                  placeholder={`#${active?.label} · message everyone`}
                  className="max-h-32 min-h-[40px] flex-1 resize-y rounded-lg border border-white/15 bg-black/40 px-3 py-2 font-mono text-[13px] text-white outline-none focus:border-cyan-400/60"
                />
                <button
                  onClick={() => void send()}
                  disabled={busy || draft.trim().length === 0}
                  className="h-[40px] shrink-0 rounded-lg bg-cyan-400 px-5 text-[11px] font-bold uppercase tracking-[0.16em] text-zinc-950 transition hover:bg-cyan-300 disabled:opacity-40"
                >
                  {busy ? '…' : 'Send'}
                </button>
              </div>
              {err && <div className="mt-1.5 text-[11px] text-rose-300">{err}</div>}
              <div className="mt-1 font-mono text-[9px] uppercase tracking-[0.18em] text-white/25">
                Enter to send · Shift+Enter for a new line · profanity is filtered
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}