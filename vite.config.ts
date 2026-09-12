import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Development is hosted by server/index.ts, which mounts Vite in middleware
// mode on the same HTTP listener as the API and game WebSocket.

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Relative asset URLs (./assets/…) so the same zip works on ANY host layout:
  // our own domain root, itch.io's per-game subdirectories
  // (https://html-classic.itch.zone/games/<id>/…), or any portal CDN. The
  // server re-anchors these for deep SPA routes (see server/index.ts) and the
  // client resolves runtime assets via assetUrl() against BASE_URL.
  base: './',
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
  },
  // CRAZYGAMES: when the bundle is hosted on CrazyGames' domain but the backend
  // stays on the developer's origin, set VITE_API_BASE (e.g.
  // `VITE_API_BASE=https://your-backend.example.com vite build`) so /api calls and the game
  // WebSocket cross over to the real backend. Unset (default) = same-origin,
  // which is correct for the self-hosted site and for local dev.
  define: {
    __CG_API_BASE__: JSON.stringify(process.env.VITE_API_BASE ?? ''),
  },
});
