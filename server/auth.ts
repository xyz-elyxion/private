// Account auth: guest-by-default, optional username/password account (Krunker
// model). Progression keys off the account id — guests save nothing. Passwords
// are scrypt-hashed (Node built-in, no dependency) with a per-user salt and
// compared in constant time. The session is an opaque httpOnly cookie token.
// All db.ts calls are awaited (the store is PostgreSQL-backed now).

import { Router, type Request, type Response } from 'express';
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import {
  createSession,
  createUser,
  deleteSession,
  findUserById,
  findUserByName,
  logEvent,
  setAdmin,
  userIdFromSession,
} from './db';
import { containsProfanity, isReservedName } from './profanity';

// Usernames designated as admins via the ADMIN_USERNAMES env var (comma- or
// space-separated, case-insensitive). Used to auto-promote on registration and,
// on boot, to sync existing accounts (see syncAdminsFromEnv in server/app.ts).
export function adminUsernamesFromEnv(): string[] {
  return (process.env.ADMIN_USERNAMES ?? '')
    .split(/[,\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

const SESSION_COOKIE = 'igsession';
// Anonymous guest identity cookie. Logged-in players are identified by their
// account (igsession); everyone else carries a persistent random UUID here, so
// a guest has ONE stable identity across sessions/reconnects — the handle
// moderation (kick/ban by uuid), connect-time guest-ban enforcement, and guest-
// authored content (community / feedback / support) all key off it. httpOnly
// like the session cookie; clearing cookies = a fresh identity.
export const GUEST_COOKIE = 'igpid';
const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;
const SESSION_MAX_AGE = 1000 * 60 * 60 * 24 * 365; // 1 year

const cookieOpts = {
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: process.env.NODE_ENV === 'production',
  maxAge: SESSION_MAX_AGE,
  path: '/',
};

function hashPw(password: string, salt: string): Buffer {
  return scryptSync(password, salt, 64);
}
function genId(): string {
  return randomBytes(12).toString('hex');
}
function genToken(): string {
  return randomBytes(32).toString('base64url');
}

// A fresh guest identity (RFC 4122 v4 UUID). Minted lazily: on the first HTTP
// response that needs an identity for a guest, and on the WS upgrade handshake
// (app.ts) so a guest who jumps straight into a match still has one.
export function mintGuestId(): string {
  return randomUUID();
}

// Value of one named cookie inside a raw `Cookie:` header ('' = absent) — the
// WS upgrade path doesn't go through Express's cookie parser.
function cookieFromHeader(header: string | undefined, name: string): string {
  if (!header) return '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) {
      return decodeURIComponent(part.slice(i + 1).trim());
    }
  }
  return '';
}

// The account id behind a request's session cookie ('' = guest). This IS the
// progression identity used by the stats API. Synchronous: reads the write-
// through session cache maintained by db.ts (see userIdFromSession there).
export function accountId(req: Request): string {
  const token = req.cookies?.[SESSION_COOKIE];
  return typeof token === 'string' ? userIdFromSession(token) : '';
}

// Same, but from a raw `Cookie:` header — for the game WebSocket upgrade, which
// doesn't go through Express's cookie parser.
export function accountIdFromCookieHeader(header: string | undefined): string {
  const token = cookieFromHeader(header, SESSION_COOKIE);
  return token ? userIdFromSession(token) : '';
}

// The guest identity (igpid) behind a request — '' when absent.
export function guestId(req: Request): string {
  const v = req.cookies?.[GUEST_COOKIE];
  return typeof v === 'string' ? v.trim().toLowerCase() : '';
}

// Same, from a raw `Cookie:` header — for the game WebSocket upgrade. Lowercased
// so guest ids compare case-insensitively against the ban store (randomUUID
// emits lowercase, but cookies round-trip whatever a client echoes back).
export function guestIdFromCookieHeader(header: string | undefined): string {
  return cookieFromHeader(header, GUEST_COOKIE).trim().toLowerCase();
}

// The guest identity for a request, minting + setting the cookie on first use.
// Returns '' for a logged-in caller (the account IS the identity — a guest uuid
// is meaningless behind one) or when no response is available to set a cookie
// on (pass res only where a cookie can actually be delivered).
export function ensureGuestId(req: Request, res: Response): string {
  if (accountId(req)) return '';
  const existing = guestId(req);
  if (existing) return existing;
  const uuid = mintGuestId();
  res.cookie(GUEST_COOKIE, uuid, cookieOpts);
  return uuid;
}

// A ready-to-push Set-Cookie line for the guest identity, for the WS upgrade
// handshake (which doesn't go through res.cookie). Mirrors cookieOpts exactly.
export function guestSetCookieHeader(uuid: string): string {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${GUEST_COOKIE}=${uuid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE / 1000}${secure}`;
}

// Lightweight per-IP attempt limiter so register/login can't be brute-forced.
const attempts = new Map<string, { n: number; resetAt: number }>();
const ATTEMPT_WINDOW = 60_000;
const ATTEMPT_MAX = 12;
function rateLimited(ip: string, now: number): boolean {
  const a = attempts.get(ip);
  if (!a || now > a.resetAt) {
    attempts.set(ip, { n: 1, resetAt: now + ATTEMPT_WINDOW });
    return false;
  }
  a.n += 1;
  return a.n > ATTEMPT_MAX;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, a] of attempts) if (now > a.resetAt) attempts.delete(ip);
}, ATTEMPT_WINDOW).unref?.();

export const authRouter = Router();

// Who am I? → the account behind the session, or null (guest). A guest also
// gets their anonymous igpid minted here (first /me sets the cookie), so the
// very first page the game client or any page opens seeds the guest identity
// that the WS + content routes then key off.
authRouter.get('/auth/me', async (req, res) => {
  const id = accountId(req);
  const user = id ? await findUserById(id) : undefined;
  if (!user) ensureGuestId(req, res);
  res.json({
    user: user
      ? { username: user.username, isAdmin: user.isAdmin, isVerified: user.isVerified }
      : null,
  });
});

authRouter.post('/auth/register', async (req, res) => {
  if (rateLimited(req.ip ?? 'unknown', Date.now())) {
    res.status(429).json({ error: 'rate_limited' });
    return;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const username = typeof body.username === 'string' ? body.username.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const email =
    typeof body.email === 'string' && body.email.trim() ? body.email.trim().slice(0, 200) : null;
  if (!USERNAME_RE.test(username)) {
    res.status(400).json({ error: 'bad_username' });
    return;
  }
  // Block slurs/profanity (this is the only place a name is human-chosen — see
  // server/profanity.ts) and names reserved for staff / the guest slot.
  if (isReservedName(username)) {
    res.status(400).json({ error: 'reserved' });
    return;
  }
  if (containsProfanity(username)) {
    res.status(400).json({ error: 'profane' });
    return;
  }
  if (password.length < 6 || password.length > 200) {
    res.status(400).json({ error: 'bad_password' });
    return;
  }
  const lower = username.toLowerCase();
  if (await findUserByName(lower)) {
    res.status(409).json({ error: 'taken' });
    return;
  }
  const salt = randomBytes(16).toString('hex');
  const id = genId();
  await createUser({
    id,
    username,
    usernameLower: lower,
    pwHash: hashPw(password, salt).toString('hex'),
    pwSalt: salt,
    email,
    createdAt: Date.now(),
  });
  // Auto-promote if this username is configured as an admin (lets you claim your
  // account right after deploy: register the name in ADMIN_USERNAMES → admin).
  const isAdmin = adminUsernamesFromEnv().includes(lower);
  if (isAdmin) await setAdmin(id, true);
  const token = genToken();
  await createSession(token, id, Date.now());
  res.cookie(SESSION_COOKIE, token, cookieOpts);
  logEvent({ event: 'register', actorId: id, actorName: username, ip: req.ip, detail: isAdmin ? { admin: true } : undefined });
  res.json({ user: { username, isAdmin, isVerified: false } });
});

authRouter.post('/auth/login', async (req, res) => {
  if (rateLimited(req.ip ?? 'unknown', Date.now())) {
    res.status(429).json({ error: 'rate_limited' });
    return;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const username = typeof body.username === 'string' ? body.username.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const user = await findUserByName(username.toLowerCase());
  // Always run the hash even on unknown users so timing doesn't leak existence.
  const salt = user?.pw_salt ?? 'x';
  const calc = hashPw(password, salt);
  const stored = user ? Buffer.from(user.pw_hash, 'hex') : Buffer.alloc(calc.length);
  const ok = !!user && calc.length === stored.length && timingSafeEqual(calc, stored);
  if (!ok) {
    res.status(401).json({ error: 'invalid' });
    return;
  }
  const token = genToken();
  await createSession(token, user!.id, Date.now());
  res.cookie(SESSION_COOKIE, token, cookieOpts);
  const acct = await findUserById(user!.id);
  logEvent({ event: 'login', actorId: user!.id, actorName: user!.username, ip: req.ip });
  res.json({
    user: { username: user!.username, isAdmin: !!acct?.isAdmin, isVerified: !!acct?.isVerified },
  });
});

authRouter.post('/auth/logout', async (req, res) => {
  const token = req.cookies?.[SESSION_COOKIE];
  if (typeof token === 'string') await deleteSession(token);
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.json({ ok: true });
});
