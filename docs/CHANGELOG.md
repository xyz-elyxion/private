# Changelog

All notable changes to Elyxion, newest first. Unreleased work lives at the top.

## 2026-09-13

### Backend & infrastructure

- **PostgreSQL backend for the entire data layer.** Set `DATABASE_URL`
  (or `POSTGRES_URL` / `POSTGRESQL_URL`) to a `postgres://` URL and every
  table — accounts, sessions, stats, XP/levels/credits, cosmetics, challenges,
  ranked Elo, seasons, friends, feedback, audit logs — is stored in PostgreSQL
  instead of the embedded SQLite file. The schema bootstraps itself on first
  boot; SQLite remains the zero-config default.
- **IPv4-forced database connectivity.** Managed Postgres hosts (Render,
  Supabase…) advertise AAAA records that container hosts can't route
  (`ENETUNREACH` on connect). The server resolves the database hostname to
  IPv4 at startup and connects by address, keeping TLS/SNI on the original
  hostname. Supabase note: use the **session pooler** URL
  (`aws-0-<region>.pooler.supabase.com:5432`, username `postgres.<ref>`) —
  the direct `db.<ref>.supabase.co` host is IPv6-only.
- Verified end-to-end against a real PostgreSQL (schema bootstrap, accounts,
  stats, challenges, ranked, seasons, audit, admin metrics) plus a SQLite
  regression: `npm run smoke:pg`.

### Distribution & portals

- **Admin portal distribution ZIP.** Admins can download a ready-to-upload
  build bundle for other gaming portals; the shell `index.html` is stamped
  with the backend origin in-memory so cross-origin portal embeds still reach
  the API and game socket.
- Portal-session fallback hardened: `X-Session-Token` / `?sess=` auth for
  cookie-partitioned embeds, refused on same-origin traffic.

### Accounts & platform

- **CrazyGames SDK v3 integration**: gameplay-start events, ad breaks with
  correct pause/resume, account linking (username + avatar), automatic login
  for CrazyGames users, and graceful no-op behavior off-platform. The game
  stays fully playable outside CrazyGames.
- **Terms of Service & Privacy Policy** (PEGI 12 aligned), shown at signup /
  login with a first-visit consent gate; full pages at `/legal/terms` and
  `/legal/privacy`.

### Admin

- Redesigned admin dashboard with a collapsible grouped sidebar
  (search, workspace switcher, sectioned nav, keyboard shortcuts).

### Docs

- `DATABASE_URL` / PostgreSQL backend documented in the README and
  `docs/DEPLOYMENT.md`.
