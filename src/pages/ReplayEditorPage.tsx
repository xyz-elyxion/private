import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useAuth, LoginModal } from '../auth';
import { decodeReplay, encodeReplay, type ReplayData } from '../game/replay-codec';
import { ReplayViewer, type ReplayViewerState } from '../game/replay-viewer';
import { MAPS } from '../game/map';
import { CrosshairMark } from './Landing';

const MIN_CLIP_SEC = 5;
const SPEEDS = [0.5, 1, 2] as const;

type EditState = { kind: 'loading' | 'ready' | 'error'; message?: string };

function fmtTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0:00.0';
  const m = Math.floor(seconds / 60);
  const rem = (seconds - m * 60).toFixed(1);
  return m > 0 ? `${m}:${rem.padStart(4, '0')}` : `${rem}s`;
}

function trimReplay(data: ReplayData, start: number, end: number, localId: string): ReplayData {
  const inTime = Math.max(0, start);
  const outTime = Math.max(inTime, end);
  const shift = (t: number) => Math.max(0, t - inTime);
  return {
    ...data,
    localId,
    durationMs: Math.max(0, Math.round((outTime - inTime) * 1000)),
    frames: data.frames
      .filter((frame) => frame.t >= inTime - 0.001 && frame.t <= outTime + 0.001)
      .map((frame) => ({ ...frame, t: shift(frame.t) })),
    kills: data.kills
      .filter((kill) => kill.t >= inTime && kill.t <= outTime)
      .map((kill) => ({ ...kill, t: shift(kill.t) })),
    shots: data.shots
      .filter((shot) => shot.t >= inTime && shot.t <= outTime)
      .map((shot) => ({ ...shot, t: shift(shot.t) })),
  };
}

function Preview({ data }: { data: ReplayData }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewerRef = useRef<ReplayViewer | null>(null);
  const [state, setState] = useState<ReplayViewerState | null>(null);

  useEffect(() => {
    if (!canvasRef.current) return;
    const viewer = new ReplayViewer(canvasRef.current, data, setState, {
      fov: 90,
      resolutionScale: 1,
      lowSpec: false,
    });
    viewerRef.current = viewer;
    void viewer.start();
    return () => {
      viewer.dispose();
      viewerRef.current = null;
    };
  }, [data]);

  const duration = state?.duration ?? data.durationMs / 1000;
  return (
    <section className='overflow-hidden rounded-xl border border-white/10 bg-black'>
      <canvas ref={canvasRef} className='block aspect-video w-full' />
      <div className='flex flex-wrap items-center gap-3 border-t border-white/10 bg-[#0d0f14] px-3 py-2'>
        <button
          type='button'
          onClick={() => viewerRef.current?.togglePlay()}
          className='w-14 rounded bg-cyan-400 px-2 py-1.5 text-sm font-bold text-zinc-950 transition hover:bg-cyan-300'
        >
          {state?.playing ? '❚❚' : '▶'}
        </button>
        <span className='w-20 shrink-0 text-right font-mono text-[11px] tabular-nums text-white/60'>
          {fmtTime(state?.t ?? 0)} / {fmtTime(duration)}
        </span>
        <input
          type='range'
          min={0}
          max={Math.max(duration, 0.001)}
          step={0.01}
          value={Math.min(state?.t ?? 0, duration)}
          onChange={(event) => viewerRef.current?.seek(Number(event.target.value))}
          className='min-w-0 flex-1 accent-cyan-400'
          aria-label='Preview position'
        />
        <div className='flex gap-1'>
          {SPEEDS.map((speed) => (
            <button
              key={speed}
              type='button'
              onClick={() => viewerRef.current?.setSpeed(speed)}
              className={`rounded px-1.5 py-1 font-mono text-[10px] tabular-nums transition ${
                state?.speed === speed ? 'bg-cyan-400/20 text-cyan-200' : 'text-white/40 hover:bg-white/10 hover:text-white/80'
              }`}
            >
              {speed}×
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}

export default function ReplayEditorPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const { code = '' } = useParams<{ code: string }>();
  const [data, setData] = useState<ReplayData | null>(null);
  const [editState, setEditState] = useState<EditState>({ kind: 'loading' });
  const [inPoint, setInPoint] = useState(0);
  const [outPoint, setOutPoint] = useState(0);
  const [povId, setPovId] = useState('');
  const [sourceMode, setSourceMode] = useState('');
  const [previewData, setPreviewData] = useState<ReplayData | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [showLogin, setShowLogin] = useState(false);

  useEffect(() => {
    if (!auth.ready || !auth.account) return;
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch(`/api/replays/${encodeURIComponent(code)}/edit-source`, {
          credentials: 'same-origin',
        });
        if (!response.ok) {
          setEditState({
            kind: 'error',
            message: response.status === 404 ? 'Replay not found, expired, or not owned by this account.' : 'Replay could not be loaded.',
          });
          return;
        }
        const decoded = decodeReplay(await response.arrayBuffer());
        setSourceMode(response.headers.get('X-Elyxion-Mode') ?? '');
        const frameEnd = decoded.frames[decoded.frames.length - 1]?.t ?? decoded.durationMs / 1000;
        const duration = Math.max(MIN_CLIP_SEC, Math.min(decoded.durationMs / 1000, frameEnd));
        const initialOut = Math.max(MIN_CLIP_SEC, duration);
        if (cancelled) return;
        setData(decoded);
        setInPoint(0);
        setOutPoint(initialOut);
        setPovId(decoded.localId || decoded.profiles[0]?.id || '');
        setPreviewData(trimReplay(decoded, 0, initialOut, decoded.localId || decoded.profiles[0]?.id || ''));
        setEditState({ kind: 'ready' });
      } catch {
        if (!cancelled) setEditState({ kind: 'error', message: 'Replay data is invalid or unavailable.' });
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [auth.ready, auth.account, code]);

  const duration = useMemo(() => {
    if (!data) return 0;
    const frameEnd = data.frames[data.frames.length - 1]?.t ?? data.durationMs / 1000;
    return Math.max(0, Math.min(data.durationMs / 1000, frameEnd));
  }, [data]);
  const selectedDuration = Math.max(0, outPoint - inPoint);
  const selectedKills = useMemo(
    () => data?.kills.filter((kill) => kill.t >= inPoint && kill.t <= outPoint) ?? [],
    [data, inPoint, outPoint],
  );
  const mapLabel = data ? MAPS.find((map) => map.id === data.mapId)?.label ?? data.mapId : '';

  const applyPreview = () => {
    if (!data || selectedDuration < MIN_CLIP_SEC || !povId) return;
    const next = trimReplay(data, inPoint, outPoint, povId);
    if (next.frames.length === 0) {
      setMessage('Choose a range that contains recorded frames.');
      return;
    }
    setPreviewData(next);
    setMessage('Preview updated.');
  };

  const setInFrom = (time: number) => {
    const next = Math.max(0, Math.min(time, outPoint - MIN_CLIP_SEC));
    setInPoint(next);
  };
  const setOutFrom = (time: number) => {
    const next = Math.min(duration, Math.max(time, inPoint + MIN_CLIP_SEC));
    setOutPoint(next);
  };

  const save = async () => {
    if (!previewData || saving) return;
    setSaving(true);
    setMessage(null);
    try {
      const body = encodeReplay(previewData);
      const response = await fetch('/api/replays', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          ...(sourceMode ? { 'X-Elyxion-Mode': sourceMode } : {}),
        },
        credentials: 'same-origin',
        body: body.slice().buffer,
      });
      const result = (await response.json().catch(() => ({}))) as { code?: string; url?: string; error?: string };
      if (!response.ok || !result.code) {
        setMessage(result.error === 'rate_limited' ? 'Replay upload limit reached. Try again later.' : 'Could not save the edited replay.');
        return;
      }
      setMessage('Edited replay saved as a new replay.');
      navigate(result.url ?? `/replay/${result.code}`);
    } catch {
      setMessage('Network error while saving the edited replay.');
    } finally {
      setSaving(false);
    }
  };

  if (!auth.ready) return <Centered>Loading editor...</Centered>;
  if (!auth.account) {
    return (
      <Centered>
        <div className='text-center'>
          <p className='text-white/70'>Log in to edit your replays.</p>
          <button
            type='button'
            onClick={() => setShowLogin(true)}
            className='mt-4 rounded-lg bg-cyan-400 px-5 py-2 font-bold uppercase tracking-[0.14em] text-zinc-950 transition hover:bg-cyan-300'
          >
            Log in / Register
          </button>
          {showLogin && <LoginModal auth={auth} onClose={() => setShowLogin(false)} />}
        </div>
      </Centered>
    );
  }

  if (editState.kind === 'loading') return <Centered>Loading replay editor...</Centered>;
  if (editState.kind === 'error' || !data || !previewData) {
    return (
      <Centered>
        <div className='max-w-md text-center'>
          <p className='font-display text-2xl text-rose-300'>Replay unavailable</p>
          <p className='mt-2 text-[13px] text-white/55'>{editState.message}</p>
          <Link to='/replays' className='mt-4 inline-block text-cyan-300 hover:text-cyan-200'>
            Back to replays
          </Link>
        </div>
      </Centered>
    );
  }

  return (
    <div className='min-h-screen bg-[#0a0a0b] text-white'>
      <div className='mx-auto w-full max-w-6xl px-5 pb-16 sm:px-8'>
        <header className='flex flex-wrap items-center justify-between gap-4 pt-5'>
          <Link to='/replays' className='flex items-center gap-2.5'>
            <CrosshairMark />
            <span className='font-mono text-[10px] font-semibold uppercase tracking-[0.32em] text-white/50'>Replay Editor</span>
          </Link>
          <nav className='flex items-center gap-4 font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-white/45'>
            <span className='text-white/30'>{mapLabel} · source #{code}</span>
            <Link to='/replays' className='transition hover:text-white/90'>
              My replays →
            </Link>
          </nav>
        </header>

        {message && <div className='mt-5 rounded-md border border-cyan-400/30 bg-cyan-400/10 px-3 py-2 font-mono text-[11px] text-cyan-100'>{message}</div>}

        <main className='mt-6'>
          <div className='flex flex-wrap items-end justify-between gap-3'>
            <div>
              <div className='mb-1 font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-cyan-300'>Non-destructive edit</div>
              <h1 className='font-display text-3xl font-extrabold uppercase tracking-[0.16em] text-white'>Replay editor</h1>
              <p className='mt-2 text-[13px] text-white/45'>Trim a highlight, choose whose eyes to follow, then save a new shareable replay.</p>
            </div>
            <div className='font-mono text-[11px] tabular-nums text-white/45'>Source length {fmtTime(duration)}</div>
          </div>

          <div className='mt-5 grid gap-4 lg:grid-cols-[1.6fr_1fr]'>
            <Preview data={previewData} />
            <section className='rounded-xl border border-white/10 bg-[#0d0f14] p-4'>
              <div className='font-display text-[11px] font-bold uppercase tracking-[0.24em] text-cyan-200/90'>Edit controls</div>

              <label className='mt-4 block font-mono text-[10px] uppercase tracking-[0.16em] text-white/45'>Point of view</label>
              <select
                value={povId}
                onChange={(event) => setPovId(event.target.value)}
                className='mt-1 w-full rounded-md border border-white/15 bg-black/40 px-2 py-2 font-mono text-[12px] text-white/85 outline-none focus:border-cyan-400/60'
              >
                {data.profiles.map((profile) => (
                  <option key={profile.id} value={profile.id} className='bg-zinc-900'>
                    {profile.name} ({profile.kind})
                  </option>
                ))}
              </select>

              <div className='mt-4 flex items-center justify-between font-mono text-[11px] tabular-nums'>
                <span className='text-cyan-200'>IN {fmtTime(inPoint)}</span>
                <span className='text-amber-200'>OUT {fmtTime(outPoint)}</span>
              </div>
              <div className='mt-2 space-y-2'>
                <input
                  type='range'
                  min={0}
                  max={duration}
                  step={0.01}
                  value={inPoint}
                  onChange={(event) => setInFrom(Number(event.target.value))}
                  className='w-full accent-cyan-400'
                  aria-label='Trim in point'
                />
                <input
                  type='range'
                  min={0}
                  max={duration}
                  step={0.01}
                  value={outPoint}
                  onChange={(event) => setOutFrom(Number(event.target.value))}
                  className='w-full accent-amber-400'
                  aria-label='Trim out point'
                />
              </div>
              <div className='mt-2 flex justify-between font-mono text-[10px] text-white/30'>
                <span>0:00</span>
                <span>{fmtTime(duration)}</span>
              </div>

              <div className='mt-4 grid grid-cols-2 gap-2'>
                <div className='rounded border border-white/10 bg-black/25 px-3 py-2'>
                  <div className='font-mono text-[9px] uppercase tracking-[0.14em] text-white/35'>Clip length</div>
                  <div className='mt-1 font-mono text-[15px] tabular-nums text-white/85'>{fmtTime(selectedDuration)}</div>
                </div>
                <div className='rounded border border-white/10 bg-black/25 px-3 py-2'>
                  <div className='font-mono text-[9px] uppercase tracking-[0.14em] text-white/35'>Frags included</div>
                  <div className='mt-1 font-mono text-[15px] tabular-nums text-amber-200'>{selectedKills.length}</div>
                </div>
              </div>

              <div className='mt-4 flex flex-wrap gap-2'>
                <button
                  type='button'
                  onClick={() => setInFrom(0)}
                  className='rounded border border-white/15 px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-white/65 transition hover:border-cyan-400/50 hover:text-cyan-200'
                >
                  Reset in
                </button>
                <button
                  type='button'
                  onClick={() => setOutFrom(duration)}
                  className='rounded border border-white/15 px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-white/65 transition hover:border-amber-400/50 hover:text-amber-200'
                >
                  Reset out
                </button>
                <button
                  type='button'
                  onClick={applyPreview}
                  disabled={selectedDuration < MIN_CLIP_SEC}
                  className='rounded bg-cyan-400 px-3 py-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.12em] text-zinc-950 transition hover:bg-cyan-300 disabled:opacity-40'
                >
                  Apply preview
                </button>
              </div>

              <div className='mt-5 border-t border-white/10 pt-4'>
                <div className='font-mono text-[10px] uppercase tracking-[0.16em] text-white/45'>Action markers</div>
                {data.kills.length === 0 ? (
                  <p className='mt-2 text-[12px] text-white/35'>No kills recorded in this replay.</p>
                ) : (
                  <div className='mt-2 max-h-48 space-y-1 overflow-y-auto pr-1'>
                    {[...data.kills].sort((a, b) => a.t - b.t).map((kill, index) => (
                      <div key={`${kill.t}-${index}`} className='flex items-center gap-2 rounded border border-white/5 bg-black/20 px-2 py-1.5 font-mono text-[10px]'>
                        <span className='w-12 shrink-0 tabular-nums text-white/35'>{fmtTime(kill.t)}</span>
                        <span className='min-w-0 flex-1 truncate text-white/70'>{kill.killerName} → {kill.victimName}</span>
                        <button
                          type='button'
                          onClick={() => setInFrom(kill.t - 2)}
                          className='shrink-0 text-cyan-300/80 transition hover:text-cyan-200'
                          title='Set trim in two seconds before this action'
                        >
                          IN
                        </button>
                        <button
                          type='button'
                          onClick={() => setOutFrom(kill.t + 3)}
                          className='shrink-0 text-amber-300/80 transition hover:text-amber-200'
                          title='Set trim out three seconds after this action'
                        >
                          OUT
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <button
                type='button'
                onClick={() => void save()}
                disabled={saving || !previewData || previewData.frames.length === 0}
                className='mt-5 w-full rounded-lg bg-cyan-400 px-4 py-3 font-mono text-[11px] font-bold uppercase tracking-[0.16em] text-zinc-950 transition hover:bg-cyan-300 disabled:opacity-40'
              >
                {saving ? 'Saving edited replay...' : 'Save as new replay'}
              </button>
              <p className='mt-2 text-[10px] leading-relaxed text-white/30'>The original replay stays unchanged. Edited copies expire on the same temporary replay schedule.</p>
            </section>
          </div>
        </main>
      </div>
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className='flex min-h-screen items-center justify-center bg-zinc-950 font-mono text-sm text-white/70'>{children}</div>;
}
