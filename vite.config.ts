import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { elyxionEmbedded } from './server/vite-plugin';

// Stamp every served index.html with a unique build id (meta tag, no inline
// script — prod CSP is script-src 'self'). The client's background updater
// (src/update-checker.ts) fetches index.html and compares this id to detect a
// fresh deployment, then prefetches the new hashed assets and reloads at a safe
// boundary. Dev uses a constant 'dev' id so the checker no-ops there (HMR owns
// dev updates).
function elyxionBuildMeta(): Plugin {
  const dev = process.env.NODE_ENV !== 'production';
  const buildId = dev
    ? 'dev'
    : Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  return {
    name: 'elyxion-build-meta',
    transformIndexHtml() {
      return [
        {
          tag: 'meta',
          attrs: { name: 'elyxion-build', content: buildId },
          injectTo: 'head-prepend',
        },
      ];
    },
  };
}

// `npm run dev` is ONE process on ONE PORT: the elyxionEmbedded plugin mounts
// the Express API + the /ws/elyxion game socket inside the Vite dev server, so
// the client, the API, the game socket, and HMR all live on this single port —
// exactly like production, no proxy, no second terminal. (dev:server still runs
// the fork: a standalone API+WS process with no client, for scripts + load tests
// that don't need a browser.)
const PORT = Number(process.env.PORT || '8787');

export default defineConfig({
  plugins: [react(), tailwindcss(), elyxionEmbedded(), elyxionBuildMeta()],
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