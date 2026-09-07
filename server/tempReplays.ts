// Temporary shareable replays. After any finished match the client uploads the
// full-recorded run (replay-codec binary, exactly like weekly-challenge runs);
// the server validates + decodes it, stores it with a 24h TTL, and hands back a
// short share code. Anyone can then open /replay/<code> on the site: the recap
// page fetches the meta (header info WITHOUT the blob) + the blob to play it.
//
// The replays are intentionally TEMPORARY — the sweep deletes expired rows and a
// row cap bounds worst-case growth. Uploads are public (guests included, like
// tickets) but rate-limited per IP and size-capped; the blob is gzip-compressed
// on disk exactly like weekly replays.

import { Router, type Request, type Response } from 'express';
import express from 'express';
import zlib from 'node:zlib';
import { decodeReplay, type ReplayKill } from '../src/game/replay-codec';
import { accountId } from './auth';
import {
  deleteTempReplayForUser,
  getTempReplayBlob,
  getTempReplayBlobForUser,
  getTempReplayMeta,
  listTempReplaysForUser,
  storeTempReplay,
  sweepTempReplays,
  type MyReplayRow,
} from './db';

export const tempReplaysRouter = Router();

const MAX_REPLAY_BYTES = 12 * 1024 * 1024; // same cap as weekly-challenge uploads

// Gamemode labels the client may tag an upload with (display metadata only —
// never trusted for stats, which are always derived from the recording).
const KNOWN_MODES = new Set(['ffa', 'duel', 'tdm', 'ranked', 'solo', 'bots', 'challenge', 'training']);

// ── upload rate limiter (per IP; identity is the cookie account when present) ─
const UPLOAD_WINDOW_MS = 3600_000; // rolling 1 hour
const UPLOAD_MAX = 10; // ~every 6 minutes sustained; plenty for real matches
const uploadHits = new Map<string, number[]>();
function allowUpload(identity: string, now: number): boolean {
  const cutoff = now - UPLOAD_WINDOW_MS;
  const recent = (uploadHits.get(identity) ?? []).filter((ts) => ts > cutoff);
  if (recent.length >= UPLOAD_MAX) {
    uploadHits.set(identity, recent);
    return false;
  }
  recent.push(now);
  uploadHits.set(identity, recent);
  return true;
}
const uploadSweep = setInterval(() => {
  const cutoff = Date.now() - UPLOAD_WINDOW_MS;
  for (const [id, hits] of uploadHits) {
    if (hits.length === 0 || hits[hits.length - 1] <= cutoff) uploadHits.delete(id);
  }
}, UPLOAD_WINDOW_MS);
uploadSweep.unref?.();

// Expired share links die in the background (row-cap trim happens on insert).
const expirySweep = setInterval(() => {
  const n = sweepTempReplays();
  if (n > 0) console.log(`[replays] swept ${n} expired temp replay(s)`);
}, 30 * 60_000);
expirySweep.unref?.();

// Short, typo-proof share code: unambiguous alphabet (no 0/O/1/I/l).
const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz';
function randomCode(len = 6): string {
  let out = '';
  for (let i = 0; i < len; i++) {
    out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return out;
}

// Derive the shareable summary straight from the recording (the same pure codec
// the client uses) — nothing about the stats is client-supplied, so the recap
// page can't be lied to by a tampered upload. Returns null if the blob fails to
// decode at all.
function deriveSummary(bytes: Uint8Array) {
  let data;
  try {
    data = decodeReplay(bytes);
  } catch {
    return null;
  }
  const localId = data.localId;
  const killedBy: Record<string, number> = {}; // victimId → deaths of each actor
  const byKiller: Record<string, ReplayKill[]> = {};
  for (const k of data.kills) {
    byKiller[k.killerId] ??= [];
    byKiller[k.killerId].push(k);
    killedBy[k.victimId] = (killedBy[k.victimId] ?? 0) + 1;
  }
  const shotsById: Record<string, number> = {};
  for (const s of data.shots) shotsById[s.killerId] = (shotsById[s.killerId] ?? 0) + 1;

  const players = data.profiles.map((p) => ({
    name: p.name || 'Player',
    kills: (byKiller[p.id] ?? []).length,
    deaths: killedBy[p.id] ?? 0,
    headshots: (byKiller[p.id] ?? []).filter((k) => k.headshot).length,
  }));
  players.sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
  const localKills = (byKiller[localId] ?? []).length;
  return {
    mapId: data.mapId,
    won: data.won,
    durationMs: data.durationMs,
    runner: data.profiles.find((p) => p.id === localId)?.name || 'Player',
    stats: {
      runner: {
        kills: localKills,
        deaths: killedBy[localId] ?? 0,
        headshots: (byKiller[localId] ?? []).filter((k) => k.headshot).length,
        shots: shotsById[localId] ?? 0,
      },
      players,
    },
  };
}

// Upload a finished match's full recording. Body = replay-codec binary.
// Returns { code, url } for the share link. Public, rate-limited, TTL'd.
tempReplaysRouter.post(
  '/replays',
  express.raw({ type: 'application/octet-stream', limit: MAX_REPLAY_BYTES }),
  async (req: Request, res: Response) => {
    const now = Date.now();
    const id = accountId(req);
    const rateKey = id || req.ip || 'unknown';
    if (!allowUpload(rateKey, now)) {
      res.status(429).json({ error: 'rate_limited' });
      return;
    }
    const rawMode = String(req.headers['x-elyxion-mode'] ?? '').trim().toLowerCase().slice(0, 16);
    const mode = KNOWN_MODES.has(rawMode) ? rawMode : '';
    const buf = req.body as Buffer;
    if (!Buffer.isBuffer(buf) || buf.length === 0) {
      res.status(400).json({ error: 'empty' });
      return;
    }
    if (buf.length > MAX_REPLAY_BYTES) {
      res.status(413).json({ error: 'too_large' });
      return;
    }
    const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    const summary = deriveSummary(bytes);
    if (!summary) {
      res.status(400).json({ error: 'bad_replay' });
      return;
    }
    if (summary.durationMs <= 0 || summary.durationMs > 30 * 60_000) {
      res.status(400).json({ error: 'bad_duration' });
      return;
    }
    // A shareable run needs at least one frame; a no-frame recording is junk.
    if (summary.stats.runner.shots === 0 && summary.stats.runner.kills === 0 && summary.durationMs < 5_000) {
      res.status(400).json({ error: 'nothing_recorded' });
      return;
    }

    const gz = zlib.gzipSync(buf, { level: 6 });
    // Compressed sanity cap: real recordings compress far below this, so a gz
    // over ~2MB means an incompressible/hostile payload — refuse it.
    if (gz.length > 2 * 1024 * 1024) {
      res.status(413).json({ error: 'too_large' });
      return;
    }

    let code = '';
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = randomCode();
      if (await storeTempReplay({
        code: candidate,
        dataGz: gz,
        rawBytes: bytes.length,
        mapId: summary.mapId,
        won: summary.won,
        durationMs: summary.durationMs,
        runner: summary.runner,
        statsJson: JSON.stringify(summary.stats),
        now,
        userId: id ?? '', // ties the upload to the account for "My replays" (guests stay anonymous)
        mode,
      })) {
        code = candidate;
        break;
      }
    }
    if (!code) {
      res.status(500).json({ error: 'server_error' });
      return;
    }
    res.json({ ok: true, code, url: `/replay/${code}` });
  },
);

// "My replays": the uploading account's still-active temporary replays (no
// blobs — just the summary cards). Session-only: guests upload anonymously and
// can't claim a list; a read-only API token has no account.
tempReplaysRouter.get('/replays/mine', async (req: Request, res: Response) => {
  const id = accountId(req);
  if (!id) {
    res.status(401).json({ error: 'login_required' });
    return;
  }
  const rows = await listTempReplaysForUser(id);
  const replays = rows.map((r: MyReplayRow) => {
    let stats = { runner: { kills: 0, deaths: 0, headshots: 0, shots: 0 } };
    try {
      stats = JSON.parse(r.statsJson) as typeof stats;
    } catch {
      /* malformed summary → zeros */
    }
    return {
      code: r.code,
      mapId: r.mapId,
      mode: r.mode,
      won: r.won,
      durationMs: r.durationMs,
      runner: r.runner,
      createdAt: r.createdAt,
      expiresAt: r.expiresAt,
      kills: stats.runner.kills,
      deaths: stats.runner.deaths,
      headshots: stats.runner.headshots,
      url: `/replay/${r.code}`,
    };
  });
  res.json({ replays });
});

// Remove one of YOUR temporary replays (owner-only). 404 when the code isn't
// yours (or is already gone/expired).
tempReplaysRouter.delete('/replays/:code', async (req: Request, res: Response) => {
  const id = accountId(req);
  if (!id) {
    res.status(401).json({ error: 'login_required' });
    return;
  }
  const code = String(req.params.code ?? '');
  if (!code) {
    res.status(400).json({ error: 'bad_code' });
    return;
  }
  if (!(await deleteTempReplayForUser(code, id))) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  res.json({ ok: true, code });
});

// Owner-only source download for the replay editor. Public share links remain
// read-only; this route prevents one account from editing another's recording.
tempReplaysRouter.get('/replays/:code/edit-source', async (req: Request, res: Response) => {
  const id = accountId(req);
  if (!id) {
    res.status(401).json({ error: 'login_required' });
    return;
  }
  const code = String(req.params.code ?? '');
  const source = await getTempReplayBlobForUser(code, id);
  if (!source) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Encoding', 'gzip');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Elyxion-Mode', source.mode);
  res.send(source.data);
});

// Share-link metadata (header info for the recap page — no blob download).
tempReplaysRouter.get('/replays/:code/meta', async (req: Request, res: Response) => {
  const code = String(req.params.code ?? '');
  if (!code) {
    res.status(400).json({ error: 'bad_code' });
    return;
  }
  const meta = await getTempReplayMeta(code);
  if (!meta) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  res.json({ meta });
});

// The recording itself, raw replay-codec bytes (served gzip-encoded — the
// browser inflates transparently, and the client codec works on the inflated
// bytes either way).
tempReplaysRouter.get('/replays/:code', async (req: Request, res: Response) => {
  const code = String(req.params.code ?? '');
  const gz = await getTempReplayBlob(code);
  if (!gz) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Encoding', 'gzip');
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.send(gz);
});