import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { elyxionEmbedded } from './server/vite-plugin';

// `npm run dev` is ONE process on ONE PORT: the elyxionEmbedded plugin mounts
// the Express API + the /ws/elyxion game socket inside the Vite dev server, so
// the client, the API, the game socket, and HMR all live on this single port —
// exactly like production, no proxy, no second terminal. (dev:server still runs
// the fork: a standalone API+WS process with no client, for scripts + load tests
// that don't need a browser.)
const PORT = Number(process.env.PORT || '8787');

export default defineConfig({
  plugins: [react(), tailwindcss(), elyxionEmbedded()],
  server: {
    port: PORT,
    strictPort: true,
    // The game socket + API are embedded (see /server/vite-plugin.ts), so there
    // is no proxy to the standalone server — the browser is always same-origin.
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
  },
});