import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { elyxionEmbedded } from './server/vite-plugin';

// Every deploy gets ONE build id (mks2k4 style). It stamps index.html's
// `elyxion-build` meta (no inline script — prod CSP is script-src 'self'), so
// the client's background updater (src/update-checker.ts) can detect a fresh
// deployment by fetching index.html and comparing ids. The SAME id is baked
// into sw.js, so each build ships a byte-different service worker that the
// browser always picks up: its cache is named by build id, it cleans older
// builds' caches on activate, and precaches the new chunks. Dev uses a constant
// 'dev' id and no worker (HMR owns dev updates; the worker is build-only).
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
    // Production build: emit dist/sw.js = scripts/sw.js with the placeholders
    // filled in. Precache = the shell + hashed JS/CSS chunks (all the app
    // needs to boot + play offline); models/sounds/fonts cache on first use.
    generateBundle(_opts, bundle) {
      if (dev) return;
      const precache = ['/index.html'].concat(
        Object.keys(bundle)
          .filter((k) => /^assets\/.+\.(js|css)$/.test(k))
          .map((k) => '/' + k),
      );
      const template = fs.readFileSync(
        path.join(path.dirname(fileURLToPath(import.meta.url)), 'scripts/sw.js'),
        'utf8',
      );
      // replaceAll, not replace: __VERSION__/__PRECACHE__ appear in the file's
      // header comment AND in the code — first-occurrence replace() would only
      // fill in the comment and leave broken placeholders in the code.
      const sw = template
        .replaceAll('__VERSION__', buildId)
        .replaceAll('__PRECACHE__', JSON.stringify(precache));
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: sw });
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