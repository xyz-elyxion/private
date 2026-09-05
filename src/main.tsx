import { lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import './index.css';
import Landing from './pages/Landing';
import SupportPage from './pages/SupportPage';
import CommunityPage from './pages/CommunityPage';
import Loader from './Loader';

// Code-split the game client: it drags in the whole Three.js engine (~1MB), and
// the landing page shouldn't pay for that on first paint. The /play route loads
// it lazily; Landing stays eager so the splash is instant.
const ElyxionClient = lazy(() => import('./ElyxionClient'));
const PodiumLab = lazy(() => import('./PodiumLab'));
const LockerLab = lazy(() => import('./LockerLab'));
const AdminDashboard = lazy(() => import('./AdminDashboard'));
const ReplayPage = lazy(() => import('./pages/ReplayPage'));
const MyReplaysPage = lazy(() => import('./pages/MyReplaysPage'));
const ReplayEditorPage = lazy(() => import('./pages/ReplayEditorPage'));

// Minimal full-screen fallback while the game chunk downloads — matches the
// app's dark background so there's no flash.
const Loading = () => (
  <div className='fixed inset-0 flex items-center justify-center overflow-hidden bg-[#e5e7eb]'>
    <Loader />
  </div>
);

// NOTE: intentionally NOT wrapped in <StrictMode>. The game client owns a WebGL
// context, pointer-lock, and a WebSocket; React 18/19 StrictMode double-invokes
// effects in dev, which would spin up two GL contexts / two sockets. Production
// builds never run StrictMode anyway, so we keep dev and prod identical here.
// Offline play + fast updates (production only). The generated worker
// (scripts/sw.js → dist/sw.js) precaches the shell and app chunks, so once the
// site has loaded the whole game — solo, bots, training — keeps working with no
// network, and every deploy ships a fresh worker that makes the new build
// instantly available. It never force-reloads mid-match: the updater in the
// game client (src/update-checker.ts) still owns the reload moment. Dev stays
// worker-free — Vite HMR owns dev updates.
if (
  import.meta.env.PROD &&
  typeof navigator !== 'undefined' &&
  'serviceWorker' in navigator
) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* non-fatal: the site works without a worker */
    });
  });
}

createRoot(document.getElementById('root')!).render(
  <BrowserRouter>
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route
        path="/play"
        element={
          <Suspense fallback={<Loading />}>
            <ElyxionClient />
          </Suspense>
        }
      />
      <Route path="/support" element={<SupportPage />} />
      <Route path="/community" element={<CommunityPage />} />
      <Route
        path="/replays"
        element={
          <Suspense fallback={<Loading />}>
            <MyReplaysPage />
          </Suspense>
        }
      />
      <Route
        path="/replay/:code/edit"
        element={
          <Suspense fallback={<Loading />}>
            <ReplayEditorPage />
          </Suspense>
        }
      />
      {/* Temporary share-link replays: /replay/<code> (competition-style recap) */}
      <Route
        path="/replay/:code"
        element={
          <Suspense fallback={<Loading />}>
            <ReplayPage />
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
    </Routes>
  </BrowserRouter>,
);
