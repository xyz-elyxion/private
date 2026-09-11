import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import './index.css';
import { initCrazyGames, syncCgSettings, cgLoadingStart } from './crazygames';
import Landing from './pages/Landing';
import PublicProfile from './pages/PublicProfile';
import Docs from './pages/Docs';

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

// Minimal full-screen fallback while the game chunk downloads — matches the
// app's dark background so there's no flash.
const Loading = () => (
  <div
    style={{
      position: 'fixed',
      inset: 0,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: '#0a0a0b',
      color: '#6b7280',
      fontFamily: 'system-ui, sans-serif',
    }}
  >
    Loading…
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
createRoot(document.getElementById('root')!).render(
  <BrowserRouter>
    <BootGate>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/docs" element={<Docs />} />
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
      </Routes>
    </BootGate>
  </BrowserRouter>,
);
