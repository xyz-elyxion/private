// /search — Roblox-style account search, themed like the command-deck landing
// page: deck grid background, angular clipped panels, display headings, mono
// micro-labels, and the cyan accent. Type a partial username, browse public
// account cards, and add/remove friends right from the results.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Search, BadgeCheck, UserPlus, UserMinus, ArrowLeft, Users } from 'lucide-react';
import { apiUrl } from '../game/urls';
import { authHeaders } from '../auth';
import { CrosshairMark } from '../pages/Landing';

type SearchHit = {
  id: string;
  username: string;
  isVerified: boolean;
  level: number;
  totalXp: number;
  totalGames: number;
};

type FriendInfo = { id: string; username: string; isVerified: boolean; level: number };
type FriendsResp = { friends: FriendInfo[]; error?: string };

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
        <Link to="/donate" className="transition hover:text-white/90">
          Donate
        </Link>
        <Link to="/" className="transition hover:text-white/90">
          Home
        </Link>
      </nav>
    </header>
  );
}

export default function PlayerSearch() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [friends, setFriends] = useState<Set<string>>(new Set());
  const [loggedIn, setLoggedIn] = useState(true);
  const [myName, setMyName] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Who am I? Used to hide the Add button on the caller's own card (no
  // self-friending) and to keep the server-side guard as pure backstop.
  useEffect(() => {
    void (async () => {
      const res = await fetch(apiUrl('/api/auth/me'), { credentials: 'include', headers: authHeaders() });
      if (!res.ok) return;
      const d = (await res.json().catch(() => ({}))) as { user?: { username?: string } | null };
      setMyName(d.user?.username ?? '');
    })();
  }, []);

  // Load the caller's friends list once so result cards show the right action.
  useEffect(() => {
    void (async () => {
      const res = await fetch(apiUrl('/api/friends'), { credentials: 'include', headers: authHeaders() });
      if (res.status === 401 || res.status === 400) {
        setLoggedIn(false);
        return;
      }
      const data = (await res.json().catch(() => ({}))) as FriendsResp;
      setFriends(new Set((data.friends ?? []).map((f) => f.id)));
    })();
  }, []);

  // Debounced live search.
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    debounceRef.current = setTimeout(() => {
      void (async () => {
        try {
          const res = await fetch(apiUrl(`/api/players?q=${encodeURIComponent(q)}`));
          const data = (await res.json().catch(() => ({}))) as { results?: SearchHit[] };
          setResults(data.results ?? []);
        } catch {
          setResults([]);
        } finally {
          setSearching(false);
        }
      })();
    }, 250);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query]);

  const toggleFriend = useCallback(
    async (hit: SearchHit) => {
      setError('');
      setBusyId(hit.id);
      const isFriend = friends.has(hit.id);
      try {
        const res = await fetch(apiUrl(isFriend ? '/api/friends/remove' : '/api/friends/add'), {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json', ...authHeaders() },
          body: JSON.stringify({ username: hit.username }),
        });
        const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
        if (res.ok && data.ok) {
          setFriends((prev) => {
            const next = new Set(prev);
            if (isFriend) next.delete(hit.id);
            else next.add(hit.id);
            return next;
          });
        } else if (data.error === 'no_account') {
          setLoggedIn(false);
          setError('Log in to manage friends.');
        } else if (data.error === 'self_friend') {
          setError('You cannot add yourself as a friend.');
        } else if (data.error === 'bad_username') {
          setError('Pick a player first.');
        } else if (data.error === 'not_found') {
          setError('That account no longer exists.');
        } else if (data.error === 'already_friends') {
          setError('You are already friends with this player.');
        } else {
          setError('Something went wrong. Try again.');
        }
      } catch {
        setError('Network error. Try again.');
      } finally {
        setBusyId(null);
      }
    },
    [friends],
  );

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
            Roster database
          </p>
          <h1
            className="deck-rise mt-3 font-display text-4xl font-bold uppercase leading-none tracking-[0.04em] sm:text-5xl"
            style={{ animationDelay: '60ms' }}
          >
            Find <span className="text-cyan-300">players</span>
          </h1>
          <p
            className="deck-rise mt-3 max-w-md text-[15px] leading-relaxed text-white/55"
            style={{ animationDelay: '120ms' }}
          >
            Search accounts by name and add friends. Friends show up in your in-game
            friends list and can invite you to parties.
          </p>

          {/* Search bar — angular clipped field, deck styling */}
          <div className="deck-rise relative mt-8" style={{ animationDelay: '180ms' }}>
            <Search className="pointer-events-none absolute left-5 top-1/2 h-5 w-5 -translate-y-1/2 text-white/35" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="SEARCH PLAYERS…"
              autoFocus
              aria-label="Search players"
              className="clip-deck-sm w-full border border-white/15 bg-white/[0.05] py-4 pl-14 pr-5 font-mono text-sm uppercase tracking-[0.18em] text-white placeholder:text-white/30 focus:border-cyan-300/60 focus:outline-none focus:ring-2 focus:ring-cyan-400/20"
            />
          </div>

          {error && (
            <p className="clip-deck-sm mt-5 border border-amber-400/40 bg-amber-400/10 px-5 py-3 font-mono text-[11px] uppercase tracking-[0.16em] text-amber-200">
              {error}
            </p>
          )}

          {/* Results */}
          <div className="deck-rise mt-8" style={{ animationDelay: '240ms' }}>
            {query.trim().length < 2 ? (
              <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-white/35">
                Type at least 2 characters to search the roster.
              </p>
            ) : searching ? (
              <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-white/35">
                Scanning roster<span className="deck-pulse">…</span>
              </p>
            ) : results.length === 0 ? (
              <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-white/35">
                No players found for “{query.trim()}”.
              </p>
            ) : (
              <ul className="space-y-2">
                {results.map((hit, i) => {
                  const isFriend = friends.has(hit.id);
                  return (
                    <li
                      key={hit.id}
                      className="clip-deck-sm deck-panel flex items-center gap-4 p-4 transition-colors hover:border-cyan-300/30"
                      style={{ animationDelay: `${280 + i * 40}ms` }}
                    >
                      {/* Avatar: first letter in an angular cyan block */}
                      <div className="clip-deck-sm flex h-11 w-11 shrink-0 items-center justify-center bg-cyan-300/15 font-display text-lg font-bold uppercase text-cyan-200">
                        {hit.username.charAt(0).toUpperCase()}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <Link
                            to={`/play/profile/${encodeURIComponent(hit.username)}`}
                            className="truncate font-display text-base font-bold uppercase tracking-[0.06em] text-white hover:text-cyan-200"
                          >
                            {hit.username}
                          </Link>
                          {hit.isVerified && <BadgeCheck className="h-4 w-4 shrink-0 text-cyan-300" />}
                        </div>
                        <p className="mt-0.5 font-mono text-[10px] uppercase tracking-[0.16em] text-white/40">
                          LVL <span className="tabular-nums text-white/70">{hit.level}</span>
                          <span className="mx-1.5 text-white/20">·</span>
                          <span className="tabular-nums">{fmt(hit.totalGames)}</span> games
                          <span className="mx-1.5 text-white/20">·</span>
                          <span className="tabular-nums">{fmt(hit.totalXp)}</span> XP
                        </p>
                      </div>
                      {loggedIn && hit.username.toLowerCase() !== myName.toLowerCase() && (
                        <button
                          onClick={() => void toggleFriend(hit)}
                          disabled={busyId === hit.id}
                          className={`clip-deck-sm shrink-0 px-4 py-2.5 font-mono text-[10px] font-bold uppercase tracking-[0.18em] transition disabled:opacity-40 ${
                            isFriend
                              ? 'bg-white/[0.06] text-white/60 hover:bg-rose-400/15 hover:text-rose-300'
                              : 'bg-cyan-300 text-zinc-950 hover:bg-cyan-200 active:translate-y-px'
                          }`}
                        >
                          {isFriend ? (
                            <span className="inline-flex items-center gap-1.5">
                              <UserMinus className="h-3.5 w-3.5" /> Friends
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1.5">
                              <UserPlus className="h-3.5 w-3.5" /> Add
                            </span>
                          )}
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
