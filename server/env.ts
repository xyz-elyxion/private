// Load a project-root `.env` file into process.env, if present.
//
// The Node server runs via `tsx` (npm run dev / npm start) and — unlike the
// Vite dev process, which loads `.env` itself — gets NO automatic environment
// handling. So PORT, DATA_DIR, ADMIN_USERNAMES, ADMIN_API_TOKEN, etc. set in
// `.env` were silently ignored: .env.example and the README say to copy the
// file, but nothing ever read it. This module fixes that.
//
// Rules (same spirit as dotenv / the framework's tiny loader):
//   • KEY=value lines only; blank lines and `#` comments are skipped.
//   • Surrounding single/double quotes are stripped (ADMIN_API_TOKEN="…").
//   • An already-set variable is never clobbered — a real environment variable
//     (process manager / PaaS / shell export) always wins.
//   • A missing `.env` is fine (no error) — hosted production sets variables
//     through the platform, never the file.
//
// Import this FIRST in server/index.ts, before anything reads process.env: ESM
// executes side-effect imports in source order, so db.ts (DATA_DIR /
// DATABASE_PATH), admin.ts (ADMIN_API_TOKEN), and elyxion-game.ts
// (NETCODE_DIAG) all see the loaded values at their own import time.

import fs from 'node:fs';
import path from 'node:path';

const ENV_PATH = path.join(process.cwd(), '.env');

if (fs.existsSync(ENV_PATH)) {
  for (const line of fs.readFileSync(ENV_PATH, 'utf8').split(/\r?\n/)) {
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    if (!m) continue; // blank or comment line
    const [, key, raw] = m;
    if (process.env[key] !== undefined) continue; // a real env var wins
    let val = raw.trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    process.env[key] = val;
  }
}