// Public announcements feed: the active site-wide notices admins post from the
// admin dashboard (server/admin.ts owns the mutations). Served to the landing
// page on load; rows are filtered server-side (non-deleted, not expired), so a
// tampered client can never surface a removed/lapsed announcement.

import { Router } from 'express';
import { listActiveAnnouncements } from './db';

export const announcementsRouter = Router();

// Active announcements, newest first. No-store: it's a tiny document and admins
// expect an edit to be live on the next page load (no stale-cache surprises).
announcementsRouter.get('/announcements', async (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ announcements: await listActiveAnnouncements() });
});