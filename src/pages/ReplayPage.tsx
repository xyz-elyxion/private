import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { decodeReplay, type ReplayData } from '../game/replay-codec';
import { ReplayViewer, type ReplayViewerState } from '../game/replay-viewer';
import { MAPS } from '../game/map';
import { CrosshairMark } from './Landing';

// Shared replay page: any /replay/<code> link (from the match-end \"Share
// replay\" button) opens a competition-style recap — broadcast header, final
// standings, the full kill-by-kill action feed, and the replay itself. The
// share is TEMPORARY: the server keeps the recording ~24h, then it's gone.
//
// Everything (standings, stats, feed) is derived from the recording via the
// server's decoded summary + the client's own decode — a visitor can't be shown
// stats a tampered page claims; they come from the same bytes that play back.

type ReplayMeta = {
  code: string;
  mapId: string;
  won: boolean;
  durationMs: number;
  runner: string;
  createdAt: number;
  expiresAt: number;
  stats: {
    runner: { kills: number; deaths: number; headshots: number; shots: number };
    players: { name: string; kills: number; deaths: number; headshots: number }[];
  };
};

const SPEEDS = [0.5, 1, 2] as const;

function fmtTime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0:00.0';
  const s = ms / 1000;
  const m = Math.floor(s / 60);
  const rem = (s - m * 60).toFixed(1);
  return m > 0 ? `${m}:${rem.padStart(4, '0')}` : `${rem}s`;
}

type MetaError = { kind: 'gone' | 'server' } | null;

export default function ReplayPage() {
  const { code = '' } = useParams<{ code: string }>();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewerRef = useRef<ReplayViewer | null>(null);
  const [meta, setMeta] = useState<ReplayMeta | null>(null);
  const [data, setData] = useState<ReplayData | null>(null);
  const [state, setState] = useState<ReplayViewerState | null>(null);
  const [error, setError] = useState<MetaError>(null);
  const [copied, setCopied] = useState(false);

  // Load meta + blob in parallel; decode + mount the viewer when both land.
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      try {
        const [metaRes, blobRes] = await Promise.all([
          fetch(`/api/replays/${encodeURIComponent(code)}/meta`, { credentials: 'same-origin' }),
          fetch(`/api/replays/${encodeURIComponent(code)}`, { credentials: 'same-origin' }),
        ]);
        if (!metaRes.ok || !blobRes.ok) {
          if (!cancelled) setError(metaRes.status === 404 || blobRes.status === 404 ? { kind: 'gone' } : { kind: 'server' });
          return;
        }
        const metaJson = (await metaRes.json()) as { meta: ReplayMeta };
        let decoded: ReplayData;
        try {
          decoded = decodeReplay(await blobRes.arrayBuffer());
        } catch {
          if (!cancelled) setError({ kind: 'server' });
          return;
        }
        if (cancelled) return;
        setMeta(metaJson.meta);
        setData(decoded);
        setError(null);
      } catch {
        if (!cancelled) setError({ kind: 'server' });
      }
    };
    void run();
    return () => {
      cancelled = true;
      if (viewerRef.current) {
        viewerRef.current.dispose();
        viewerRef.current = null;
      }
    };
  }, [code]);

  // Mount the 3D viewer once the recording is decoded.
  useEffect(() => {
    if (!data || !canvasRef.current) return;
    const viewer = new ReplayViewer(
      canvasRef.current,
      data,
      (s) => setState(s),
      { fov: 90, resolutionScale: 1, lowSpec: false },
    );
    viewerRef.current = viewer;
    void viewer.start(); // starts paused on the first frame
    return () => {
      viewer.dispose();
      viewerRef.current = null;
    };
  }, [data]);

  const seekTo = (t: number) => viewerRef.current?.seek(t);
  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
    } catch {
      setCopied(true); // best-effort — flash feedback either way
    }
    window.setTimeout(() => setCopied(false), 1800);
  };

  const t = state?.t ?? 0;
  const duration = state?.duration ?? (data ? data.durationMs / 1000 : 0);
  const playing = state?.playing ?? false;
  const ready = state?.ready ?? false;
  const mapLabelStr = meta ? (MAPS.find((m) => m.id === meta.mapId)?.label ?? meta.mapId) : '';

  return (
    <div className="min-h-screen bg-[#0a0a0b] text-white">
      <div className="mx-auto w-full max-w-6xl px-5 pb-16 sm:px-8">
        {/* ── Header ─────────────────────────────────────────────────── */}
        <header className="flex w-full flex-wrap items-center justify-between gap-4 pt-5">
          <Link to="/" className="flex items-center gap-2.5">
            <CrosshairMark />
            <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.32em] text-white/50">
              Elyxion Replay
            </span>
          </Link>
          <nav className="flex items-center gap-4 font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-white/45">
            <span className="text-white/30">
              {meta ? (
                <>
                  share #{code} · expires in{' '}
                  {Math.max(0, Math.ceil((meta.expiresAt - Date.now()) / 3600_000))}h
                </>
              ) : (
                'temporary · ~24h'
              )}
            </span>
            <button
              onClick={() => void copyLink()}
              className="rounded border border-cyan-400/40 bg-cyan-400/10 px-2.5 py-1 text-cyan-200 transition hover:bg-cyan-400/20"
            >
              {copied ? 'Copied ✓' : 'Copy link'}
            </button>
            <Link to="/play" className="transition hover:text-white/90">
              Play →
            </Link>
          </nav>
        </header>

        {error ? (
          <main className="mt-24 text-center">
            <p className="font-display text-3xl font-bold text-white/80">
              {error.kind === 'gone' ? 'This replay is gone.' : 'This replay could not be loaded.'}
            </p>
            <p className="mx-auto mt-3 max-w-md text-[13px] leading-relaxed text-white/45">
              Share links are temporary — recordings live for ~24 hours after the
              match. Ask the player for a fresh replay, or{' '}
              <Link to="/play" className="text-cyan-300 hover:text-cyan-200">
                play a match
              </Link>{' '}
              to make your own.
            </p>
          </main>
        ) : !meta || !data ? (
          <main className="mt-24 flex flex-col items-center gap-3">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-cyan-300/30 border-t-cyan-300" />
            <p className="font-mono text-[12px] uppercase tracking-[0.2em] text-white/55">
              Loading replay
            </p>
          </main>
        ) : (
          <main className="mt-6">
            {/* ── Competition header ─────────────────────────────────── */}
            <div className="deck-panel clip-deck flex flex-wrap items-center justify-between gap-4 p-5">
              <div className="flex items-baseline gap-3">
                <span
                  className={`font-display text-3xl font-extrabold uppercase tracking-[0.18em] ${
                    meta.won ? 'text-emerald-300' : 'text-rose-300'
                  }`}
                  style={{
                    filter: meta.won
                      ? 'drop-shadow(0 0 18px rgba(52,211,153,0.5))'
                      : 'drop-shadow(0 0 18px rgba(244,63,94,0.5))',
                  }}
                >
                  {meta.won ? 'Victory' : 'Defeat'}
                </span>
                <span className="text-[10px] uppercase tracking-[0.3em] text-white/40">
                  {meta.runner} · {mapLabelStr} · {fmtTime(meta.durationMs)}
                </span>
              </div>
              <div className="flex items-center gap-4 font-mono text-[11px] tabular-nums text-white/55">
                <span>
                  K <b className="text-emerald-300">{meta.stats.runner.kills}</b>
                </span>
                <span>
                  D <b className="text-rose-300">{meta.stats.runner.deaths}</b>
                </span>
                <span>
                  HS <b className="text-amber-300">{meta.stats.runner.headshots}</b>
                </span>
                <span>
                  T <b className="text-cyan-300">{fmtTime(meta.durationMs)}</b>
                </span>
              </div>
            </div>

            <div className="mt-4 grid gap-4 lg:grid-cols-[1.7fr_1fr]">
              {/* ── The replay ───────────────────────────────────────── */}
              <section className="overflow-hidden rounded-xl border border-white/10 bg-black">
                <canvas ref={canvasRef} className="block aspect-video w-full" />
                {!ready && (
                  <div className="flex h-24 items-center justify-center gap-3">
                    <div className="h-6 w-6 animate-spin rounded-full border-2 border-cyan-300/30 border-t-cyan-300" />
                    <span className="font-mono text-[11px] uppercase tracking-[0.2em] text-white/50">
                      Loading scene…
                    </span>
                  </div>
                )}
                {/* Controls */}
                <div className="flex flex-wrap items-center gap-3 border-t border-white/10 bg-[#0d0f14] px-3 py-2">
                  <button
                    onClick={() => viewerRef.current?.togglePlay()}
                    className="w-14 rounded bg-cyan-400 px-2 py-1.5 text-sm font-bold text-zinc-950 transition hover:bg-cyan-300"
                  >
                    {playing ? '❚❚' : '▶'}
                  </button>
                  <span className="w-16 shrink-0 text-right font-mono text-[11px] tabular-nums text-white/60">
                    {fmtTime(t * 1000)} / {fmtTime(duration * 1000)}
                  </span>
                  <input
                    type="range"
                    min={0}
                    max={Math.max(duration, 0.001)}
                    step={0.01}
                    value={Math.min(t, duration)}
                    onChange={(e) => seekTo(Number(e.target.value))}
                    className="min-w-0 flex-1 accent-cyan-400"
                  />
                  <div className="flex gap-1">
                    {SPEEDS.map((s) => (
                      <button
                        key={s}
                        onClick={() => viewerRef.current?.setSpeed(s)}
                        className={`rounded px-1.5 py-1 font-mono text-[10px] tabular-nums transition ${
                          state?.speed === s
                            ? 'bg-cyan-400/20 text-cyan-200'
                            : 'text-white/40 hover:bg-white/10 hover:text-white/80'
                        }`}
                      >
                        {s}×
                      </button>
                    ))}
                  </div>
                </div>
              </section>

              {/* ── Standings + action feed ──────────────────────────── */}
              <section className="flex flex-col gap-4">
                <div className="rounded-xl border border-white/10 bg-[#0d0f14]">
                  <div className="flex items-center gap-3 border-b border-white/10 px-4 py-2.5">
                    <span className="font-display text-[10px] font-bold uppercase tracking-[0.26em] text-cyan-200/90">
                      Final standings
                    </span>
                    <span className="h-px flex-1 bg-white/10" aria-hidden="true" />
                  </div>
                  <div className="px-4 py-2">
                    {/* Header row */}
                    <div className="grid grid-cols-[1.6rem_1fr_2rem_2rem_2.4rem] gap-2 text-[9px] uppercase tracking-[0.16em] text-white/35">
                      <span>#</span>
                      <span>Player</span>
                      <span className="text-right">K</span>
                      <span className="text-right">D</span>
                      <span className="text-right">HS</span>
                    </div>
                    {meta.stats.players.map((p, i) => {
                      const isRunner = p.name === meta.runner;
                      return (
                        <div
                          key={i}
                          className={`grid grid-cols-[1.6rem_1fr_2rem_2rem_2.4rem] gap-2 border-t border-white/5 py-1.5 font-mono text-[12px] ${
                            isRunner ? 'text-cyan-200' : 'text-white/75'
                          }`}
                        >
                          <span className="tabular-nums text-white/35">{i + 1}</span>
                          <span className="truncate">
                            {p.name}
                            {isRunner && <span className="text-cyan-400/70"> ●</span>}
                          </span>
                          <span className="text-right tabular-nums">{p.kills}</span>
                          <span className="text-right tabular-nums">{p.deaths}</span>
                          <span className="text-right tabular-nums text-amber-300/80">{p.headshots}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Action feed: every frag, timestamped; click to jump the replay */}
                <div className="rounded-xl border border-white/10 bg-[#0d0f14]">
                  <div className="flex items-center gap-3 border-b border-white/10 px-4 py-2.5">
                    <span className="font-display text-[10px] font-bold uppercase tracking-[0.26em] text-cyan-200/90">
                      Match action
                    </span>
                    <span className="h-px flex-1 bg-white/10" aria-hidden="true" />
                    <span className="font-mono text-[9px] uppercase tracking-[0.16em] text-white/30">
                      click to jump
                    </span>
                  </div>
                  <ul className="max-h-[360px] overflow-y-auto px-2 py-2">
                    {data.kills.length === 0 ? (
                      <li className="px-2 py-3 text-[12px] text-white/35">
                        No frags recorded in this match.
                      </li>
                    ) : (
                      [...data.kills]
                        .sort((a, b) => a.t - b.t)
                        .map((k, i) => (
                          <li key={i}>
                            <button
                              onClick={() => seekTo(k.t)}
                              className="flex w-full items-baseline gap-2 rounded px-2 py-1 text-left font-mono text-[11px] transition hover:bg-cyan-400/10"
                            >
                              <span className="shrink-0 tabular-nums text-white/35">
                                {fmtTime(k.t * 1000)}
                              </span>
                              <span className="min-w-0 flex-1 truncate text-right">
                                <span
                                  className={
                                    k.killerId === data.localId
                                      ? 'font-bold text-emerald-300'
                                      : 'text-white/80'
                                  }
                                >
                                  {k.killerName}
                                </span>
                                <span className="text-white/30"> → </span>
                                <span
                                  className={
                                    k.victimId === data.localId
                                      ? 'font-bold text-rose-300'
                                      : 'text-white/55'
                                  }
                                >
                                  {k.victimName}
                                </span>
                                {k.headshot && (
                                  <span className="ml-1 text-amber-300" title="Headshot">
                                    ◎
                                  </span>
                                )}
                              </span>
                            </button>
                          </li>
                        ))
                    )}
                  </ul>
                </div>
              </section>
            </div>

            <footer className="mt-8 border-t border-white/10 pt-4 text-center font-mono text-[10px] uppercase tracking-[0.18em] text-white/30">
              Temporary replay — recordings expire about 24 hours after the match.
            </footer>
          </main>
        )}
      </div>
    </div>
  );
}