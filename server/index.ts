// Elyxion — standalone server entry.
//
// One Node process hosts everything on a single port:
//   • the built web client (dist/, in production)
//   • the stats API           ->  /api/stats
//   • the authoritative game   ->  /ws/elyxion  (WebSocket)
//
// In development this process serves the API + WebSocket only; the Vite dev
// server hosts the client. `npm run dev` (the single-port dev flow) embeds this
// whole app core — API, socket, HMR — in the Vite process instead, so the
// browser always talks to a single origin either way (see server/app.ts + the
// elyxionEmbedded plugin in vite.config.ts).

// Load .env into process.env before ANY module reads env at import time (see
// server/env.ts for why: the server gets no automatic .env handling). app.ts
// loads it too — loading twice is idempotent, and index.ts runs first.
import './env';

import http from 'node:http';
import { app, elyxionUpgrade, adminApiTokenEnabled, dev, hasBuild, ELYXION_WS_PATH } from './app';

const host = process.env.HOST || (dev ? 'localhost' : '0.0.0.0');
const port = parseInt(process.env.PORT || '8787', 10);

const server = http.createServer(app);
server.on('error', (err) => console.error('[server] error', err));

// Game socket upgrades are handled against the same HTTP server so it shares the
// port (and any TLS terminator / tunnel in front of it). The shared handler only
// touches /ws/elyxion upgrades; in this standalone server nothing else listens.
server.on('upgrade', elyxionUpgrade);

server.listen(port, host, () => {
  console.log(`> Elyxion server ready on http://${host}:${port}`);
  console.log(`>   game socket:  ws://${host}:${port}${ELYXION_WS_PATH}`);
  console.log(`>   stats api:    http://${host}:${port}/api/stats`);
  console.log(
    `>   metrics api:  http://${host}:${port}/api/admin/metrics/report ` +
      `(token auth ${adminApiTokenEnabled ? 'ENABLED' : 'disabled — set ADMIN_API_TOKEN'})`,
  );
  if (!hasBuild && dev) {
    console.log('>   dev mode: run `npm run dev` (Vite) for the client on the same port.');
  }
});