// Central anti-cheat activity feed.
//
// Every defensive action the game server takes lands here as a small event, so
// admins (and scripts/agents) can see WHAT was caught and WHAT was done: a
// speed-hack teleport dropped, a rapid-fire burst rejected, a flagged aimbot's
// kills throttled, a flooder's socket closed, a chat rate-limiter timeout, a
// banned name/IP refused at the door, an admin-applied ban/unban.
//
// In-memory + bounded (like the lobby chat history) — restart clears it. Events
// carry a `count`: hot paths (a cheater's 64Hz position stream, a shot burst)
// are FOLDED, so one event per window per target/detail says "this happened N
// times" instead of flooding the ring with 500 identical lines.

export type AcKind = 'reject' | 'flag' | 'kick' | 'block' | 'timeout' | 'ban' | 'unban';

export type AcEvent = {
  id: number; // monotonically increasing sequence (across folds)
  ts: number; // ms epoch
  kind: AcKind;
  target: string; // the player name or IP involved
  detail: string; // what was caught: 'speed' | 'fire-rate' | 'shot-origin' | 'aimbot' | 'chat-rate' | 'banned-ip' | …
  actor?: string; // for ban/unban: who did it
  reason?: string; // human-readable context (rates/distances/windows)
  count: number; // occurrences folded into this event (hot paths)
};

const MAX_EVENTS = 500;
const events: AcEvent[] = [];
let seq = 0;
const DEFAULT_FOLD_MS = 5_000;

// Last-folded time per hot-path key. Bounded crudely: when it outgrows the
// ring capacity, reset (fold windows are seconds — losing a fold slot is fine).
const folds = new Map<string, number>();

export function acLog(e: Omit<AcEvent, 'id' | 'ts' | 'count'>): AcEvent {
  const ev: AcEvent = { ...e, id: ++seq, ts: Date.now(), count: 1 };
  events.push(ev);
  if (events.length > MAX_EVENTS) events.shift();
  return ev;
}

// Folded logging for hot paths: at most one event per key per `foldMs`, with
// repeats bumping `count` on the most recent matching event instead of
// appending. Returns the event when a new one was written, null on a fold.
export function acThrottledLog(
  key: string,
  e: Omit<AcEvent, 'id' | 'ts' | 'count'>,
  foldMs: number = DEFAULT_FOLD_MS,
): AcEvent | null {
  const now = Date.now();
  const last = folds.get(key) ?? 0;
  if (now - last < foldMs) {
    const lastEv = events[events.length - 1];
    if (lastEv && lastEv.kind === e.kind && lastEv.target === e.target && lastEv.detail === e.detail) {
      lastEv.count += 1;
    }
    return null;
  }
  folds.set(key, now);
  if (folds.size > MAX_EVENTS * 4) folds.clear();
  return acLog(e);
}

// Newest-first slice of the feed (optional kind filter).
export function acRecent(limit: number = 100, kind?: AcKind): AcEvent[] {
  const all = kind ? events.filter((e) => e.kind === kind) : [...events];
  return all.reverse().slice(0, limit);
}

// Totals per kind across the retained window.
export function acCounts(): Record<AcKind, number> {
  const c: Record<AcKind, number> = {
    reject: 0,
    flag: 0,
    kick: 0,
    block: 0,
    timeout: 0,
    ban: 0,
    unban: 0,
  };
  for (const e of events) c[e.kind] += e.count;
  return c;
}