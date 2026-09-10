// CrazyGames account linking (server-side).
//
// The client fetches a short-lived JWT from the CrazyGames SDK
// (`SDK.user.getUserToken()`) and POSTs it here. We verify the token against
// CrazyGames' public key (fetched fresh per verification, as their docs
// recommend, since the key can rotate) and only then store the platform's
// `userId` on the local account row. No payment data ever touches the client;
// if CrazyGames/Xsolla purchases are enabled later, purchases are validated
// server-to-server the same way.
//
// Token payload (per https://docs.crazygames.com/sdk/user/):
//   { userId, gameId, username, profilePictureUrl, iat, exp }

import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import { accountId, startSession } from './auth';
import {
  linkCrazyGamesAccount,
  findUserById,
  findUserByCrazyGamesId,
  createUser,
  findUserByName,
} from './db';
import { containsProfanity, isReservedName } from './profanity';
import { logEvent } from './db';

const CG_PUBLIC_KEY_URL = 'https://sdk.crazygames.com/publicKey.json';

type CgTokenPayload = {
  userId: string;
  gameId: string;
  username: string;
  profilePictureUrl?: string;
  iat: number;
  exp: number;
};

// Minimal RS256 JWT verifier on Node's webcrypto — no new dependency. The
// token is ~1KB, verification runs once per login, so perf is irrelevant.
async function verifyCgToken(token: string): Promise<CgTokenPayload> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('malformed');
  const [h64, p64, s64] = parts;
  const b64url = (s: string) => Buffer.from(s, 'base64url');

  const header = JSON.parse(b64url(h64).toString('utf8')) as { alg?: string; typ?: string };
  if (header.alg !== 'RS256') throw new Error('alg');

  const payload = JSON.parse(b64url(p64).toString('utf8')) as CgTokenPayload;
  if (typeof payload.exp === 'number' && payload.exp * 1000 < Date.now()) throw new Error('expired');
  if (!payload.userId) throw new Error('payload');

  // Fetch the public key fresh each time (docs recommend this; the key can
  // rotate). Fail closed if CrazyGames is unreachable.
  const keyRes = await fetch(CG_PUBLIC_KEY_URL, { signal: AbortSignal.timeout(5_000) });
  if (!keyRes.ok) throw new Error('key_fetch');
  const { publicKey } = (await keyRes.json()) as { publicKey: string };
  if (!publicKey) throw new Error('key_missing');

  const key = await crypto.subtle.importKey(
    'spki',
    pemToSpki(publicKey),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const data = new Uint8Array(Buffer.from(`${h64}.${p64}`));
  const sig = new Uint8Array(b64url(s64));
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sig, data);
  if (!ok) throw new Error('signature');
  return payload;
}

// Sanitize a CrazyGames username into a legal local username: keep the 3–20
// chars the account system allows, strip everything that isn't [a-zA-Z0-9_].
// Returns '' when nothing usable survives.
function sanitizedCgUsername(raw: string): string {
  const cleaned = (raw ?? '').replace(/[^a-zA-Z0-9_]/g, '').slice(0, 20);
  return cleaned.length >= 3 ? cleaned : '';
}

// Create (or reuse) the local account for a verified CrazyGames identity and
// issue a session for it — CrazyGames automatic login (docs: "Automatically
// login: ... create accounts for players automatically"). Deterministic per
// platform userId:
//  • already linked      → that account (cross-device progress restore)
//  • name free           → new account named after the CG username
//  • name taken          → new account "<name>_<userId suffix>"
// The auto-generated account has no password; players can claim it later via
// password recovery on their CrazyGames profile page email or support.
function ensureCgAccount(payload: CgTokenPayload, ip?: string): { user: ReturnType<typeof findUserById>; created: boolean } | null {
  const cgName = sanitizedCgUsername(payload.username);
  const existing = findUserByCrazyGamesId(payload.userId);
  if (existing) return { user: existing, created: false };

  const pickBase = cgName || `CG_${payload.userId.slice(-6)}`;
  let name = pickBase;
  let lower = name.toLowerCase();
  if (findUserByName(lower)) {
    // Name taken: add a short platform-id suffix (collision-free in practice).
    name = `${pickBase}_${payload.userId.slice(-4)}`.slice(0, 20);
    lower = name.toLowerCase();
  }
  if (isReservedName(name) || containsProfanity(name) || findUserByName(lower)) {
    // Reserved (guest*) / profane / still colliding: fall back to a purely
    // platform-derived name. Fail closed if even that is somehow taken.
    name = `CG_${payload.userId.slice(-8)}`;
    lower = name.toLowerCase();
    if (findUserByName(lower) || isReservedName(name) || containsProfanity(name)) return null;
  }

  const id = randomBytes(12).toString('hex');
  createUser({
    id,
    username: name,
    usernameLower: lower,
    // No password: this account can only ever be entered through the verified
    // CrazyGames token (or the recovery flow), never a guessed password.
    pwHash: '',
    pwSalt: '',
    email: null,
    createdAt: Date.now(),
  });
  linkCrazyGamesAccount(id, payload.userId);
  logEvent({
    event: 'register',
    actorId: id,
    actorName: name,
    ip,
    detail: { crazygames: true, cgUserId: payload.userId },
  });
  return { user: findUserById(id), created: true };
}

function pemToSpki(pem: string): Uint8Array {
  const body = pem
    .replace(/-----BEGIN PUBLIC KEY-----/, '')
    .replace(/-----END PUBLIC KEY-----/, '')
    .replace(/\s+/g, '');
  return new Uint8Array(Buffer.from(body, 'base64'));
}

export const crazyGamesRouter = Router();

// POST /api/auth/crazygames { token } — verify + link the CrazyGames account
// to the local account. Works for guests too: the platform identity is
// recorded on whatever account (or new session) the browser carries.
crazyGamesRouter.post('/auth/crazygames', async (req, res) => {
  const token = typeof req.body?.token === 'string' ? req.body.token : '';
  if (!token) {
    res.status(400).json({ error: 'bad_token' });
    return;
  }
  try {
    const payload = await verifyCgToken(token);
    const id = accountId(req);
    const user = id ? findUserById(id) : undefined;

    if (!id || !user) {
      // No local session: CrazyGames automatic login — create the local
      // account for this verified platform identity (or restore the one it is
      // already linked to) and issue a session cookie for it. The SDK token
      // was just verified against CrazyGames' public key, so this is as
      // trustworthy as the platform's own login.
      const ensured = ensureCgAccount(payload, req.ip);
      if (!ensured?.user) {
        res.status(409).json({ error: 'no_local_account', cgUser: { username: payload.username } });
        return;
      }
      startSession(res, ensured.user.id); // mints + stores the session cookie
      res.json({
        ok: true,
        created: ensured.created,
        sessionIssued: true, // client must re-pull /me + reconnect sockets
        cgUser: { userId: payload.userId, username: payload.username },
        user: {
          username: ensured.user.username,
          isAdmin: ensured.user.isAdmin,
          isVerified: ensured.user.isVerified,
        },
      });
      return;
    }

    // Session exists. If it is a different local account already linked to
    // this CrazyGames identity, prefer the linked account (progress lives
    // there) and re-issue its session — never silently rebind platform ids.
    const linked = findUserByCrazyGamesId(payload.userId);
    if (linked && linked.id !== id) {
      startSession(res, linked.id);
      res.json({
        ok: true,
        sessionIssued: true, // the browser session switched accounts
        cgUser: { userId: payload.userId, username: payload.username },
        user: { username: linked.username, isAdmin: linked.isAdmin, isVerified: linked.isVerified },
      });
      return;
    }
    // Normal case: link the platform identity onto the current account.
    linkCrazyGamesAccount(id, payload.userId);
    res.json({ ok: true, cgUser: { userId: payload.userId, username: payload.username } });
  } catch (e) {
    const code = (e as Error)?.message ?? 'error';
    res.status(401).json({ error: 'invalid_token', detail: code });
  }
});
