// /search — Roblox-style account search: type a (partial) username, browse
// public account cards, and add/remove friends right from the results. Uses
// the same friend model as the in-game friends list (server-validated).
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Search, BadgeCheck, UserPlus, UserMinus, ArrowLeft, Users } from 'lucide-react';
import { apiUrl } from '../game/urls';
import { authHeaders } from '../auth';

type SearchHit = {
  id: string;
  username: string;
  isVerified: boolean;
  level: number;
  totalXp: number;
  totalGames: number;
};

type FriendInfo = {
  id: string;
  username: string;
  isVerified: boolean;
  level: number;
};

type FriendsResp = { friends: FriendInfo[]; error?: string };

export default function PlayerSearch() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [friends, setFriends] = useState<Set<string>>(new Set());
  const [loggedIn, setLoggedIn] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load the caller's friends list once so result cards show the right action.
  useEffect(() => {
    void (async () => {
      const res = await fetch(apiUrl('/api/stats/friends'), { credentials: 'include', headers: authHeaders() });
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
          const res = await fetch(apiUrl(`/api/stats/players?q=${encodeURIComponent(q)}`));
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
        const res = await fetch(apiUrl(isFriend ? '/api/stats/friends/remove' : '/api/stats/friends/add'), {
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
    <div className="min-h-screen bg-[#0a0d13] text-slate-200">
      <div className="mx-auto max-w-2xl px-4 py-10">
        <Link
          to="/play"
          className="inline-flex items-center gap-2 text-sm text-slate-400 hover:text-slate-200 transition-colors mb-8"
        >
          <ArrowLeft className="w-4 h-4" /> Back to the arena
        </Link>

        <div className="flex items-center gap-3 mb-2">
          <div className="w-11 h-11 rounded-xl bg-sky-500/15 border border-sky-500/30 flex items-center justify-center">
            <Users className="w-5 h-5 text-sky-400" />
          </div>
          <h1 className="text-3xl font-bold text-white tracking-tight">Find players</h1>
        </div>
        <p className="text-slate-400 mb-6">
          Search accounts by name and add friends. Friends show up in your in-game
          friends list and can invite you to parties.
        </p>

        {/* Search bar */}
        <div className="relative mb-8">
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-500" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search players…"
            autoFocus
            aria-label="Search players"
            className="w-full rounded-xl border border-white/10 bg-white/[0.04] pl-12 pr-4 py-3.5 text-base text-white placeholder:text-slate-500 focus:border-sky-400/50 focus:outline-none focus:ring-2 focus:ring-sky-500/20 transition"
          />
        </div>

        {error && <p className="mb-4 text-sm text-rose-300">{error}</p>}

        {/* Results */}
        {query.trim().length < 2 ? (
          <p className="text-sm text-slate-500">Type at least 2 characters to search.</p>
        ) : searching ? (
          <p className="text-sm text-slate-500">Searching…</p>
        ) : results.length === 0 ? (
          <p className="text-sm text-slate-500">No players found for “{query.trim()}”.</p>
        ) : (
          <ul className="space-y-2">
            {results.map((hit) => {
              const isFriend = friends.has(hit.id);
              return (
                <li
                  key={hit.id}
                  className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.03] p-4 hover:border-white/20 transition-colors"
                >
                  {/* Avatar block: first letter, like the workspace switcher */}
                  <div className="w-11 h-11 rounded-[10px] bg-sky-500/20 border border-sky-500/30 flex items-center justify-center font-semibold text-sky-200 text-lg shrink-0">
                    {hit.username.charAt(0).toUpperCase()}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <Link
                        to={`/play/profile/${encodeURIComponent(hit.username)}`}
                        className="font-medium text-white hover:underline truncate"
                      >
                        {hit.username}
                      </Link>
                      {hit.isVerified && <BadgeCheck className="w-4 h-4 text-sky-400 shrink-0" />}
                    </div>
                    <p className="text-xs text-slate-500 mt-0.5">
                      Level {hit.level} · {fmt(hit.totalGames)} games · {fmt(hit.totalXp)} XP
                    </p>
                  </div>
                  {loggedIn && (
                    <button
                      onClick={() => void toggleFriend(hit)}
                      disabled={busyId === hit.id}
                      className={`shrink-0 inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold transition-colors disabled:opacity-40 ${
                        isFriend
                          ? 'bg-white/[0.06] text-slate-300 hover:bg-rose-500/15 hover:text-rose-300'
                          : 'bg-sky-500 hover:bg-sky-400 text-white'
                      }`}
                    >
                      {isFriend ? (
                        <>
                          <UserMinus className="w-3.5 h-3.5" /> Friends
                        </>
                      ) : (
                        <>
                          <UserPlus className="w-3.5 h-3.5" /> Add
                        </>
                      )}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
