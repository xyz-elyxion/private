// Account auth: guest-by-default, optional username/password account (Krunker
// model). Progression keys off the account id — guests save nothing. Passwords
// are scrypt-hashed (Node built-in, no dependency) with a per-user salt and
// compared in constant time. The session is an opaque httpOnly cookie token.

import { Router, type Request, type Response } from 'express';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
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
// on boot, to sync existing accounts (see syncAdminsFromEnv in server/index.ts).
export function adminUsernamesFromEnv(): string[] {
  return (process.env.ADMIN_USERNAMES ?? '')
    .split(/[,\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

const SESSION_COOKIE = 'igsession';
const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;
const SESSION_MAX_AGE = 1000 * 60 * 60 * 24 * 365; // 1 year

// CRAZYGAMES: when the API is called cross-origin (bundle hosted on the embed
// origin, backend here), a SameSite=Lax cookie is dropped on those requests.
// Setting CG_API_ORIGINS opts into SameSite=None (Secure is mandatory then) so
// the session rides along; same-origin deploys keep the tighter default.
const crossOriginCookies = (process.env.CG_API_ORIGINS ?? '')
  .split(',')
  .some((o) => /^https:\/\//i.test(o.trim()));
const cookieOpts = {
  httpOnly: true,
  sameSite: (crossOriginCookies ? 'none' : 'lax') as 'none' | 'lax',
  secure: process.env.NODE_ENV === 'production' || crossOriginCookies,
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

// The account id behind a request's session cookie ('' = guest). This IS the
// progression identity used by the stats API.
//
// TWO auth paths, in priority order:
//   1. The httpOnly `igsession` cookie (same-origin site; or portals that allow
//      third-party cookies via SameSite=None).
//   2. The `X-Session-Token` header (or `?sess=` query param, for EventSource /
//      contexts without header access) — the PORTAL FALLBACK. Browsers that
//      partition third-party cookies never deliver the cookie cross-origin, so
//      when a portal-embedded bundle calls cross-origin the client sends the
//      token it received from register/login/CG-link responses instead.
//      Header/query tokens are only honored on cross-origin requests (an
//      embedded-bundle signal); same-origin traffic is cookie-authenticated,
//      which keeps the token out of URLs/logs for the normal case.
export function accountId(req: Request): string {
  const cookieToken = req.cookies?.[SESSION_COOKIE];
  if (typeof cookieToken === 'string' && cookieToken) return userIdFromSession(cookieToken);
  const headerToken = req.get('x-session-token');
  if (headerToken) {
    const isCrossOrigin = (() => {
      const origin = req.get('origin');
      if (origin) {
        try {
          return new URL(origin).host !== req.hostname;
        } catch {
          return false;
        }
      }
      // No Origin header (curl, native webviews): require Sec-Fetch-Site to be
      // explicitly cross-site before trusting a URL/header token.
      return req.get('sec-fetch-site') === 'cross-site';
    })();
    if (isCrossOrigin) return userIdFromSession(headerToken);
  }
  return '';
}

// Issue a fresh authenticated browser session after a successful recovery-code
// redemption. The cookie remains httpOnly and uses the same production options
// as normal registration/login sessions.
export function startSession(res: Response, userId: string, now: number = Date.now()): void {
  const token = genToken();
  createSession(token, userId, now);
  res.cookie(SESSION_COOKIE, token, cookieOpts);
}

// Same, but from a raw `Cookie:` header — for the game WebSocket upgrade, which
// doesn't go through Express's cookie parser.
export function accountIdFromCookieHeader(header: string | undefined): string {
  if (!header) return '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === SESSION_COOKIE) {
      return userIdFromSession(decodeURIComponent(part.slice(i + 1).trim()));
    }
  }
  return '';
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

// Who am I? → the account behind the session (cookie or header fallback), or
// null (guest). The identity ALWAYS goes through accountId(), which enforces
// the cross-origin gate for header tokens. The echoed `token` lets a
// portal-embedded client store the credential for later X-Session-Token use —
// but only when it actually authenticated; an unvalidated header token is
// never echoed back.
authRouter.get('/auth/me', (req, res) => {
  const id = accountId(req);
  const user = id ? findUserById(id) : undefined;
  const cookieToken = req.cookies?.[SESSION_COOKIE];
  const headerToken = req.get('x-session-token');
  const token = id ? (cookieToken || headerToken || null) : null;
  res.json({
    token,
    user: user
      ? { username: user.username, isAdmin: user.isAdmin, isVerified: user.isVerified }
      : null,
  });
});

authRouter.post('/auth/register', (req, res) => {
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
  if (findUserByName(lower)) {
    res.status(409).json({ error: 'taken' });
    return;
  }
  const salt = randomBytes(16).toString('hex');
  const id = genId();
  createUser({
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
  if (isAdmin) setAdmin(id, true);
  const token = genToken();
  createSession(token, id, Date.now());
  res.cookie(SESSION_COOKIE, token, cookieOpts);
  logEvent({ event: 'register', actorId: id, actorName: username, ip: req.ip, detail: isAdmin ? { admin: true } : undefined });
  // `token` powers the X-Session-Token header fallback for cookie-blocked
  // cross-origin portal embeds (see accountId). Same value as the cookie;
  // it is NOT a password substitute and dies with the session.
  res.json({ token, user: { username, isAdmin, isVerified: false } });
});

authRouter.post('/auth/login', (req, res) => {
  if (rateLimited(req.ip ?? 'unknown', Date.now())) {
    res.status(429).json({ error: 'rate_limited' });
    return;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const username = typeof body.username === 'string' ? body.username.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const user = findUserByName(username.toLowerCase());
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
  createSession(token, user!.id, Date.now());
  res.cookie(SESSION_COOKIE, token, cookieOpts);
  const acct = findUserById(user!.id);
  logEvent({ event: 'login', actorId: user!.id, actorName: user!.username, ip: req.ip });
  res.json({
    token, // header-fallback for cookie-blocked cross-origin embeds
    user: { username: user!.username, isAdmin: !!acct?.isAdmin, isVerified: !!acct?.isVerified },
  });
});

authRouter.post('/auth/logout', (req, res) => {
  // Kill whichever credential presented: cookie token or header fallback.
  const cookieToken = req.cookies?.[SESSION_COOKIE];
  const headerToken = req.get('x-session-token');
  if (typeof cookieToken === 'string' && cookieToken) deleteSession(cookieToken);
  if (headerToken) deleteSession(headerToken);
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.json({ ok: true });
});
