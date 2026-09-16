import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, HashRouter, Routes, Route, Navigate, useParams } from 'react-router-dom';
import './index.css';
import { initCrazyGames, syncCgSettings, cgLoadingStart } from './crazygames';
import Landing from './pages/Landing';
import PublicProfile from './pages/PublicProfile';
import Docs from './pages/Docs';
import { LegalPage } from './legal';
import ErrorPage from './pages/ErrorPage';

/* ── CrazyGames boot ─────────────────────────────────────────────────────
 * Init the SDK before the React tree renders, per the v3 docs ("do this
 * before the game starts, for example on the loading screen"). We deliberately
 * do NOT await it — React can mount while the SDK handshake finishes so the
 * landing page paints instantly; every SDK call in src/crazygames queues
 * behind the same init promise anyway. When the SDK is absent (local dev,
 * blocked script) this resolves immediately and the game runs in fallback
 * mode. On CrazyGames we also fire loadingStart() here so the platform sees
 * the full load window (script → bundle → first render). */
initCrazyGames().then(() => {
  syncCgSettings(); // pick up muteAudio / disableChat before any UI mounts
  cgLoadingStart();
});

// Code-split the game client: it drags in the whole Three.js engine (~1MB), and
// the landing page shouldn't pay for that on first paint. The /play route loads
// it lazily; Landing stays eager so the splash is instant.
const ElyxionClient = lazy(() => import('./ElyxionClient'));
const PodiumLab = lazy(() => import('./PodiumLab'));
const LockerLab = lazy(() => import('./LockerLab'));
const AdminDashboard = lazy(() => import('./AdminDashboard'));
const Donate = lazy(() => import('./pages/Donate'));
const PlayerSearch = lazy(() => import('./pages/PlayerSearch'));
const Support = lazy(() => import('./pages/Support'));
const Appeal = lazy(() => import('./pages/Appeal'));
const MapEditor = lazy(() => import('./pages/MapEditor'));

// Minimal full-screen fallback while the game chunk downloads — matches the
// app's dark background so there's no flash.
// Swirling loader — an SVG circle with an animated dash that both rotates and
// morphs its dash length, giving a fluid "swirling" motion. Pure inline SVG +
// CSS keyframes: no extra dependency, no extra network request.
const Swirling = (props: React.ComponentProps<'svg'>) => (
  <>
    <style>{`
      @keyframes loading-ui-swirling-spin {
        to {
          transform: rotate(360deg);
        }
      }

      @keyframes loading-ui-swirling-dash {
        0% {
          stroke-dasharray: 1, 800;
          stroke-dashoffset: 0;
        }
        50% {
          stroke-dasharray: 400, 400;
          stroke-dashoffset: -200px;
        }
        100% {
          stroke-dasharray: 800, 1;
          stroke-dashoffset: -800px;
        }
      }

      .loading-ui-swirling-circle {
        transform-origin: center;
        animation:
          loading-ui-swirling-dash var(--duration, 1.5s) ease-in-out infinite alternate,
          loading-ui-swirling-spin calc(var(--duration, 1.5s) * 1.333333) linear infinite;
      }
    `}</style>
    <svg viewBox="0 0 800 800" xmlns="http://www.w3.org/2000/svg" {...props}>
      <circle
        className="loading-ui-swirling-circle"
        cx="400"
        cy="400"
        r="200"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="50"
      />
    </svg>
  </>
);

const Loading = () => (
  <div
    style={{
      position: 'fixed',
      inset: 0,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: '#0a0a0b',
    }}
  >
    <Swirling
      style={{ width: 64, height: 64, color: '#6b7280' }}
      aria-label="Loading"
      role="status"
    />
  </div>
);

// Loading ends when the first route has mounted and painted — after that the
// player is on the launcher / in the game, and gameplayStart/Stop own the
// session state. Fired once, guarded so React's double-invoke in dev can't
// emit two loadingStop events (harmless, but tidy).
let cgLoadingDone = false;
function markCgLoadingDone() {
  if (cgLoadingDone) return;
  cgLoadingDone = true;
  // Double-rAF = first paint happened (the browser committed at least one frame).
  requestAnimationFrame(() => requestAnimationFrame(() => {
    // Imported lazily so the SDK wrapper stays tree-shakeable from this path.
    void import('./crazygames').then((cg) => cg.cgLoadingStop());
  }));
}

// BootGate: an intentionally brief first-load veil. It holds the splash while
// the (already-lazy) game chunk resolves and the CrazyGames SDK handshake
// completes — but never blocks more than 2.5s, and NEVER blocks at all when the
// SDK isn't present (plain local dev falls through instantly). This is what
// lets the game "land directly in gameplay" per CrazyGames' QA expectations:
// /play resolves into the arena instead of a menu cascade.
function BootGate({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [sdkSettled, setSdkSettled] = useState(false);

  useEffect(() => {
    markCgLoadingDone();
    // If the SDK script never shows up (local dev / blocked script), don't
    // gate on it — fall through immediately.
    void import('./crazygames').then((cg) => {
      if (!cg.cgSdkScriptPresent()) setSdkSettled(true);
    });
    // Otherwise give the SDK a short window to init, then proceed regardless
    // (game logic never depends on the SDK being ready — this is cosmetic).
    const t = setTimeout(() => setReady(true), 300);
    const t2 = setTimeout(() => setSdkSettled(true), 2500);
    return () => {
      clearTimeout(t);
      clearTimeout(t2);
    };
  }, []);

  return (
    <>
      {children}
      {!ready && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 100,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: '#0a0a0b',
            color: '#22d3ee',
            fontFamily: 'system-ui, sans-serif',
            letterSpacing: '0.3em',
            fontSize: 12,
            pointerEvents: 'none',
            opacity: 0.9,
            transition: 'opacity 0.25s ease',
          }}
        >
          LOADING
        </div>
      )}
      {ready && !sdkSettled && (
        <CgSdkWatcher onSettled={() => setSdkSettled(true)} />
      )}
    </>
  );
}

// Watches the SDK init promise after the veil lifts, so loadingStop fires as
// soon as the handshake finishes (or fails) — never later than 2.5s in.
function CgSdkWatcher({ onSettled }: { onSettled: () => void }) {
  useEffect(() => {
    let alive = true;
    void import('./crazygames').then((cg) =>
      cg.initCrazyGames().finally(() => {
        if (alive) onSettled();
      }),
    );
    return () => {
      alive = false;
    };
  }, [onSettled]);
  return null;
}

// NOTE: intentionally NOT wrapped in <StrictMode>. The game client owns a WebGL
// context, pointer-lock, and a WebSocket; React 18/19 StrictMode double-invokes
// effects in dev, which would spin up two GL contexts / two sockets. Production
// builds never run StrictMode anyway, so we keep dev and prod identical here.

// PORTAL EMBEDS (itch.io serves each game from /html/<id>/index.html, other
// portals use similar paths): there is no server SPA fallback there, so
// path-based routes can neither match ("No routes matched" → black screen)
// nor navigate. When the page URL is not one of the app's own route paths,
// switch to HashRouter — routes ride in the #fragment, which works from any
// static host — and drop the player straight into the game (portal QA expects
// instant gameplay, no menu cascade). The self-hosted site keeps BrowserRouter
// with clean URLs.
const ROUTE_PATHS = /^\/(play|docs|admin|podiumlab|lockerlab|legal|donate|search|support|appeal|mapeditor|error)(\/|$)/;
function isPortalEmbed(): boolean {
  if (typeof window === 'undefined') return false;
  // Inside an iframe (itch.io, CrazyGames, Poki…) we can't trust the pathname —
  // portals serve the game from arbitrary paths like /html/<id>/index.html —
  // so always use the hash router there.
  try {
    if (window.self !== window.top) return true;
  } catch {
    return true; // cross-origin frame access denied → we ARE framed
  }
  // Top-level navigation → clean BrowserRouter URLs. An unknown top-level path
  // (e.g. a mistyped /fgd) is a 404, not a portal embed — the path router keeps
  // the URL intact and the themed 404 page explains what happened.
  return false;
}
const portal = isPortalEmbed();

const gameRoute = (
  <Suspense fallback={<Loading />}>
    <ElyxionClient />
  </Suspense>
);

createRoot(document.getElementById('root')!).render(
  portal ? (
    <HashRouter>
      <BootGate>
        <Routes>
          <Route path="/" element={<Navigate to="/play" replace />} />
          <Route path="/play" element={gameRoute} />
          <Route path="/legal/:doc" element={<LegalPage />} />
          <Route
            path="/play/profile/:username"
            element={
              <Suspense fallback={<Loading />}>
                <PublicProfile />
              </Suspense>
            }
          />
          {/* Unknown hash paths also land in the game — never a blank screen. */}
          <Route path="*" element={gameRoute} />
        </Routes>
      </BootGate>
    </HashRouter>
  ) : (
  <BrowserRouter>
    <BootGate>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/docs" element={<Docs />} />
        <Route
          path="/donate"
          element={
            <Suspense fallback={<Loading />}>
              <Donate />
            </Suspense>
          }
        />
        <Route
          path="/support"
          element={
            <Suspense fallback={<Loading />}>
              <Support />
            </Suspense>
          }
        />
        <Route
          path="/appeal"
          element={
            <Suspense fallback={<Loading />}>
              <Appeal />
            </Suspense>
          }
        />
        <Route
          path="/mapeditor"
          element={
            <Suspense fallback={<Loading />}>
              <MapEditor />
            </Suspense>
          }
        />
        <Route
          path="/search"
          element={
            <Suspense fallback={<Loading />}>
              <PlayerSearch />
            </Suspense>
          }
        />
        <Route path="/legal/:doc" element={<LegalPage />} />
        {/* Direct link to a themed error page, e.g. /error/503. */}
        <Route
          path="/error/:code"
          element={<ErrorPage code={Number(useParams().code) || 500} />}
        />
        <Route
          path="/play"
          element={
            <Suspense fallback={<Loading />}>
              <ElyxionClient />
            </Suspense>
          }
        />
        <Route
          path="/podiumlab"
          element={
            <Suspense fallback={<Loading />}>
              <PodiumLab />
            </Suspense>
          }
        />
        <Route
          path="/lockerlab"
          element={
            <Suspense fallback={<Loading />}>
              <LockerLab />
            </Suspense>
          }
        />
        <Route
          path="/admin"
          element={
            <Suspense fallback={<Loading />}>
              <AdminDashboard />
            </Suspense>
          }
        />
        <Route
          path="/play/profile/:username"
          element={
            <Suspense fallback={<Loading />}>
              <PublicProfile />
            </Suspense>
          }
        />
        {/* Any unknown browser path → themed 404 with the reason shown. */}
        <Route path="*" element={<ErrorPage code={404} />} />
      </Routes>
    </BootGate>
  </BrowserRouter>
  ),
);
