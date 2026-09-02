// Single-port dev: embeds the whole server core (Express app + the /ws/elyxion
// game socket) INTO the Vite dev server, so `npm run dev` is ONE process on ONE
// port. The browser loads the page, the API, the socket, and HMR all from the
// same origin — exactly like production, no proxy, no second terminal.
//
// The express app is mounted before Vite's own middlewares; unmatched requests
// fall through to Vite (transform + index.html + static), so dev-only paths
// like /@vite/client and the HMR websocket keep working untouched.

import './env';
import type { ViteDevServer } from 'vite';
import type { Plugin } from 'vite';
import { app, elyxionUpgrade } from './app';

export function elyxionEmbedded(): Plugin {
  return {
    name: 'elyxion-embedded-server',
    enforce: 'pre',
    configureServer(server: ViteDevServer) {
      // API routes, security headers, JSON body parsing — first in line. It
      // calls next() on anything it doesn't own, so Vite still serves the app.
      server.middlewares.use(app);

      // Game socket upgrades, alongside Vite's own (HMR) upgrade listener. The
      // shared handler only touches /ws/elyxion and leaves every other upgrade
      // alone, so HMR and the game socket coexist on the same http server.
      server.httpServer?.on('upgrade', elyxionUpgrade);

      // Restart the dev server when a server-side file changes, so edits to
      // routes/game logic apply without a manual restart (the embedded server
      // lives in the vite process, not in `tsx watch`).
      server.watcher.add(['server/**/*.ts']);
      server.watcher.on('change', (file) => {
        if (typeof file === 'string' && file.startsWith('server/')) {
          console.log(`[elyxion] server file changed (${file}) — restarting dev server`);
          void server.restart();
        }
      });
    },
  };
}