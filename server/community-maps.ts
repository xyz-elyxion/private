// Community map API: save / list / fetch / delete player-built maps.
// The map document itself is validated by the shared validator in
// src/game/community-map.ts (also used by the game server to resolve map ids),
// so anything persisted here is guaranteed playable. Saving requires a login;
// reading is public so the client can render any map by id. DELETE is
// author-only. Saves are rate-limited to blunt spam (same pattern as feedback).
import { Router, type Request } from 'express';
import { accountId } from './auth';
import { findUserById, logEvent } from './db';
import {
  deleteCommunityMap,
  getCommunityMap,
  listCommunityMaps,
  saveCommunityMap,
} from './db';
import {
  COMMUNITY_MAP_VERSION,
  parseCommunityMap,
  serializeCommunityMap,
  validateCommunityMap,
} from '../src/game/community-map';

export const communityMapsRouter = Router();

// ── Save rate limiter (mirrors server/feedback.ts) ──────────────────────────
const RATE_WINDOW_MS = 10 * 60_000;
const RATE_MAX_SAVES = 12;
const saveHits = new Map<string, number[]>();

function allowSave(identity: string, now: number): boolean {
  const cutoff = now - RATE_WINDOW_MS;
  const recent = (saveHits.get(identity) ?? []).filter((ts) => ts > cutoff);
  if (recent.length >= RATE_MAX_SAVES) {
    saveHits.set(identity, recent);
    return false;
  }
  recent.push(now);
  saveHits.set(identity, recent);
  return true;
}

const saveSweep = setInterval(() => {
  const cutoff = Date.now() - RATE_WINDOW_MS;
  for (const [id, hits] of saveHits) {
    if (hits.length === 0 || hits[hits.length - 1] <= cutoff) saveHits.delete(id);
  }
}, RATE_WINDOW_MS);
saveSweep.unref?.();

// Map size caps (mirror the validator's floor; documented on the editor page).
const MAX_MAPS_PER_ACCOUNT = 25;
const MAX_NAME_LEN = 48;

function str(req: Request, key: string): string {
  const v = (req.body as Record<string, unknown> | undefined)?.[key];
  return typeof v === 'string' ? v.trim() : '';
}

// GET /api/community-maps — browse published maps (most recently updated first).
communityMapsRouter.get('/community-maps', (_req, res) => {
  const rows = listCommunityMaps(100);
  res.json({
    maps: rows.map((r) => ({
      id: r.id,
      name: r.name,
      author: r.authorName,
      plays: r.plays,
      updatedAt: r.updatedAt,
    })),
  });
});

// GET /api/community-maps/:id — full document (public; the client needs it to render).
communityMapsRouter.get('/community-maps/:id', (req, res) => {
  const row = getCommunityMap(String(req.params.id));
  if (!row) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  res.json({ map: row.doc, plays: row.plays });
});

// POST /api/community-maps — create or update (login required, author-gated).
communityMapsRouter.post('/community-maps', (req, res) => {
  const now = Date.now();
  const id = accountId(req);
  if (!id) {
    res.status(401).json({ error: 'login_required' });
    return;
  }
  if (!allowSave(id, now)) {
    res.status(429).json({ error: 'rate_limited' });
    return;
  }

  let docRaw: unknown;
  try {
    docRaw = typeof req.body?.doc === 'string' ? JSON.parse(req.body.doc) : req.body?.doc;
  } catch {
    res.status(400).json({ error: 'bad_json' });
    return;
  }
  if (!validateCommunityMap(docRaw)) {
    res.status(400).json({ error: 'bad_map' });
    return;
  }
  const doc = docRaw as { id: string; name: string };
  if (doc.id !== str(req, 'id')) {
    res.status(400).json({ error: 'id_mismatch' });
    return;
  }

  // Update ownership: only the original author may overwrite an existing id.
  const existing = getCommunityMap(doc.id);
  if (existing && existing.authorId !== id) {
    res.status(403).json({ error: 'not_author' });
    return;
  }

  const account = findUserById(id);
  const authorName = account?.username ?? 'Player';

  saveCommunityMap({
    id: doc.id,
    name: doc.name.slice(0, MAX_NAME_LEN),
    authorId: id,
    authorName,
    doc: serializeCommunityMap(docRaw as Parameters<typeof serializeCommunityMap>[0]),
    now,
  });

  logEvent({
    event: existing ? 'community-map.updated' : 'community-map.created',
    actorId: id,
    actorName: authorName,
    targetId: doc.id,
    detail: { name: doc.name, boxes: (docRaw as { boxes?: unknown[] }).boxes?.length ?? 0 },
    ip: req.ip,
    now,
  });

  res.json({ ok: true, id: doc.id });
});

// DELETE /api/community-maps/:id — author only.
communityMapsRouter.delete('/community-maps/:id', (req, res) => {
  const id = accountId(req);
  if (!id) {
    res.status(401).json({ error: 'login_required' });
    return;
  }
  const mapId = String(req.params.id);
  if (!deleteCommunityMap(mapId, id)) {
    res.status(404).json({ error: 'not_found_or_not_author' });
    return;
  }
  logEvent({
    event: 'community-map.deleted',
    actorId: id,
    targetId: mapId,
    ip: req.ip,
    now: Date.now(),
  });
  res.json({ ok: true });
});

// Parse helper exported for tests; kept out of the request path above (the
// router uses the validator directly so malformed docs never touch storage).
export { parseCommunityMap, COMMUNITY_MAP_VERSION };
